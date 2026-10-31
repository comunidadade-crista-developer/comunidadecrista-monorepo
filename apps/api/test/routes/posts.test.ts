// esqueleto — cobre auth, criação, feed, like, report
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { cardsRepo } from '../../src/repositories/cards.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makePost, makeUser, makeUserWithPassword } from '../helpers/factories.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', APP_VERSION: 'test' });

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
  const k = await redis.keys('cc:v1:feed:*');
  if (k.length) await redis.del(...k);
  const r = await redis.keys('rl:*');
  if (r.length) await redis.del(...r);
});

async function loginToken(username: string, password: string): Promise<string> {
  const r = await request(app.server).post('/auth/login').send({ username, password });
  return r.body.accessToken as string;
}

const IDEM = () => `idem-${crypto.randomUUID()}`;

describe('GET /posts', () => {
  it('anónimo: só published', async () => {
    const u = await makeUser();
    await makePost(u.id, { status: 'published', title: 'P' });
    await makePost(u.id, { status: 'pending_review', title: 'R' });
    const r = await request(app.server).get('/posts');
    expect(r.status).toBe(200);
    expect(r.body.posts.map((p: { title: string }) => p.title)).toEqual(['P']);
  });

  it('filtro gospelCardId', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const card = await cardsRepo(db).create({
      slug: 'natal', title: 'Natal', gospelReference: 'Mt 2', summary: 'x',
      otReferences: [], ntReferences: [], orderIndex: 1,
    });
    await makePost(u.id, { gospelCardId: card.id, title: 'A' });
    await makePost(u.id, { title: 'B' }); // sem card
    const r = await request(app.server).get(`/posts?gospelCardId=${card.id}`);
    expect(r.body.posts.map((p: { title: string }) => p.title)).toEqual(['A']);
  });

  it('filter=liked anónimo → 401', async () => {
    const r = await request(app.server).get('/posts?filter=liked');
    expect(r.status).toBe(401);
  });

  it('filter=liked autenticado → só os curtidos', async () => {
    const author = await makeUser();
    const { user: viewer, plainPassword } = await makeUserWithPassword();
    const p = await makePost(author.id, { title: 'Curtido' });
    await makePost(author.id, { title: 'Não curtido' });
    const token = await loginToken(viewer.username, plainPassword);
    await request(app.server).post(`/posts/${p.id}/like`).set('Authorization', `Bearer ${token}`);
    const r = await request(app.server)
      .get('/posts?filter=liked')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.posts).toHaveLength(1);
    expect(r.body.posts[0].title).toBe('Curtido');
    expect(r.body.posts[0].isLiked).toBe(true);
  });

  it('filtro recent põe o próprio post primeiro', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const other = await makeUser();
    await makePost(other.id, { title: 'Outro' });
    await makePost(user.id, { title: 'Meu', status: 'published' });
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .get('/posts?filter=recent')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.posts[0].title).toBe('Meu');
    expect(r.body.posts[0].isLiked).toBe(false);
  });

  it('filtro recent põe pending_review do próprio primeiro', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    await makePost(user.id, { title: 'Pendente', status: 'pending_review' });
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.posts[0].title).toBe('Pendente');
    expect(r.body.posts[0].status).toBe('pending_review');
  });
});

describe('POST /posts', () => {
  it('sem idempotency-key → 400', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'entendimento', title: 'T', content: 'C' });
    expect(r.status).toBe(400);
  });

  it('cria + idempotência (2 posts, mesma resposta)', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const token = await loginToken(user.username, plainPassword);
    const key = IDEM();
    const body = { category: 'entendimento', title: 'T', content: 'C' };
    const first = await request(app.server)
      .post('/posts').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
    const second = await request(app.server)
      .post('/posts').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.post.id).toBe(first.body.post.id);
  });

  it('gospelCardSlug inválido → 400', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .post('/posts').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', IDEM())
      .send({ category: 'entendimento', title: 'T', content: 'C', gospelCardSlug: 'nao-existe' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /posts/:id', () => {
  it('não autor → 403', async () => {
    const author = await makeUser();
    const post = await makePost(author.id);
    const { user, plainPassword } = await makeUserWithPassword();
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .delete(`/posts/${post.id}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('autor → 200', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(user.id);
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .delete(`/posts/${post.id}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST/DELETE /posts/:id/like', () => {
  it('like único incrementa; duplicado é idempotente', async () => {
    const author = await makeUser();
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(author.id);
    const token = await loginToken(user.username, plainPassword);

    const a = await request(app.server)
      .post(`/posts/${post.id}/like`).set('Authorization', `Bearer ${token}`);
    expect(a.body.likesCount).toBe(1);

    const b = await request(app.server)
      .post(`/posts/${post.id}/like`).set('Authorization', `Bearer ${token}`);
    expect(b.body.likesCount).toBe(1);
  });

  it('unlike decrementa', async () => {
    const author = await makeUser();
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(author.id);
    const token = await loginToken(user.username, plainPassword);

    await request(app.server).post(`/posts/${post.id}/like`).set('Authorization', `Bearer ${token}`);
    const r = await request(app.server)
      .delete(`/posts/${post.id}/like`).set('Authorization', `Bearer ${token}`);
    expect(r.body.likesCount).toBe(0);
    expect(r.body.isLiked).toBe(false);
  });
});

describe('POST /posts/:id/report', () => {
  it('created', async () => {
    const author = await makeUser();
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(author.id);
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server)
      .post(`/posts/${post.id}/report`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'impróprio' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('created');
  });

  it('duplicate', async () => {
    const author = await makeUser();
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(author.id);
    const token = await loginToken(user.username, plainPassword);
    await request(app.server).post(`/posts/${post.id}/report`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'motivo de teste' });
    const r = await request(app.server).post(`/posts/${post.id}/report`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'motivo de teste' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('duplicate');
  });

  it('own_post → 400', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const post = await makePost(user.id);
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server).post(`/posts/${post.id}/report`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'motivo de teste' });
    expect(r.status).toBe(400);
    expect(r.body.outcome).toBe('own_post');
  });

  it('post_not_found → 404', async () => {
    const { user, plainPassword } = await makeUserWithPassword();
    const token = await loginToken(user.username, plainPassword);
    const r = await request(app.server).post(`/posts/${crypto.randomUUID()}/report`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'motivo de teste' });
    expect(r.status).toBe(404);
    expect(r.body.outcome).toBe('post_not_found');
  });
});