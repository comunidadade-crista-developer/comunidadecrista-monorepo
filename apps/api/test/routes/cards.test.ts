import request from 'supertest';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { cardsRepo } from '../../src/repositories/cards.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  APP_VERSION: 'test',
});

describe('GET /gospel-cards', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;

  beforeAll(async () => {
    await getTestDb();
    redis = new Redis(process.env.REDIS_URL!);
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
    const keys = await redis.keys('cc:v1:cards:*');
    if (keys.length) await redis.del(...keys);
    const rlKeys = await redis.keys('rl:cards*');
    if (rlKeys.length) await redis.del(...rlKeys);
  });

  async function seed(count: number) {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    for (let i = 1; i <= count; i++) {
      await repo.create({
        slug: `card-${String(i).padStart(3, '0')}`,
        title: `Card ${i}`,
        gospelReference: 'Mateus 2',
        summary: 'Resumo',
        otReferences: [],
        ntReferences: [],
        orderIndex: i,
      });
    }
  }

  it('lista vazia quando DB vazia', async () => {
    const res = await request(app.server).get('/gospel-cards');
    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([]);
    expect(res.headers['cache-control']).toContain('public');
  });

  it('devolve cards ordenados por orderIndex', async () => {
    await seed(3);
    const res = await request(app.server).get('/gospel-cards');
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(3);
    expect(res.body.cards.map((c: { orderIndex: number }) => c.orderIndex)).toEqual([1, 2, 3]);
  });

  it('não expõe id nem createdAt', async () => {
    await seed(1);
    const res = await request(app.server).get('/gospel-cards');
    const card = res.body.cards[0];
    expect(card).not.toHaveProperty('id');
    expect(card).not.toHaveProperty('createdAt');
    expect(card).toHaveProperty('slug');
    expect(card).toHaveProperty('title');
  });

  it('trunca a 200 cards se houver mais', async () => {
    await seed(2);
    const res = await request(app.server).get('/gospel-cards');
    expect(res.body.cards.length).toBeLessThanOrEqual(200);
  });
});

describe('GET /gospel-cards/:slug', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;

  beforeAll(async () => {
    await getTestDb();
    redis = new Redis(process.env.REDIS_URL!);
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
    const keys = await redis.keys('cc:v1:cards:*');
    if (keys.length) await redis.del(...keys);
    const rlKeys = await redis.keys('rl:cards*');
    if (rlKeys.length) await redis.del(...rlKeys);
  });

  it('devolve o card', async () => {
    const db = await getTestDb();
    await cardsRepo(db).create({
      slug: 'natal',
      title: 'Natal',
      gospelReference: 'Mateus 2',
      summary: 'Resumo',
      otReferences: ['Isaías 7:14'],
      ntReferences: ['Mateus 2:1-12'],
      orderIndex: 1,
    });
    const res = await request(app.server).get('/gospel-cards/natal');
    expect(res.status).toBe(200);
    expect(res.body.card.slug).toBe('natal');
    expect(res.body.card.otReferences).toEqual(['Isaías 7:14']);
  });

  it('404 para slug inexistente', async () => {
    const res = await request(app.server).get('/gospel-cards/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('400 para slug inválido', async () => {
    const res = await request(app.server).get('/gospel-cards/slug%20com%20espacos');
    expect(res.status).toBe(400);
  });
});

describe('GET /gospel-cards — rate limit', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let redis: Redis;
  const strictEnv = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    APP_VERSION: 'test',
  });

  beforeAll(async () => {
    await getTestDb();
    redis = new Redis(process.env.REDIS_URL!);
    app = await buildServer({ env: strictEnv });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeTestDb();
  });
  beforeEach(async () => {
    const rlKeys = await redis.keys('rl:cards*');
    if (rlKeys.length) await redis.del(...rlKeys);
  });

  it('31 pedidos em <60s → 429 com Retry-After', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await request(app.server).get('/gospel-cards');
      expect(r.status).toBe(200);
    }
    const blocked = await request(app.server).get('/gospel-cards');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});