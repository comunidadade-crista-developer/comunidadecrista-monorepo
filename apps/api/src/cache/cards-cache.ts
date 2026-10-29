import type { Redis } from 'ioredis';
import type { GospelCard } from '../db/schema.js';
import type { GospelCardPublic } from '@comunidade/shared';
import type { cardsRepo } from '../repositories/cards.js';

const NAMESPACE = 'cc:v1:cards';
const VERSION_KEY = `${NAMESPACE}:version`;
const LIST_TTL_SECONDS = 3600;
const ITEM_TTL_SECONDS = 3600;
const VERSION_MEMORY_TTL_MS = 60_000;

type CardsRepo = ReturnType<typeof cardsRepo>;

interface Logger {
  warn: (obj: unknown, msg: string) => void;
}

export interface CardsCache {
  list(): Promise<GospelCardPublic[]>;
  bySlug(slug: string): Promise<GospelCardPublic | null>;
  invalidate(): Promise<number>;
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

export function createCardsCache(deps: {
  redis: Redis | null;
  cards: CardsRepo;
  logger: Logger;
}): CardsCache {
  const { redis, cards, logger } = deps;

  // Cache de versão em memória (60s) para reduzir GETs ao Redis em hot path.
  // Após `invalidate()` no mesmo processo, é actualizado imediatamente.
  let memVersion: { value: number; at: number } | null = null;

  async function getVersion(): Promise<number | null> {
    if (!redis) return null;
    if (memVersion && Date.now() - memVersion.at < VERSION_MEMORY_TTL_MS) {
      return memVersion.value;
    }
    try {
      const raw = await redis.get(VERSION_KEY);
      const value = raw ? Number.parseInt(raw, 10) : 0;
      const safe = Number.isFinite(value) && value >= 0 ? value : 0;
      memVersion = { value: safe, at: Date.now() };
      return safe;
    } catch (err) {
      logger.warn({ err }, 'cards-cache: version read failed');
      memVersion = null;
      return null;
    }
  }

  return {
    async list(): Promise<GospelCardPublic[]> {
      const version = await getVersion();

      if (version === null) {
        // Redis indisponível → fail-open (vai directo à DB, sem cache)
        const rows = await cards.list();
        return rows.map(toPublic);
      }

      const key = `${NAMESPACE}:v${version}:list`;

      try {
        const cached = await redis!.get(key);
        if (cached) {
          return JSON.parse(cached) as GospelCardPublic[];
        }
      } catch (err) {
        logger.warn({ err, key }, 'cards-cache: read failed');
      }

      const rows = await cards.list();
      const publicRows = rows.map(toPublic);

      if (publicRows.length > 0) {
        try {
          await redis!.set(key, JSON.stringify(publicRows), 'EX', LIST_TTL_SECONDS);
        } catch (err) {
          logger.warn({ err, key }, 'cards-cache: write failed');
        }
      }

      return publicRows;
    },

    async bySlug(slug: string): Promise<GospelCardPublic | null> {
      const version = await getVersion();

      if (version === null) {
        const row = await cards.findBySlug(slug);
        return row ? toPublic(row) : null;
      }

      const key = `${NAMESPACE}:v${version}:item:${slug}`;

      try {
        const cached = await redis!.get(key);
        if (cached) {
          const parsed = JSON.parse(cached) as GospelCardPublic | { __null__: true };
          if ('__null__' in parsed) return null;
          return parsed;
        }
      } catch (err) {
        logger.warn({ err, key }, 'cards-cache: read failed');
      }

      const row = await cards.findBySlug(slug);
      const publicRow = row ? toPublic(row) : null;

      try {
        if (publicRow) {
          await redis!.set(key, JSON.stringify(publicRow), 'EX', ITEM_TTL_SECONDS);
        }
      } catch (err) {
        logger.warn({ err, key }, 'cards-cache: write failed');
      }

      return publicRow;
    },

    async invalidate(): Promise<number> {
      if (!redis) return 0;
      try {
        const newVersion = await redis.incr(VERSION_KEY);
        memVersion = { value: newVersion, at: Date.now() };
        logger.warn({ version: newVersion }, 'cards-cache: invalidated');
        return newVersion;
      } catch (err) {
        logger.warn({ err }, 'cards-cache: invalidation failed');
        return 0;
      }
    },
  };
}