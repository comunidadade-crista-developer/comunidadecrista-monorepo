import type { PostPublic, PostCategory } from '@comunidade/shared';
import type { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
// import type { Post } from '../db/schema.js';
import { postsRepo } from '../repositories/posts.js';
import { presentPosts } from '../services/post-presenter.js';

const PREFIX = 'cc:v1:feed';
const TTL_SECONDS = 60;

interface Logger {
  warn: (obj: unknown, msg: string) => void;
}

export interface FeedCacheReadOptions {
  category?: PostCategory;
  gospelCardId?: string;
  filter: 'recent' | 'top';
  cursor?: string;
  limit: number;
}

export interface FeedCacheResult {
  items: PostPublic[];
  nextCursor: string | null;
  cacheHit: boolean;
}

export interface FeedCache {
  list(opts: FeedCacheReadOptions): Promise<FeedCacheResult>;
  invalidate(): Promise<number>;
}

export function createFeedCache(deps: {
  redis: Redis | null;
  db: Database;
  logger: Logger;
}): FeedCache {
  const { redis, db, logger } = deps;
  const repo = postsRepo(db);

  function buildKey(opts: FeedCacheReadOptions): string {
    const cat = opts.category ?? 'all';
    const card = opts.gospelCardId ?? 'all';
    const cur = opts.cursor ?? 'first';
    return `${PREFIX}:${cat}:${card}:${opts.filter}:${opts.limit}:${cur}`;
  }

  return {
    async list(opts) {
      if (!redis) {
        const result = await repo.list({
          category: opts.category,
          gospelCardId: opts.gospelCardId,
          filter: opts.filter,
          cursor: opts.cursor,
          limit: opts.limit,
        });
        return {
          items: await presentPosts(result.items, db),
          nextCursor: result.nextCursor,
          cacheHit: false,
        };
      }

      const key = buildKey(opts);

      try {
        const raw = await redis.get(key);
        if (raw) {
          const parsed = JSON.parse(raw) as { items: PostPublic[]; nextCursor: string | null };
          return { ...parsed, cacheHit: true };
        }
      } catch (err) {
        logger.warn({ err, key }, 'feed-cache: read failed');
      }

      const result = await repo.list({
        category: opts.category,
        gospelCardId: opts.gospelCardId,
        filter: opts.filter,
        cursor: opts.cursor,
        limit: opts.limit,
      });
      const items = await presentPosts(result.items, db);

      // Não cachear listas vazias nem a última página sem cursor — o próximo hit não ganharia nada.
      if (items.length > 0) {
        try {
          await redis.set(
            key,
            JSON.stringify({ items, nextCursor: result.nextCursor }),
            'EX',
            TTL_SECONDS,
          );
        } catch (err) {
          logger.warn({ err, key }, 'feed-cache: write failed');
        }
      }

      return { items, nextCursor: result.nextCursor, cacheHit: false };
    },

    async invalidate() {
      if (!redis) return 0;
      try {
        let cursor = '0';
        let deleted = 0;
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 100);
          cursor = next;
          if (keys.length > 0) {
            await redis.del(...keys);
            deleted += keys.length;
          }
        } while (cursor !== '0');
        if (deleted > 0) logger.warn({ deleted }, 'feed-cache: invalidated');
        return deleted;
      } catch (err) {
        logger.warn({ err }, 'feed-cache: invalidation failed');
        return 0;
      }
    },
  };
}