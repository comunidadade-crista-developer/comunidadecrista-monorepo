import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeUserWithPassword } from '../helpers/factories.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

describe('POST /auth/login', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await getTestDb();
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('login válido devolve tokens + user', async () => {
    const { user, plainPassword } = await makeUserWithPassword({ username: 'ana' });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ username: 'ana', password: plainPassword });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('password errada → 401', async () => {
    await makeUserWithPassword({ username: 'rui' });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ username: 'rui', password: 'errada123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('username inexistente → 401 (mesma resposta)', async () => {
    const res = await request(app.server)
      .post('/auth/login')
      .send({ username: 'ninguem', password: 'qualquer123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('case-insensitive no username', async () => {
    const { plainPassword } = await makeUserWithPassword({ username: 'Carla' });
    const res = await request(app.server)
      .post('/auth/login')
      .send({ username: 'CARLA', password: plainPassword });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/login — rate limit', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const strictEnv = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    APP_VERSION: 'test',
    RATE_LIMIT_LOGIN_MAX: 3,
  });

  beforeAll(async () => {
    await getTestDb();
    // limpar limites anteriores
    const redis = new (await import('ioredis')).Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('rl:login:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    app = await buildServer({ env: strictEnv });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('após 3 falhas, 4ª tentativa → 429 mesmo com password correcta', async () => {
    await makeUserWithPassword({ username: 'rluser' });
    for (let i = 0; i < 3; i++) {
      await request(app.server)
        .post('/auth/login')
        .send({ username: 'rluser', password: 'errada000' });
    }
    const res = await request(app.server)
      .post('/auth/login')
      .send({ username: 'rluser', password: 'password123' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});