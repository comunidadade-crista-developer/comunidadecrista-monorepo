import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCardsCache } from '../../src/cache/cards-cache.js';
import { cardsRepo } from '../../src/repositories/cards.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';

let redis: Redis;

beforeAll(async () => {
  await getTestDb();
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await redis.quit();
  await closeTestDb();
});

afterEach(async () => {
  await truncateAll();
  const keys = await redis.keys('cc:v1:cards:*');
  if (keys.length) await redis.del(...keys);
});

function makeLogger() {
  const logs: Array<{ obj: unknown; msg: string }> = [];
  return {
    logger: { warn: (obj: unknown, msg: string) => { logs.push({ obj, msg }); } },
    logs,
  };
}

async function seedCard(db: Awaited<ReturnType<typeof getTestDb>>, slug: string, orderIndex: number) {
  return cardsRepo(db).create({
    slug,
    title: `Card ${slug}`,
    gospelReference: 'Mateus 2',
    summary: 'Resumo',
    otReferences: ['Isaías 7:14'],
    ntReferences: ['Mateus 2:1-12'],
    orderIndex,
  });
}

describe('cards-cache — list', () => {
  it('miss → DB + set; segundo hit', async () => {
    const db = await getTestDb();
    await seedCard(db, 'a', 1);
    await seedCard(db, 'b', 2);
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    const first = await cache.list();
    expect(first.map((c) => c.slug)).toEqual(['a', 'b']);

    const keys = await redis.keys('cc:v1:cards:v0:list');
    expect(keys).toHaveLength(1);

    // hit: não deve tocar na DB. Truncar a DB e verificar que ainda devolve.
    await truncateAll();
    const second = await cache.list();
    expect(second.map((c) => c.slug)).toEqual(['a', 'b']);
  });

  it('lista vazia NÃO é cacheada', async () => {
    const db = await getTestDb();
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    await cache.list();
    const keys = await redis.keys('cc:v1:cards:v*:list');
    expect(keys).toHaveLength(0);
  });

  it('após invalidate, próxima list usa nova versão', async () => {
    const db = await getTestDb();
    await seedCard(db, 'a', 1);
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    await cache.list();
    const v0Keys = await redis.keys('cc:v1:cards:v0:list');
    expect(v0Keys).toHaveLength(1);

    await seedCard(db, 'b', 2);
    const v = await cache.invalidate();
    expect(v).toBeGreaterThan(0);

    const after = await cache.list();
    expect(after.map((c) => c.slug)).toEqual(['a', 'b']);
    const v1Keys = await redis.keys(`cc:v1:cards:v${v}:list`);
    expect(v1Keys).toHaveLength(1);
  });
});

describe('cards-cache — bySlug', () => {
  it('miss → DB + set; segundo hit', async () => {
    const db = await getTestDb();
    await seedCard(db, 'natal', 1);
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    const first = await cache.bySlug('natal');
    expect(first?.slug).toBe('natal');

    const keys = await redis.keys('cc:v1:cards:v0:item:natal');
    expect(keys).toHaveLength(1);

    await truncateAll();
    const second = await cache.bySlug('natal');
    expect(second?.slug).toBe('natal');
  });

  it('inexistente devolve null e NÃO cacheia', async () => {
    const db = await getTestDb();
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    expect(await cache.bySlug('nao-existe')).toBeNull();
    const keys = await redis.keys('cc:v1:cards:v*:item:*');
    expect(keys).toHaveLength(0);
  });
});

describe('cards-cache — fail-open sem Redis', () => {
  it('list devolve da DB quando redis=null', async () => {
    const db = await getTestDb();
    await seedCard(db, 'offline', 1);
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis: null, cards: cardsRepo(db), logger });

    const result = await cache.list();
    expect(result.map((c) => c.slug)).toEqual(['offline']);
  });

  it('bySlug devolve da DB quando redis=null', async () => {
    const db = await getTestDb();
    await seedCard(db, 'offline', 1);
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis: null, cards: cardsRepo(db), logger });

    const result = await cache.bySlug('offline');
    expect(result?.slug).toBe('offline');
  });

  it('invalidate é noop quando redis=null', async () => {
    const db = await getTestDb();
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis: null, cards: cardsRepo(db), logger });

    expect(await cache.invalidate()).toBe(0);
  });
});

describe('cards-cache — UTF-8', () => {
  it('preserva caracteres PT através da cache', async () => {
    const db = await getTestDb();
    await cardsRepo(db).create({
      slug: 'pt-utf8',
      title: 'O Nascimento de Jesus — O Verbo se fez carne',
      gospelReference: 'João 1',
      summary: 'A graça e a verdade vieram por Jesus Cristo.',
      otReferences: ['Isaías 7:14'],
      ntReferences: ['João 1:14'],
      orderIndex: 1,
    });
    const { logger } = makeLogger();
    const cache = createCardsCache({ redis, cards: cardsRepo(db), logger });

    const first = await cache.bySlug('pt-utf8');
    expect(first?.title).toContain('—');

    // hit (forçar via cache, truncar DB)
    await truncateAll();
    const second = await cache.bySlug('pt-utf8');
    expect(second?.title).toContain('—');
    expect(second?.summary).toContain('graça');
  });
});