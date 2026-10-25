import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeUserWithPassword } from '../helpers/factories.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

describe('GET /auth/me', () => {
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

  it('devolve o utilizador autenticado', async () => {
    const { user, plainPassword } = await makeUserWithPassword({ username: 'meuser' });
    const login = await request(app.server)
      .post('/auth/login')
      .send({ username: 'meuser', password: plainPassword });
    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.username).toBe('meuser');
    expect(res.body.user.role).toBe('user');
  });

  it('sem token → 401', async () => {
    const res = await request(app.server).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  it('token inválido → 401', async () => {
    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', 'Bearer invalido');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});