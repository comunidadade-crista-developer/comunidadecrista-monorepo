import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFeedCache } from '../../src/cache/feed-cache.js';
// import { postsRepo } from '../../src/repositories/posts.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makePost, makeUser } from '../helpers/factories.js';

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
  const keys = await redis.keys('cc:v1:feed:*');
  if (keys.length) await redis.del(...keys);
});

function makeLogger() {
  const logs: Array<{ obj: unknown; msg: string }> = [];
  return {
    logger: { warn: (obj: unknown, msg: string) => { logs.push({ obj, msg }); } },
    logs,
  };
}

describe('feed-cache', () => {
  it('miss → DB + set; segundo hit com mesmo payload', async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await makePost(user.id, { title: 'A' });
    await makePost(user.id, { title: 'B' });
    const { logger } = makeLogger();
    const cache = createFeedCache({ redis, db, logger });

    const first = await cache.list({ filter: 'recent', limit: 10 });
    expect(first.cacheHit).toBe(false);
    expect(first.items).toHaveLength(2);

    const keys = await redis.keys('cc:v1:feed:*');
    expect(keys.length).toBeGreaterThan(0);

    await truncateAll();
    const second = await cache.list({ filter: 'recent', limit: 10 });
    expect(second.cacheHit).toBe(true);
    expect(second.items).toHaveLength(2);
  });

  it('invalidate remove todas as chaves de feed', async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await makePost(user.id);
    const { logger } = makeLogger();
    const cache = createFeedCache({ redis, db, logger });

    await cache.list({ filter: 'recent', limit: 10 });
    await cache.list({ filter: 'top', limit: 10 });
    const before = await redis.keys('cc:v1:feed:*');
    expect(before.length).toBeGreaterThanOrEqual(2);

    const removed = await cache.invalidate();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await redis.keys('cc:v1:feed:*')).toHaveLength(0);
  });

  it('lista vazia NÃO é cacheada', async () => {
    const db = await getTestDb();
    const { logger } = makeLogger();
    const cache = createFeedCache({ redis, db, logger });
    await cache.list({ filter: 'recent', limit: 10 });
    expect(await redis.keys('cc:v1:feed:*')).toHaveLength(0);
  });

  it('filtros distintos → chaves distintas', async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await makePost(user.id);
    const { logger } = makeLogger();
    const cache = createFeedCache({ redis, db, logger });

    await cache.list({ filter: 'recent', limit: 10 });
    await cache.list({ filter: 'top', limit: 10 });
    const keys = await redis.keys('cc:v1:feed:*');
    const hasRecent = keys.some((k) => k.includes(':recent:'));
    const hasTop = keys.some((k) => k.includes(':top:'));
    expect(hasRecent && hasTop).toBe(true);
  });

  it('fallback sem Redis → DB sem cache', async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await makePost(user.id);
    const { logger } = makeLogger();
    const cache = createFeedCache({ redis: null, db, logger });

    const result = await cache.list({ filter: 'recent', limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.cacheHit).toBe(false);
    expect(await cache.invalidate()).toBe(0);
  });
});