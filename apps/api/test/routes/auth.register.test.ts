import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    username: `user${Math.floor(Math.random() * 1e9)}`,
    password: 'password123',
    passwordConfirmation: 'password123',
    securityQ1: 'Azul',
    securityQ2: '7',
    securityQ3: 'Igreja da Graça',
    ...overrides,
  };
}

describe('POST /auth/register', () => {
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

  it('cria conta e devolve tokens + recoveryCode', async () => {
    const body = validBody({ username: 'maria' });
    const res = await request(app.server).post('/auth/register').send(body);
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('maria');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.recoveryCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(res.body.recoveryCodeWarning).toContain('Guarda');
  });

  it('username duplicado → 409 (case-insensitive)', async () => {
    await request(app.server).post('/auth/register').send(validBody({ username: 'joao' }));
    const res = await request(app.server)
      .post('/auth/register')
      .send(validBody({ username: 'JOAO' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('username_taken');
  });

  it('password < 6 → 400', async () => {
    const res = await request(app.server)
      .post('/auth/register')
      .send(validBody({ password: '12345', passwordConfirmation: '12345' }));
    expect(res.status).toBe(400);
  });

  it('password ≠ confirmação → 400', async () => {
    const res = await request(app.server)
      .post('/auth/register')
      .send(validBody({ passwordConfirmation: 'outra-coisa' }));
    expect(res.status).toBe(400);
  });

  it('securityQ2 não numérico → 400', async () => {
    const res = await request(app.server)
      .post('/auth/register')
      .send(validBody({ securityQ2: 'abc' }));
    expect(res.status).toBe(400);
  });

  it('recovery code persistido como hash (não plaintext)', async () => {
    const res = await request(app.server)
      .post('/auth/register')
      .send(validBody({ username: 'hashcheck' }));
    const db = await getTestDb();
    const rows = await db.execute<{ recovery_code_hash: string }>(
      (await import('drizzle-orm')).sql`SELECT recovery_code_hash FROM users WHERE username = 'hashcheck'`,
    );
    const stored = rows.rows[0]!.recovery_code_hash;
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain(res.body.recoveryCode);
  });
});