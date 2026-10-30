import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostCategory, PostStatus } from '@comunidade/shared'
import type { Database } from "../db/client.js";
import { postLikes, posts } from "../db/schema.js";
import type { NewPost, Post } from "../db/schema.js";

export type FeedFilter = "recent" | "top" | "liked";

export interface ListOptions {
  gospelCardId?: string;
  category?: "entendimento" | "ensinamento" | "letra_cancao";
  filter?: FeedFilter;
  cursor?: string;
  limit?: number;
  viewerId?: string;
}

export interface ListResult {
  items: Post[];
  nextCursor: string | null;
}

export function postsRepo(db: Database) {
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
      opts: { gospelCardId?: string; category?: PostCategory; statuses?: PostStatus[] } = {},
    ): Promise<Post | null> {
      const conds: ReturnType<typeof eq>[] = [eq(posts.authorId, authorId)];
      if (opts.gospelCardId) conds.push(eq(posts.gospelCardId, opts.gospelCardId));
      if (opts.category) conds.push(eq(posts.category, opts.category));
      const statuses = opts.statuses ?? ['published', 'pending_review'];
      conds.push(inArray(posts.status, statuses));
      const [row] = await db
        .select()
        .from(posts)
        .where(and(...conds))
        .orderBy(desc(posts.createdAt))
        .limit(1);
      return row ?? null;
    },

    async findById(id: string): Promise<Post | null> {
      const [row] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, id))
        .limit(1);
      return row ?? null;
    },

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
      const conditions = [eq(posts.status, "published")];
      if (category) conditions.push(eq(posts.category, category));
      if (opts.gospelCardId) conditions.push(eq(posts.gospelCardId, opts.gospelCardId));

      if (filter === "recent") {
        if (cursor) {
          const cursorDate = new Date(cursor);
          conditions.push(sql`${posts.createdAt} < ${cursorDate}`);
        }
        const rows = await db
          .select()
          .from(posts)
          .where(and(...conditions))
          .orderBy(desc(posts.createdAt))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return {
          items,
          nextCursor: hasMore
            ? items[items.length - 1]!.createdAt.toISOString()
            : null,
        };
      }

      if (filter === "top") {
        const rows = await db
          .select()
          .from(posts)
          .where(and(...conditions))
          .orderBy(desc(posts.likesCount), desc(posts.createdAt))
          .limit(limit);
        return { items: rows, nextCursor: null };
      }

      // filter === 'liked'
      if (!viewerId) return { items: [], nextCursor: null };
      const rows = await db
        .select({ post: posts })
        .from(posts)
        .innerJoin(postLikes, eq(postLikes.postId, posts.id))
        .where(and(...conditions, eq(postLikes.userId, viewerId)))
        .orderBy(desc(posts.createdAt))
        .limit(limit);
      return { items: rows.map((r) => r.post), nextCursor: null };
    },

    async listByAuthor(authorId: string, limit = 50): Promise<Post[]> {
      return db
        .select()
        .from(posts)
        .where(eq(posts.authorId, authorId))
        .orderBy(desc(posts.createdAt))
        .limit(limit);
    },

    async setStatus(id: string, status: Post["status"]): Promise<Post | null> {
      const [row] = await db
        .update(posts)
        .set({ status })
        .where(eq(posts.id, id))
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

    async countByAuthor(authorId: string): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(posts)
        .where(eq(posts.authorId, authorId));
      return Number(row?.c ?? 0);
    },
  };
}


export function postLikesRepo(db: Database) {
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

    async findLikedPostIds(userId: string, postIds: string[]): Promise<string[]> {
      if (postIds.length === 0) return [];
      const rows = await db
        .select({ postId: postLikes.postId })
        .from(postLikes)
        .where(and(eq(postLikes.userId, userId), inArray(postLikes.postId, postIds)));
      return rows.map((r) => r.postId);
    },
  };
}

