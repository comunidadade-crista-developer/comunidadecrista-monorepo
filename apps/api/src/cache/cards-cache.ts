import {
  CardSlug,
  GospelCardListResponse,
  GospelCardPublic,
} from "@comunidade/shared";
import type { Redis } from "ioredis";
import type { GospelCard } from "../db/schema.js";
import type { cardsRepo } from "../repositories/cards.js";

const NAMESPACE = "cc:v1:cards";
const VERSION_KEY = `${NAMESPACE}:version`;
const L2_TTL_SECONDS = 3600;
const L1_TTL_MS = 5 * 60_000;
// Sem Redis não há versão para detectar mudanças: a L1 vive pouco.
const L1_TTL_NO_REDIS_MS = 60_000;
const VERSION_MEMORY_TTL_MS = 60_000;
const VERSION_RETRY_AFTER_ERROR_MS = 10_000;
const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_MAX_ENTRIES = 1000;

type CardsRepo = ReturnType<typeof cardsRepo>;
type CardsSource = Pick<CardsRepo, "list" | "findBySlug">;
type RedisLike = Pick<Redis, "get" | "set" | "incr">;

export interface CardsCacheLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface CardsCache {
  list(): Promise<GospelCardPublic[]>;
  bySlug(slug: string): Promise<GospelCardPublic | null>;
  invalidate(): Promise<number>;
}

export interface CardsCacheDeps {
  redis: RedisLike | null;
  cards: CardsSource;
  logger: CardsCacheLogger;
  /** Só para testes. */
  now?: () => number;
  versionMemoryTtlMs?: number;
}

interface Entry<T> {
  version: number | null;
  expiresAt: number;
  data: T;
}

function toPublic(card: GospelCard): GospelCardPublic {
  return {
    slug: card.slug,
    title: card.title,
    gospelReference: card.gospelReference,
    summary: card.summary,
    otReferences: card.otReferences,
    ntReferences: card.ntReferences,
    orderIndex: card.orderIndex,
  };
}

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

export function createCardsCache(deps: CardsCacheDeps): CardsCache {
  const { redis, cards, logger } = deps;
  const now = deps.now ?? Date.now;
  const versionTtl = deps.versionMemoryTtlMs ?? VERSION_MEMORY_TTL_MS;

  let knownVersion: { value: number; at: number } | null = null;
  let versionRetryAt = 0;
  let versionInflight: Promise<number | null> | null = null;

  let listL1: Entry<GospelCardPublic[]> | null = null;
  const itemL1 = new Map<string, Entry<GospelCardPublic>>();
  const missL1 = new Map<
    string,
    { version: number | null; expiresAt: number }
  >();
  const inflight = new Map<string, Promise<unknown>>();

  function clearL1(): void {
    listL1 = null;
    itemL1.clear();
    missL1.clear();
    inflight.clear();
  }

  async function readVersion(): Promise<number | null> {
    if (!redis) return null;
    const t = now();
    if (knownVersion && t - knownVersion.at < versionTtl) {
      return knownVersion.value;
    }
    if (t < versionRetryAt) return knownVersion?.value ?? null;
    if (versionInflight) return versionInflight;

    versionInflight = (async () => {
      try {
        const raw = await redis.get(VERSION_KEY);
        const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
        const value = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
        knownVersion = { value, at: now() };
        return value;
      } catch (err) {
        versionRetryAt = now() + VERSION_RETRY_AFTER_ERROR_MS;
        logger.warn(errorInfo(err), "cards-cache: version read failed");
        return knownVersion?.value ?? null;
      } finally {
        versionInflight = null;
      }
    })();
    return versionInflight;
  }

  function l1Ttl(version: number | null): number {
    return version === null ? L1_TTL_NO_REDIS_MS : L1_TTL_MS;
  }

  function fresh<T>(
    entry: Entry<T> | null | undefined,
    version: number | null,
  ) {
    return entry && entry.version === version && now() < entry.expiresAt
      ? entry
      : null;
  }

  function once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const promise = load().finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  async function l2Get<T>(
    key: string,
    parse: (value: unknown) => T | null,
  ): Promise<T | null> {
    if (!redis) return null;
    try {
      const raw = await redis.get(key);
      if (raw === null) return null;
      const value = parse(JSON.parse(raw));
      if (value === null) {
        logger.warn({}, "cards-cache: invalid cached value ignored");
      }
      return value;
    } catch (err) {
      logger.warn(errorInfo(err), "cards-cache: read failed");
      return null;
    }
  }

  async function l2Set(key: string, value: unknown): Promise<void> {
    if (!redis) return;
    try {
      await redis.set(key, JSON.stringify(value), "EX", L2_TTL_SECONDS);
    } catch (err) {
      logger.warn(errorInfo(err), "cards-cache: write failed");
    }
  }

  const parseList = (value: unknown): GospelCardPublic[] | null => {
    const result = GospelCardListResponse.safeParse({ cards: value });
    return result.success ? result.data.cards : null;
  };
  const parseItem = (value: unknown): GospelCardPublic | null => {
    const result = GospelCardPublic.safeParse(value);
    return result.success ? result.data : null;
  };

  function rememberMiss(slug: string, version: number | null): void {
    if (missL1.size >= NEGATIVE_MAX_ENTRIES) {
      const oldest = missL1.keys().next();
      if (!oldest.done) missL1.delete(oldest.value);
    }
    missL1.set(slug, { version, expiresAt: now() + NEGATIVE_TTL_MS });
  }

  return {
    async list() {
      const version = await readVersion();
      const hit = fresh(listL1, version);
      if (hit) return hit.data;

      return once(`${version}:list`, async () => {
        const key = `${NAMESPACE}:v${version}:list`;
        const cached = version === null ? null : await l2Get(key, parseList);
        const data = cached ?? (await cards.list()).map(toPublic);

        // Lista vazia = seed por correr: não se guarda, para não a fixar durante 1 h.
        if (data.length > 0) {
          listL1 = {
            version,
            expiresAt: now() + l1Ttl(version),
            data,
          };
          if (cached === null && version !== null) await l2Set(key, data);
        }
        return data;
      });
    },

    async bySlug(slug) {
      if (!CardSlug.safeParse(slug).success) return null;
      const version = await readVersion();

      const hit = fresh(itemL1.get(slug), version);
      if (hit) return hit.data;

      const miss = missL1.get(slug);
      if (miss && miss.version === version && now() < miss.expiresAt) {
        return null;
      }

      const list = fresh(listL1, version);
      if (list) {
        const found = list.data.find((c) => c.slug === slug) ?? null;
        if (found) {
          itemL1.set(slug, {
            version,
            expiresAt: now() + l1Ttl(version),
            data: found,
          });
        } else {
          rememberMiss(slug, version);
        }
        return found;
      }

      return once(`${version}:item:${slug}`, async () => {
        const key = `${NAMESPACE}:v${version}:item:${slug}`;
        const cached = version === null ? null : await l2Get(key, parseItem);
        let data = cached;
        if (data === null) {
          const row = await cards.findBySlug(slug);
          data = row ? toPublic(row) : null;
        }

        if (data === null) {
          rememberMiss(slug, version);
          return null;
        }
        itemL1.set(slug, {
          version,
          expiresAt: now() + l1Ttl(version),
          data,
        });
        if (cached === null && version !== null) await l2Set(key, data);
        return data;
      });
    },

    async invalidate() {
      if (!redis) {
        clearL1();
        return 0;
      }
      const next = await redis.incr(VERSION_KEY);
      knownVersion = { value: next, at: now() };
      versionRetryAt = 0;
      clearL1();
      logger.info({ version: next }, "cards-cache: invalidated");
      return next;
    },
  };
}
