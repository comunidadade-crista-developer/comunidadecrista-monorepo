import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@comunidade/shared";
import type {
  AdminModerationAction,
  AdminReportStatus,
  AdminReportsByCategory,
  CursorKind,
  PostStatus,
  ReportCategory,
} from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import { moderationLog, posts, reports } from "../db/schema.js";
import type { ModerationLogEntry, Post, Report } from "../db/schema.js";
import { InvalidCursorError, exactTs } from "./posts.js";

export interface AdminPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface KeysetRow<T> {
  row: T;
  ts: string;
  id: string;
}

function toPage<T>(
  rows: KeysetRow<T>[],
  limit: number,
  kind: "admin_posts" | "admin_reports" | "admin_log",
): AdminPage<T> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => r.row),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ k: kind, t: last.ts, id: last.id })
        : null,
  };
}

function readCursor(
  cursor: string | undefined,
  kind: CursorKind,
): { t: string; id: string } | null {
  if (cursor === undefined) return null;
  const parsed = decodeCursor(cursor, kind);
  // `t` e `id` existem em todos os tipos do painel; o `k` já foi verificado acima.
  if (parsed === null || parsed.k === "top") throw new InvalidCursorError();
  return { t: parsed.t, id: parsed.id };
}

export const EMPTY_REPORTS_BY_CATEGORY: Readonly<AdminReportsByCategory> = {
  spam: 0,
  off_topic: 0,
  offensive: 0,
  doctrine: 0,
  other: 0,
};

/** Leituras e bloqueios do painel de administração (ADR-015). */
export function adminRepo(db: Executor) {
  return {
    async listPostsPage(args: {
      status: PostStatus;
      cursor?: string | undefined;
      limit: number;
    }): Promise<AdminPage<Post>> {
      const cur = readCursor(args.cursor, "admin_posts");
      const oldestFirst = args.status === "pending_review";
      const conds = [eq(posts.status, args.status), isNull(posts.deletedAt)];
      if (cur) {
        conds.push(
          oldestFirst
            ? sql`(${posts.createdAt}, ${posts.id}) > (${cur.t}::timestamptz, ${cur.id}::uuid)`
            : sql`(${posts.createdAt}, ${posts.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ post: posts, ts: exactTs(posts.createdAt) })
        .from(posts)
        .where(and(...conds))
        .orderBy(
          ...(oldestFirst
            ? [asc(posts.createdAt), asc(posts.id)]
            : [desc(posts.createdAt), desc(posts.id)]),
        )
        .limit(args.limit + 1);
      return toPage(
        rows.map((r) => ({ row: r.post, ts: r.ts, id: r.post.id })),
        args.limit,
        "admin_posts",
      );
    },

    /** Post por id para o detalhe (nunca apagado). */
    async findPost(id: string): Promise<Post | null> {
      const [row] = await db
        .select()
        .from(posts)
        .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async lockPostForDecision(id: string): Promise<Post | null> {
      const [row] = await db
        .select()
        .from(posts)
        .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
        .for("update")
        .limit(1);
      return row ?? null;
    },

    async openReportsByPosts(
      postIds: string[],
    ): Promise<Map<string, AdminReportsByCategory>> {
      const out = new Map<string, AdminReportsByCategory>();
      if (postIds.length === 0) return out;
      const rows = await db
        .select({
          postId: reports.postId,
          category: reports.category,
          n: count(),
        })
        .from(reports)
        .where(
          and(inArray(reports.postId, postIds), eq(reports.status, "open")),
        )
        .groupBy(reports.postId, reports.category);
      for (const r of rows) {
        const entry = out.get(r.postId) ?? { ...EMPTY_REPORTS_BY_CATEGORY };
        entry[r.category as ReportCategory] = Number(r.n);
        out.set(r.postId, entry);
      }
      return out;
    },

    async titlesByIds(ids: string[]): Promise<Map<string, string>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select({ id: posts.id, title: posts.title })
        .from(posts)
        .where(inArray(posts.id, ids));
      return new Map(rows.map((r) => [r.id, r.title]));
    },

    async reportsForPost(postId: string, limit = 200): Promise<Report[]> {
      return db
        .select()
        .from(reports)
        .where(eq(reports.postId, postId))
        .orderBy(desc(reports.createdAt), desc(reports.id))
        .limit(limit);
    },

    async listReportsPage(args: {
      status: AdminReportStatus;
      cursor?: string | undefined;
      limit: number;
    }): Promise<AdminPage<Report>> {
      const cur = readCursor(args.cursor, "admin_reports");
      const conds = [eq(reports.status, args.status)];
      if (cur) {
        conds.push(
          sql`(${reports.createdAt}, ${reports.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ report: reports, ts: exactTs(reports.createdAt) })
        .from(reports)
        .where(and(...conds))
        .orderBy(desc(reports.createdAt), desc(reports.id))
        .limit(args.limit + 1);
      return toPage(
        rows.map((r) => ({ row: r.report, ts: r.ts, id: r.report.id })),
        args.limit,
        "admin_reports",
      );
    },

    async listLogPage(args: {
      action?: AdminModerationAction | undefined;
      postId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    }): Promise<AdminPage<ModerationLogEntry>> {
      const cur = readCursor(args.cursor, "admin_log");
      const conds: SQL[] = [];
      if (args.action) conds.push(eq(moderationLog.action, args.action));
      if (args.postId) conds.push(eq(moderationLog.postId, args.postId));
      if (cur) {
        conds.push(
          sql`(${moderationLog.createdAt}, ${moderationLog.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ entry: moderationLog, ts: exactTs(moderationLog.createdAt) })
        .from(moderationLog)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(moderationLog.createdAt), desc(moderationLog.id))
        .limit(args.limit + 1);
      return toPage(
        rows.map((r) => ({ row: r.entry, ts: r.ts, id: r.entry.id })),
        args.limit,
        "admin_log",
      );
    },

    async logForPost(
      postId: string,
      limit = 100,
    ): Promise<ModerationLogEntry[]> {
      return db
        .select()
        .from(moderationLog)
        .where(eq(moderationLog.postId, postId))
        .orderBy(desc(moderationLog.createdAt), desc(moderationLog.id))
        .limit(limit);
    },
  };
}
