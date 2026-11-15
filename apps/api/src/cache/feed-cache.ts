import { PostPublic } from "@comunidade/shared";
import type { PostCategory } from "@comunidade/shared";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Executor } from "../db/client.js";
import { postsRepo } from "../repositories/posts.js";
import { presentPosts } from "../services/post-presenter.js";

const NAMESPACE = "cc:v1:feed";
const VERSION_KEY = `${NAMESPACE}:version`;
const DEFAULT_TTL_SECONDS = 30;

type RedisLike = Pick<Redis, "get" | "set" | "incr">;

export interface FeedCacheLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface FeedListOptions {
  filter: "recent" | "top";
  category?: PostCategory | undefined;
  gospelCardId?: string | undefined;
  /** Cursor já validado pela rota. Com cursor, a página nunca passa pela cache. */
  cursor?: string | undefined;
  limit: number;
}

export interface FeedPage {
  /** Formato público, SEM decoração do espectador (`isLiked`/`isMine` a `false`). */
  posts: PostPublic[];
  /** Autor de cada post, na mesma ordem. Interno: nunca serializar para o cliente. */
  authorIds: (string | null)[];
  nextCursor: string | null;
}

export interface FeedCache {
  list(opts: FeedListOptions): Promise<FeedPage & { cacheHit: boolean }>;
  invalidate(): Promise<boolean>;
}

export interface FeedCacheDeps {
  redis: RedisLike | null;
  db: Executor;
  logger: FeedCacheLogger;
  ttlSeconds?: number;
}

const CachedPage = z
  .object({
    posts: z.array(PostPublic),
    authorIds: z.array(z.uuid().nullable()),
    nextCursor: z.string().nullable(),
  })
  .refine((v) => v.posts.length === v.authorIds.length);

function errorInfo(err: unknown): Record<string, unknown> {
  return {
    errorName: err instanceof Error ? err.name : typeof err,
    errorCode:
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : undefined,
  };
}

export function createFeedCache(deps: FeedCacheDeps): FeedCache {
  const { redis, db, logger } = deps;
  const ttl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const inflight = new Map<string, Promise<FeedPage>>();

  async function loadFromDb(opts: FeedListOptions): Promise<FeedPage> {
    const result = await postsRepo(db).list({
      filter: opts.filter,
      limit: opts.limit,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.gospelCardId ? { gospelCardId: opts.gospelCardId } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return {
      posts: await presentPosts(result.items, db),
      authorIds: result.items.map((p) => p.authorId),
      nextCursor: result.nextCursor,
    };
  }

  /** `null` = sem Redis ou Redis a falhar: a cache fica de lado neste pedido. */
  async function readVersion(): Promise<number | null> {
    if (!redis) return null;
    try {
      const raw = await redis.get(VERSION_KEY);
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
      logger.warn(errorInfo(err), "feed-cache: version read failed");
      return null;
    }
  }

  async function readPage(key: string): Promise<FeedPage | null> {
    if (!redis) return null;
    try {
      const raw = await redis.get(key);
      if (raw === null) return null;
      const parsed = CachedPage.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn({}, "feed-cache: invalid cached value ignored");
        return null;
      }
      return parsed.data;
    } catch (err) {
      logger.warn(errorInfo(err), "feed-cache: read failed");
      return null;
    }
  }

  async function writePage(key: string, page: FeedPage): Promise<void> {
    if (!redis) return;
    try {
      await redis.set(key, JSON.stringify(page), "EX", ttl);
    } catch (err) {
      logger.warn(errorInfo(err), "feed-cache: write failed");
    }
  }

  return {
    async list(opts) {
      // Páginas seguintes: sempre à base de dados.
      if (opts.cursor !== undefined) {
        return { ...(await loadFromDb(opts)), cacheHit: false };
      }

      const version = await readVersion();
      if (version === null) {
        return { ...(await loadFromDb(opts)), cacheHit: false };
      }

      const key =
        `${NAMESPACE}:v${version}:${opts.filter}:` +
        `${opts.category ?? "all"}:${opts.gospelCardId ?? "all"}:${opts.limit}`;

      const cached = await readPage(key);
      if (cached) return { ...cached, cacheHit: true };

      // Anti-stampede: pedidos concorrentes à mesma chave fazem uma só carga.
      let running = inflight.get(key);
      if (!running) {
        const promise: Promise<FeedPage> = (async () => {
          const page = await loadFromDb(opts);
          await writePage(key, page);
          return page;
        })().finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key);
        });
        inflight.set(key, promise);
        running = promise;
      }
      return { ...(await running), cacheHit: false };
    },

    async invalidate() {
      if (!redis) return true;
      try {
        await redis.incr(VERSION_KEY);
        return true;
      } catch (err) {
        logger.warn(errorInfo(err), "feed-cache: invalidation failed");
        return false;
      }
    },
  };
}
