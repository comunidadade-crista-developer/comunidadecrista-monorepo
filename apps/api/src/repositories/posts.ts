import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { decodeCursor, encodeCursor } from "@comunidade/shared";
import type { FeedFilter, PostCategory, PostStatus } from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import { postLikes, posts } from "../db/schema.js";
import type { NewPost, Post } from "../db/schema.js";

export type { FeedFilter };

/** O cursor recebido não é válido para este filtro (a rota valida antes; isto é a rede). */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export interface ListOptions {
  gospelCardId?: string;
  category?: PostCategory;
  filter?: FeedFilter;
  cursor?: string;
  limit?: number;
  viewerId?: string;
}

export interface ListResult {
  items: Post[];
  nextCursor: string | null;
}

export function exactTs(column: AnyPgColumn) {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function postsRepo(db: Executor) {
  return {
    async create(data: NewPost): Promise<Post> {
      const now = new Date();
      const publishedAt = data.status === "published" ? now : null;
      const [row] = await db
        .insert(posts)
        .values({ ...data, publishedAt })
        .returning();
      return row!;
    },

    async findLatestByAuthorInFilter(
      authorId: string,
      opts: {
        gospelCardId?: string;
        category?: PostCategory;
        statuses?: PostStatus[];
      } = {},
    ): Promise<Post | null> {
      const conds = [eq(posts.authorId, authorId), isNull(posts.deletedAt)];
      if (opts.gospelCardId) {
        conds.push(eq(posts.gospelCardId, opts.gospelCardId));
      }
      if (opts.category) conds.push(eq(posts.category, opts.category));
      conds.push(
        inArray(posts.status, opts.statuses ?? ["published", "pending_review"]),
      );
      const [row] = await db
        .select()
        .from(posts)
        .where(and(...conds))
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(1);
      return row ?? null;
    },

    async findById(
      id: string,
      opts: { includeDeleted?: boolean } = {},
    ): Promise<Post | null> {
      const conds = [eq(posts.id, id)];
      if (!opts.includeDeleted) conds.push(isNull(posts.deletedAt));
      const [row] = await db
        .select()
        .from(posts)
        .where(and(...conds))
        .limit(1);
      return row ?? null;
    },

    async softDelete(id: string, authorId: string): Promise<boolean> {
      const rows = await db
        .update(posts)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(posts.id, id),
            eq(posts.authorId, authorId),
            isNull(posts.deletedAt),
          ),
        )
        .returning({ id: posts.id });
      return rows.length > 0;
    },

    async purgeDeleted(olderThan: Date, batch = 500): Promise<number> {
      const due = await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(isNotNull(posts.deletedAt), lt(posts.deletedAt, olderThan)))
        .limit(batch);
      if (due.length === 0) return 0;
      const removed = await db
        .delete(posts)
        .where(
          inArray(
            posts.id,
            due.map((r) => r.id),
          ),
        )
        .returning({ id: posts.id });
      return removed.length;
    },

    /** Apaga de vez (sem passar por soft delete): testes e limpezas internas. */
    async delete(id: string): Promise<void> {
      await db.delete(posts).where(eq(posts.id, id));
    },

    async list(opts: ListOptions = {}): Promise<ListResult> {
      const {
        category,
        filter = "recent",
        cursor,
        limit = 20,
        viewerId,
      } = opts;

      const parsed = cursor === undefined ? null : decodeCursor(cursor, filter);
      if (cursor !== undefined && parsed === null)
        throw new InvalidCursorError();

      const conditions = [
        eq(posts.status, "published"),
        isNull(posts.deletedAt),
      ];
      if (category) conditions.push(eq(posts.category, category));
      if (opts.gospelCardId) {
        conditions.push(eq(posts.gospelCardId, opts.gospelCardId));
      }

      if (filter === "recent") {
        if (parsed?.k === "recent") {
          conditions.push(
            sql`(${posts.createdAt}, ${posts.id}) < (${parsed.t}::timestamptz, ${parsed.id}::uuid)`,
          );
        }
        const rows = await db
          .select({ post: posts, ts: exactTs(posts.createdAt) })
          .from(posts)
          .where(and(...conditions))
          .orderBy(desc(posts.createdAt), desc(posts.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => r.post),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ k: "recent", t: last.ts, id: last.post.id })
              : null,
        };
      }

      if (filter === "top") {
        if (parsed?.k === "top") {
          conditions.push(
            sql`(${posts.likesCount}, ${posts.createdAt}, ${posts.id}) < (${parsed.l}::int, ${parsed.t}::timestamptz, ${parsed.id}::uuid)`,
          );
        }
        const rows = await db
          .select({ post: posts, ts: exactTs(posts.createdAt) })
          .from(posts)
          .where(and(...conditions))
          .orderBy(
            desc(posts.likesCount),
            desc(posts.createdAt),
            desc(posts.id),
          )
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => r.post),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({
                  k: "top",
                  l: last.post.likesCount,
                  t: last.ts,
                  id: last.post.id,
                })
              : null,
        };
      }

      // filter === "liked": os que o viewer curtiu, do like mais recente para o mais antigo.
      if (!viewerId) return { items: [], nextCursor: null };
      conditions.push(eq(postLikes.userId, viewerId));
      if (parsed?.k === "liked") {
        conditions.push(
          sql`(${postLikes.createdAt}, ${postLikes.postId}) < (${parsed.t}::timestamptz, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ post: posts, ts: exactTs(postLikes.createdAt) })
        .from(posts)
        .innerJoin(postLikes, eq(postLikes.postId, posts.id))
        .where(and(...conditions))
        .orderBy(desc(postLikes.createdAt), desc(postLikes.postId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => r.post),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ k: "liked", t: last.ts, id: last.post.id })
            : null,
      };
    },

    /** Os posts do próprio autor (qualquer estado, menos apagados), mais recentes primeiro. */
    async listByAuthor(authorId: string, limit = 50): Promise<Post[]> {
      return db
        .select()
        .from(posts)
        .where(and(eq(posts.authorId, authorId), isNull(posts.deletedAt)))
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(limit);
    },

    async setStatus(id: string, status: Post["status"]): Promise<Post | null> {
      const [row] = await db
        .update(posts)
        .set({
          status,
          ...(status === "published"
            ? { publishedAt: sql`coalesce(${posts.publishedAt}, now())` }
            : {}),
        })
        .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
        .returning();
      return row ?? null;
    },

    async incrementLikes(postId: string, delta: 1 | -1): Promise<number> {
      const [row] = await db
        .update(posts)
        .set({ likesCount: sql`GREATEST(${posts.likesCount} + ${delta}, 0)` })
        .where(eq(posts.id, postId))
        .returning({ likesCount: posts.likesCount });
      return row?.likesCount ?? 0;
    },

    async incrementReports(postId: string, delta: 1 | -1): Promise<number> {
      const [row] = await db
        .update(posts)
        .set({
          reportsCount: sql`GREATEST(${posts.reportsCount} + ${delta}, 0)`,
        })
        .where(eq(posts.id, postId))
        .returning({ reportsCount: posts.reportsCount });
      return row?.reportsCount ?? 0;
    },

    /** Quantos posts (não apagados) o autor tem, em qualquer estado. */
    async countByAuthor(authorId: string): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(posts)
        .where(and(eq(posts.authorId, authorId), isNull(posts.deletedAt)));
      return Number(row?.c ?? 0);
    },
  };
}

export function postLikesRepo(db: Executor) {
  return {
    async like(postId: string, userId: string): Promise<boolean> {
      const result = await db
        .insert(postLikes)
        .values({ postId, userId })
        .onConflictDoNothing()
        .returning({ postId: postLikes.postId });
      return result.length > 0;
    },

    async unlike(postId: string, userId: string): Promise<boolean> {
      const result = await db
        .delete(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)))
        .returning({ postId: postLikes.postId });
      return result.length > 0;
    },

    /** Dos `postIds` dados, quais o utilizador curtiu (decorar uma página do feed). */
    async findLikedPostIds(
      userId: string,
      postIds: string[],
    ): Promise<string[]> {
      if (postIds.length === 0) return [];
      const rows = await db
        .select({ postId: postLikes.postId })
        .from(postLikes)
        .where(
          and(eq(postLikes.userId, userId), inArray(postLikes.postId, postIds)),
        );
      return rows.map((r) => r.postId);
    },

    async listLikedPostIds(
      userId: string,
      limit = 500,
    ): Promise<{ ids: string[]; truncated: boolean }> {
      const rows = await db
        .select({ postId: postLikes.postId })
        .from(postLikes)
        .where(eq(postLikes.userId, userId))
        .orderBy(desc(postLikes.createdAt), desc(postLikes.postId))
        .limit(limit + 1);
      return {
        ids: rows.slice(0, limit).map((r) => r.postId),
        truncated: rows.length > limit,
      };
    },
  };
}
