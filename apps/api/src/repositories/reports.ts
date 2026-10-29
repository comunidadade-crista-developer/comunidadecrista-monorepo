import { and, count, desc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { moderationLog, posts, reports, users } from "../db/schema.js";
import type { ModerationLogEntry, NewReport, Report } from "../db/schema.js";

/** Nº de denúncias válidas e abertas a partir do qual o post passa a "Em revisão". */
export const REPORT_THRESHOLD = 10;
/** Idade mínima da conta de quem denuncia para a denúncia contar para o limiar. */
export const REPORTER_MIN_AGE_DAYS = 7;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface ReportRules {
  threshold?: number;
  minAgeDays?: number;
}

export type FileReportResult =
  /** O post não existe ou não está publicado (não é visível para quem denuncia). */
  | { outcome: "post_not_found" }
  | { outcome: "own_post" }
  /** Já existe uma denúncia deste utilizador para este post (aberta ou resolvida). */
  | { outcome: "duplicate" }
  | {
      outcome: "created";
      report: Report;
      /** Denúncias abertas deste post (todas). */
      reportsCount: number;
      /** Denúncias abertas que contam para o limiar. */
      validReports: number;
      /** Esta denúncia fez o post passar a "Em revisão". */
      escalated: boolean;
    };

/**
 * Denúncias abertas que contam para o limiar: a conta tem a idade mínima e já fez pelo
 * menos uma partilha (anti-abuso: contas novas ou sem partilhas não contam).
 */
async function countValidOpen(
  tx: Tx,
  postId: string,
  minAgeDays: number,
): Promise<number> {
  const [row] = await tx
    .select({ c: count() })
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
        sql`EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.authorId} = ${users.id})`,
      ),
    );
  return Number(row?.c ?? 0);
}

export function reportsRepo(db: Database) {
  return {
    /**
     * Operação de baixo nível: só insere a linha, sem regras nem contadores.
     * As rotas devem usar `file`, que aplica as regras de negócio numa transacção.
     */
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

    /**
     * Denuncia um post. Tudo numa transacção, com o post bloqueado (FOR NO KEY UPDATE) para
     * serializar denúncias concorrentes ao mesmo post: o contador e o limiar nunca se perdem
     * e só uma denúncia pode ser a que escala o post.
     *
     * Regras: só posts publicados; sem auto-denúncia; uma denúncia por utilizador e post;
     * ao atingir o limiar de denúncias válidas, o post passa a `pending_review`.
     */
    async file(
      args: { postId: string; reporterId: string; reason: string },
      rules: ReportRules = {},
    ): Promise<FileReportResult> {
      const threshold = rules.threshold ?? REPORT_THRESHOLD;
      const minAgeDays = rules.minAgeDays ?? REPORTER_MIN_AGE_DAYS;

      return db.transaction(async (tx) => {
        const [post] = await tx
          .select({ status: posts.status, authorId: posts.authorId })
          .from(posts)
          .where(eq(posts.id, args.postId))
          .for("no key update")
          .limit(1);
        if (!post || post.status !== "published") {
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
            reason: args.reason,
          })
          .onConflictDoNothing()
          .returning();
        if (!report) return { outcome: "duplicate" as const };

        const [counted] = await tx
          .update(posts)
          .set({ reportsCount: sql`${posts.reportsCount} + 1` })
          .where(eq(posts.id, args.postId))
          .returning({ reportsCount: posts.reportsCount });

        const validReports = await countValidOpen(tx, args.postId, minAgeDays);
        let escalated = false;
        if (validReports >= threshold) {
          // Só sai de "published": nunca ressuscita um post oculto ou rejeitado.
          const moved = await tx
            .update(posts)
            .set({ status: "pending_review" })
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
          escalated,
        };
      });
    },

    /**
     * Cancela uma denúncia ABERTA do próprio utilizador e actualiza o contador. Uma denúncia
     * já resolvida não se cancela. Cancelar não tira o post de "Em revisão": quem decide é o
     * admin.
     */
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
        // utilizador cancelar e voltar a denunciar em simultâneo.
        await tx
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, own.postId))
          .for("no key update");

        const removed = await tx
          .delete(reports)
          .where(
            and(
              eq(reports.id, id),
              eq(reports.reporterId, userId),
              eq(reports.status, "open"),
            ),
          )
          .returning({ id: reports.id });
        if (removed.length === 0) return false;

        await tx
          .update(posts)
          .set({ reportsCount: sql`GREATEST(${posts.reportsCount} - 1, 0)` })
          .where(eq(posts.id, own.postId));
        return true;
      });
    },

    async listByReporter(reporterId: string): Promise<Report[]> {
      return db
        .select()
        .from(reports)
        .where(eq(reports.reporterId, reporterId))
        .orderBy(desc(reports.createdAt));
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
