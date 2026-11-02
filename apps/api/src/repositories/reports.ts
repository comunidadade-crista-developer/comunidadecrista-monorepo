import { and, eq, sql } from 'drizzle-orm';
import type { ReportCategory, ReportSeverity } from '@comunidade/shared';
import { CATEGORY_TO_SEVERITY } from '@comunidade/shared';
import type { Executor } from '../db/client.js';
import type { Report } from '../db/schema.js';
import { moderationLog, posts, reports, users } from '../db/schema.js';

export const DEFAULT_THRESHOLDS: Record<ReportSeverity, number> = {
  basic: 10,
  medium: 5,
  high: 2,
};

/** @deprecated usar DEFAULT_THRESHOLDS.basic */
export const REPORT_THRESHOLD = DEFAULT_THRESHOLDS.basic;
export const REPORTER_MIN_AGE_DAYS = 7;

export interface FileReportArgs {
  postId: string;
  reporterId: string;
  category: ReportCategory;
  reason?: string;
}

export interface FileReportRules {
  thresholds?: Partial<Record<ReportSeverity, number>>;
}

export type FileReportOutcome =
  | {
      outcome: 'created';
      report: Report;
      reportsCount: number;
      validReports: number;
      validReportsBySeverity: Record<ReportSeverity, number>;
      escalated: boolean;
    }
  | { outcome: 'duplicate' }
  | { outcome: 'own_post' }
  | { outcome: 'post_not_found' };

export function reportsRepo(db: Executor) {
  return {
    async file(
      args: FileReportArgs,
      rules: FileReportRules = {},
      tx?: Executor,
    ): Promise<FileReportOutcome> {
      const exec = tx ?? db;
      const thresholds = { ...DEFAULT_THRESHOLDS, ...(rules.thresholds ?? {}) };
      const severity = CATEGORY_TO_SEVERITY[args.category];

      return exec.transaction(async (t) => {
        // 1) Post existe e está publicado?
        const [post] = await t
          .select({ id: posts.id, authorId: posts.authorId, status: posts.status, reportsCount: posts.reportsCount })
          .from(posts)
          .where(eq(posts.id, args.postId))
          .for('update')
          .limit(1);

        if (!post || post.status !== 'published') return { outcome: 'post_not_found' as const };
        if (post.authorId === args.reporterId) return { outcome: 'own_post' as const };

        // 2) Insert (unique (post, reporter) previne duplicado)
        const inserted = await t
          .insert(reports)
          .values({
            postId: args.postId,
            reporterId: args.reporterId,
            category: args.category,
            severity,
            reason: args.reason ?? null,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted.length === 0) {
          // Já existe (aberta ou já resolvida) → duplicate, sem alterar contadores.
          return { outcome: 'duplicate' as const };
        }

        const report = inserted[0]!;

        // 3) Incrementa reports_count (total) no post
        const [updatedPost] = await t
          .update(posts)
          .set({ reportsCount: sql`${posts.reportsCount} + 1` })
          .where(eq(posts.id, args.postId))
          .returning({ reportsCount: posts.reportsCount });

        const reportsCount = updatedPost?.reportsCount ?? post.reportsCount + 1;

        // 4) Conta reportes válidos por severidade
        const validRows = await t
          .select({
            severity: reports.severity,
            count: sql<number>`count(*)::int`,
          })
          .from(reports)
          .innerJoin(users, eq(reports.reporterId, users.id))
          .where(
            and(
              eq(reports.postId, args.postId),
              eq(reports.status, 'open'),
              sql`${users.createdAt} <= now() - interval '${sql.raw(String(REPORTER_MIN_AGE_DAYS))} days'`,
              sql`EXISTS (SELECT 1 FROM posts p WHERE p.author_id = ${users.id})`,
            ),
          )
          .groupBy(reports.severity);

        const bySeverity: Record<ReportSeverity, number> = { basic: 0, medium: 0, high: 0 };
        for (const row of validRows) {
          bySeverity[row.severity as ReportSeverity] = row.count;
        }

        const validReports =
          bySeverity.basic + bySeverity.medium + bySeverity.high;

        // 5) Escalation check — só uma actualização para pending_review
        const willEscalate =
          bySeverity.basic >= thresholds.basic ||
          bySeverity.medium >= thresholds.medium ||
          bySeverity.high >= thresholds.high;

        let escalated = false;
        if (willEscalate && post.status === 'published') {
          await t
            .update(posts)
            .set({ status: 'pending_review' })
            .where(and(eq(posts.id, args.postId), eq(posts.status, 'published')));
          escalated = true;
        }

        return {
          outcome: 'created' as const,
          report,
          reportsCount,
          validReports,
          validReportsBySeverity: bySeverity,
          escalated,
        };
      });
    },

    async findOpenByPostAndReporter(
      postId: string,
      reporterId: string,
    ): Promise<Report | null> {
      const [row] = await db
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.postId, postId),
            eq(reports.reporterId, reporterId),
            eq(reports.status, 'open'),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async countOpenByPost(postId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(reports)
        .where(and(eq(reports.postId, postId), eq(reports.status, 'open')));
      return row?.count ?? 0;
    },

    async cancel(reportId: string, reporterId: string): Promise<boolean> {
      const result = await db.transaction(async (t) => {
        const [row] = await t
          .select({ id: reports.id, postId: reports.postId, status: reports.status })
          .from(reports)
          .where(and(eq(reports.id, reportId), eq(reports.reporterId, reporterId)))
          .for('update')
          .limit(1);

        if (!row || row.status !== 'open') return false;

        await t.delete(reports).where(eq(reports.id, reportId));
        await t
          .update(posts)
          .set({ reportsCount: sql`GREATEST(${posts.reportsCount} - 1, 0)` })
          .where(eq(posts.id, row.postId));
        return true;
      });
      return result;
    },

    async listByReporter(reporterId: string): Promise<Report[]> {
      return db
        .select()
        .from(reports)
        .where(eq(reports.reporterId, reporterId))
        .orderBy(reports.createdAt);
    },

    async resolveAllForPost(
      postId: string,
      status: 'resolved_kept' | 'resolved_removed',
      resolvedBy: string,
    ): Promise<void> {
      await db.transaction(async (t) => {
        await t
          .update(reports)
          .set({ status, resolvedAt: new Date(), resolvedBy })
          .where(and(eq(reports.postId, postId), eq(reports.status, 'open')));
        await t
          .update(posts)
          .set({ reportsCount: 0 })
          .where(eq(posts.id, postId));
      });
    },
  };
}

export function moderationLogRepo(db: Executor) {
  return {
    async create(data: typeof moderationLog.$inferInsert) {
      const [row] = await db.insert(moderationLog).values(data).returning();
      return row!;
    },

    async listByPost(postId: string) {
      return db
        .select()
        .from(moderationLog)
        .where(eq(moderationLog.postId, postId))
        .orderBy(moderationLog.createdAt);
    },

    async listRecent(limit = 100) {
      return db
        .select()
        .from(moderationLog)
        .orderBy(moderationLog.createdAt)
        .limit(limit);
    },
  };
}