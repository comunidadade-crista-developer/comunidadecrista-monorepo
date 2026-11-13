import { and, count, desc, eq, lte, sql } from "drizzle-orm";
import type { ReportCategory, ReportSeverity } from "@comunidade/shared";
import type { Database } from "../db/client.js";
import { moderationLog, posts, reports, users } from "../db/schema.js";
import type { ModerationLogEntry, NewReport, Report } from "../db/schema.js";

export const REPORT_THRESHOLDS: Readonly<Record<ReportSeverity, number>> = {
  basic: 10,
  medium: 5,
  high: 3,
};
export const REPORT_THRESHOLD = REPORT_THRESHOLDS.basic;
export const REPORTER_MIN_AGE_DAYS = 7;

const SEVERITIES_BY_GRAVITY: readonly ReportSeverity[] = [
  "high",
  "medium",
  "basic",
];

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface ReportRules {
  /** Limiares por gravidade (os que faltarem usam `REPORT_THRESHOLDS`). */
  thresholds?: Partial<Record<ReportSeverity, number>>;
  minAgeDays?: number;
}

export interface FileReportArgs {
  postId: string;
  reporterId: string;
  category: ReportCategory;
  reason?: string | null;
}

export type FileReportResult =
  /** O post não existe, foi apagado ou não está publicado (não é visível para quem denuncia). */
  | { outcome: "post_not_found" }
  | { outcome: "own_post" }
  | { outcome: "duplicate" }
  | {
      outcome: "created";
      report: Report;
      /** Denúncias abertas deste post (todas). */
      reportsCount: number;
      /** Denúncias abertas que contam para o limiar (soma das gravidades). */
      validReports: number;
      /** O mesmo, por gravidade (é por aqui que se decide a escalada). */
      validReportsBySeverity: Record<ReportSeverity, number>;
      /** Esta denúncia fez o post passar a "Em revisão". */
      escalated: boolean;
      /** Gravidade que passou o limiar (só quando `escalated`). */
      escalatedBy: ReportSeverity | null;
    };

async function countValidOpenBySeverity(
  tx: Tx,
  postId: string,
  minAgeDays: number,
): Promise<Record<ReportSeverity, number>> {
  const rows = await tx
    .select({ severity: reports.severity, c: count() })
    .from(reports)
    .innerJoin(users, eq(users.id, reports.reporterId))
    .where(
      and(
        eq(reports.postId, postId),
        eq(reports.status, "open"),
        lte(
          users.createdAt,
          sql`now() - make_interval(days => ${minAgeDays}::int)`,
        ),
        sql`EXISTS (
          SELECT 1 FROM ${posts}
          WHERE ${posts.authorId} = ${users.id}
            AND ${posts.status} = 'published'
            AND ${posts.deletedAt} IS NULL
        )`,
      ),
    )
    .groupBy(reports.severity);

  const bySeverity: Record<ReportSeverity, number> = {
    basic: 0,
    medium: 0,
    high: 0,
  };
  for (const row of rows) bySeverity[row.severity] = Number(row.c);
  return bySeverity;
}

export function reportsRepo(db: Database) {
  return {
    async create(data: NewReport): Promise<Report | null> {
      const result = await db
        .insert(reports)
        .values(data)
        .onConflictDoNothing()
        .returning();
      return result[0] ?? null;
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
            eq(reports.status, "open"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async countOpenByPost(postId: string): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(reports)
        .where(and(eq(reports.postId, postId), eq(reports.status, "open")));
      return Number(row?.c ?? 0);
    },

    async file(
      args: FileReportArgs,
      rules: ReportRules = {},
    ): Promise<FileReportResult> {
      const thresholds = { ...REPORT_THRESHOLDS, ...rules.thresholds };
      const minAgeDays = rules.minAgeDays ?? REPORTER_MIN_AGE_DAYS;

      return db.transaction(async (tx) => {
        const [post] = await tx
          .select({
            status: posts.status,
            authorId: posts.authorId,
            deletedAt: posts.deletedAt,
          })
          .from(posts)
          .where(eq(posts.id, args.postId))
          .for("no key update")
          .limit(1);
        if (!post || post.deletedAt !== null || post.status !== "published") {
          return { outcome: "post_not_found" as const };
        }
        if (post.authorId === args.reporterId) {
          return { outcome: "own_post" as const };
        }

        const [report] = await tx
          .insert(reports)
          .values({
            postId: args.postId,
            reporterId: args.reporterId,
            category: args.category,
            reason: args.reason ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (!report) return { outcome: "duplicate" as const };

        const [counted] = await tx
          .update(posts)
          .set({ reportsCount: sql`${posts.reportsCount} + 1` })
          .where(eq(posts.id, args.postId))
          .returning({ reportsCount: posts.reportsCount });

        const bySeverity = await countValidOpenBySeverity(
          tx,
          args.postId,
          minAgeDays,
        );
        const validReports =
          bySeverity.basic + bySeverity.medium + bySeverity.high;

        const triggered = SEVERITIES_BY_GRAVITY.find(
          (severity) => bySeverity[severity] >= thresholds[severity],
        );
        let escalated = false;
        if (triggered) {
          // Só sai de "published": nunca ressuscita um post oculto ou rejeitado.
          const moved = await tx
            .update(posts)
            .set({
              status: "pending_review",
              reviewFlags: sql`array_append(coalesce(${posts.reviewFlags}, ARRAY[]::text[]), ${`reports_${triggered}`}::text)`,
            })
            .where(
              and(eq(posts.id, args.postId), eq(posts.status, "published")),
            )
            .returning({ id: posts.id });
          escalated = moved.length > 0;
        }

        return {
          outcome: "created" as const,
          report,
          reportsCount: counted?.reportsCount ?? 0,
          validReports,
          validReportsBySeverity: bySeverity,
          escalated,
          escalatedBy: escalated && triggered ? triggered : null,
        };
      });
    },

    async cancel(id: string, userId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [own] = await tx
          .select({ postId: reports.postId })
          .from(reports)
          .where(
            and(
              eq(reports.id, id),
              eq(reports.reporterId, userId),
              eq(reports.status, "open"),
            ),
          )
          .limit(1);
        if (!own) return false;

        // Mesma ordem de bloqueios que `file` (post primeiro): evita deadlock se o mesmo
        // utilizador retirar e voltar a denunciar em simultâneo.
        await tx
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, own.postId))
          .for("no key update");

        const withdrawn = await tx
          .update(reports)
          .set({ status: "withdrawn", withdrawnAt: new Date() })
          .where(
            and(
              eq(reports.id, id),
              eq(reports.reporterId, userId),
              eq(reports.status, "open"),
            ),
          )
          .returning({ id: reports.id });
        if (withdrawn.length === 0) return false;

        await tx
          .update(posts)
          .set({ reportsCount: sql`GREATEST(${posts.reportsCount} - 1, 0)` })
          .where(eq(posts.id, own.postId));
        return true;
      });
    },

    /** As mais recentes primeiro, limitadas (nunca uma lista sem fim). */
    async listByReporter(reporterId: string, limit = 100): Promise<Report[]> {
      return db
        .select()
        .from(reports)
        .where(eq(reports.reporterId, reporterId))
        .orderBy(desc(reports.createdAt))
        .limit(limit);
    },

    async resolveAllForPost(
      postId: string,
      status: "resolved_kept" | "resolved_removed",
      resolvedBy: string,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, postId))
          .for("no key update");
        await tx
          .update(reports)
          .set({ status, resolvedAt: new Date(), resolvedBy })
          .where(and(eq(reports.postId, postId), eq(reports.status, "open")));
        // `reports_count` = denúncias abertas: ao resolver, ficam todas fechadas.
        await tx
          .update(posts)
          .set({ reportsCount: 0 })
          .where(eq(posts.id, postId));
      });
    },
  };
}

export function moderationLogRepo(db: Database) {
  return {
    async create(
      data: typeof moderationLog.$inferInsert,
    ): Promise<ModerationLogEntry> {
      const [row] = await db.insert(moderationLog).values(data).returning();
      return row!;
    },

    async listByPost(postId: string): Promise<ModerationLogEntry[]> {
      return db
        .select()
        .from(moderationLog)
        .where(eq(moderationLog.postId, postId))
        .orderBy(desc(moderationLog.createdAt));
    },

    async listRecent(limit = 100): Promise<ModerationLogEntry[]> {
      return db
        .select()
        .from(moderationLog)
        .orderBy(desc(moderationLog.createdAt))
        .limit(limit);
    },
  };
}
