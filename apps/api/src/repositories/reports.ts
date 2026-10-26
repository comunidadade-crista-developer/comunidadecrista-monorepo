import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { moderationLog, reports } from "../db/schema.js";
import type { ModerationLogEntry, NewReport, Report } from "../db/schema.js";

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
      const rows = await db
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.postId, postId), eq(reports.status, "open")));
      return rows.length;
    },

    async cancel(id: string, userId: string): Promise<boolean> {
      const result = await db
        .delete(reports)
        .where(and(eq(reports.id, id), eq(reports.reporterId, userId)))
        .returning({ id: reports.id });
      return result.length > 0;
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
      await db
        .update(reports)
        .set({ status, resolvedAt: new Date(), resolvedBy })
        .where(and(eq(reports.postId, postId), eq(reports.status, "open")));
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
