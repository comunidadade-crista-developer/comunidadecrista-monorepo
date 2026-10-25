import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeUserWithPassword } from '../helpers/factories.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

describe('recover flow', () => {
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

  it('recover via código: verify → reset → login com nova password', async () => {
    const { user, recoveryCode } = await makeUserWithPassword({ username: 'recover1' });

    const v = await request(app.server).post('/auth/recover/verify').send({
      mode: 'code',
      username: 'recover1',
      code: recoveryCode,
    });
    expect(v.status).toBe(200);
    expect(v.body.recoverySession).toBeTruthy();

    const r = await request(app.server).post('/auth/recover/reset').send({
      recoverySession: v.body.recoverySession,
      newPassword: 'novasenha99',
      newPasswordConfirmation: 'novasenha99',
    });
    expect(r.status).toBe(200);
    expect(r.body.recoveryCode).toMatch(/^[A-Z2-7-]+$/);
    expect(r.body.recoveryCode).not.toBe(recoveryCode); // novo código

    // login com nova password
    const l = await request(app.server)
      .post('/auth/login')
      .send({ username: 'recover1', password: 'novasenha99' });
    expect(l.status).toBe(200);
    expect(l.body.user.id).toBe(user.id);
  });

  it('recover via perguntas: verify → reset', async () => {
    const { answers } = await makeUserWithPassword({ username: 'recover2' });
    const v = await request(app.server).post('/auth/recover/verify').send({
      mode: 'questions',
      username: 'recover2',
      answer1: answers.q1,
      answer2: answers.q2,
      answer3: answers.q3,
    });
    expect(v.status).toBe(200);
    expect(v.body.recoverySession).toBeTruthy();
  });

  it('respostas normalizadas (case + espaços)', async () => {
    const { answers } = await makeUserWithPassword({ username: 'recover3' });
    const v = await request(app.server).post('/auth/recover/verify').send({
      mode: 'questions',
      username: 'recover3',
      answer1: `  ${answers.q1.toUpperCase()}  `,
      answer2: answers.q2,
      answer3: `  ${answers.q3.toLowerCase()}  `,
    });
    expect(v.status).toBe(200);
  });

  it('código errado → 401', async () => {
    await makeUserWithPassword({ username: 'recover4' });
    const v = await request(app.server).post('/auth/recover/verify').send({
      mode: 'code',
      username: 'recover4',
      code: 'AAAA-BBBB-CCCC-DDDD',
    });
    expect(v.status).toBe(401);
    expect(v.body.error).toBe('invalid_recovery');
  });

  it('após reset, código antigo não funciona mais', async () => {
    const { recoveryCode } = await makeUserWithPassword({ username: 'recover5' });
    const v = await request(app.server).post('/auth/recover/verify').send({
      mode: 'code',
      username: 'recover5',
      code: recoveryCode,
    });
    await request(app.server).post('/auth/recover/reset').send({
      recoverySession: v.body.recoverySession,
      newPassword: 'novasenha77',
      newPasswordConfirmation: 'novasenha77',
    });
    const again = await request(app.server).post('/auth/recover/verify').send({
      mode: 'code',
      username: 'recover5',
      code: recoveryCode,
    });
    expect(again.status).toBe(401);
  });

  it('reset com sessão inválida → 401', async () => {
    const r = await request(app.server).post('/auth/recover/reset').send({
      recoverySession: 'inventado',
      newPassword: 'qualquer123',
      newPasswordConfirmation: 'qualquer123',
    });
    expect(r.status).toBe(401);
  });
});