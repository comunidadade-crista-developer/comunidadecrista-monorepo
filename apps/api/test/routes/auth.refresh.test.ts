import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeUserWithPassword } from '../helpers/factories.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

async function login(app: Awaited<ReturnType<typeof buildServer>>, username: string, password: string) {
  const res = await request(app.server).post('/auth/login').send({ username, password });
  return res.body.refreshToken as string;
}

describe('POST /auth/refresh', () => {
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

  it('refresh válido devolve novo par de tokens', async () => {
    const { plainPassword } = await makeUserWithPassword({ username: 'paula' });
    const refresh = await login(app, 'paula', plainPassword);
    const res = await request(app.server).post('/auth/refresh').send({ refreshToken: refresh });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refresh);
  });

  it('reuso do token antigo → 401 + revoga família', async () => {
    const { plainPassword } = await makeUserWithPassword({ username: 'reuse' });
    const refresh1 = await login(app, 'reuse', plainPassword);
    const r1 = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(r1.status).toBe(200);
    const refresh2 = r1.body.refreshToken as string;

    // Reuso do refresh1 (já usado)
    const r2 = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(r2.status).toBe(401);
    expect(r2.body.error).toBe('token_reuse');

    // refresh2 também deve estar revogado (família inteira)
    const r3 = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: refresh2 });
    expect(r3.status).toBe(401);
  });

  it('refresh desconhecido → 401', async () => {
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: 'inventado' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_refresh');
  });
});