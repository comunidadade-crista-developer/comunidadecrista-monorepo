import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJwtService } from '../../src/auth/jwt.js';
import { requireAdmin, requireAuth } from '../../src/auth/middleware.js';
import { loadEnv } from '../../src/env.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeUser, makeUserWithPassword } from '../helpers/factories.js';
import Fastify from 'fastify';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

describe('middleware requireAuth + requireAdmin', () => {
  let jwt: Awaited<ReturnType<typeof createJwtService>>;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await getTestDb();
    jwt = await createJwtService(env);
    const db = await getTestDb();
    app = Fastify();
    app.get('/protected', { preHandler: requireAuth(jwt) }, async (req) => ({
      userId: req.user!.id,
    }));
    app.get('/admin', { preHandler: [requireAuth(jwt), requireAdmin(db)] }, async () => ({
      ok: true,
    }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('sem Authorization → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('token válido → 200', async () => {
    const { user } = await makeUserWithPassword();
    const token = await jwt.signAccessToken({ sub: user.id, role: user.role });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).userId).toBe(user.id);
  });

  it('requireAdmin: user comum → 403', async () => {
    const { user } = await makeUserWithPassword({ role: 'user' });
    const token = await jwt.signAccessToken({ sub: user.id, role: 'user' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requireAdmin: admin → 200', async () => {
    const { user } = await makeUserWithPassword({ role: 'admin' });
    const token = await jwt.signAccessToken({ sub: user.id, role: 'admin' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('requireAdmin: JWT diz admin mas DB diz user → 403 (protecção stale)', async () => {
    const user = await makeUser({ role: 'user' });
    // Assina como se fosse admin (simula JWT antigo)
    const token = await jwt.signAccessToken({ sub: user.id, role: 'admin' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});