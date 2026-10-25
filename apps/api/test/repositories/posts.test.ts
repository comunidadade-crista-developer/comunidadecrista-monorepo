import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postLikesRepo, postsRepo } from '../../src/repositories/posts.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makeLike, makePost, makeUser } from '../helpers/factories.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe('postsRepo — create/find/delete', () => {
  it('create publica e preenche publishedAt', async () => {
    const u = await makeUser();
    const p = await makePost(u.id, { status: 'published' });
    expect(p.publishedAt).toBeInstanceOf(Date);
  });

  it('create pending_review não preenche publishedAt', async () => {
    const u = await makeUser();
    const p = await makePost(u.id, { status: 'pending_review' });
    expect(p.publishedAt).toBeNull();
  });

  it('delete remove', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p = await makePost(u.id);
    await postsRepo(db).delete(p.id);
    expect(await postsRepo(db).findById(p.id)).toBeNull();
  });
});

describe('postsRepo — feed', () => {
  it('filtro recent devolve por created_at desc', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const a = await makePost(u.id, { title: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await makePost(u.id, { title: 'B' });
    const { items } = await postsRepo(db).list({ filter: 'recent' });
    expect(items.map((p) => p.title)).toEqual(['B', 'A']);
    expect(items[0]!.id).toBe(b.id);
    expect(items[1]!.id).toBe(a.id);
  });

  it('filtro recent respeita cursor pagination', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    for (let i = 0; i < 5; i++) {
      await makePost(u.id, { title: `P${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const page1 = await postsRepo(db).list({ filter: 'recent', limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await postsRepo(db).list({
      filter: 'recent',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(2);
    const ids1 = new Set(page1.items.map((p) => p.id));
    const overlap = page2.items.filter((p) => ids1.has(p.id));
    expect(overlap).toHaveLength(0);
  });

  it('filtro top ordena por likesCount', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p1 = await makePost(u.id, { title: 'Poucos' });
    const p2 = await makePost(u.id, { title: 'Muitos' });
    for (let i = 0; i < 3; i++) {
      const l = await makeUser();
      await makeLike(p2.id, l.id);
    }
    const { items } = await postsRepo(db).list({ filter: 'top' });
    expect(items[0]!.id).toBe(p2.id);
    expect(items[1]!.id).toBe(p1.id);
  });

  it('filtro liked devolve só os que o viewer amou', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const p1 = await makePost(author.id, { title: 'Amado' });
    const p2 = await makePost(author.id, { title: 'Não amado' });
    await makeLike(p1.id, viewer.id);
    const { items } = await postsRepo(db).list({ filter: 'liked', viewerId: viewer.id });
    expect(items.map((p) => p.id)).toEqual([p1.id]);
    expect(items.map((p) => p.id)).not.toContain(p2.id);
  });

  it('esconde posts que não estão published', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    await makePost(u.id, { status: 'published', title: 'Público' });
    await makePost(u.id, { status: 'pending_review', title: 'Oculto' });
    await makePost(u.id, { status: 'hidden', title: 'Oculto2' });
    const { items } = await postsRepo(db).list({ filter: 'recent' });
    expect(items.map((p) => p.title)).toEqual(['Público']);
  });
});

describe('postsRepo — contadores', () => {
  it('incrementLikes soma e não desce abaixo de 0', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p = await makePost(u.id);
    const repo = postsRepo(db);
    expect(await repo.incrementLikes(p.id, 1)).toBe(1);
    expect(await repo.incrementLikes(p.id, 1)).toBe(2);
    expect(await repo.incrementLikes(p.id, -1)).toBe(1);
    expect(await repo.incrementLikes(p.id, -1)).toBe(0);
  });
});

describe('postLikesRepo', () => {
  it('like é idempotente', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const viewer = await makeUser();
    const p = await makePost(u.id);
    const repo = postLikesRepo(db);
    expect(await repo.like(p.id, viewer.id)).toBe(true);
    expect(await repo.like(p.id, viewer.id)).toBe(false);
  });

  it('unlike remove', async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const viewer = await makeUser();
    const p = await makePost(u.id);
    const repo = postLikesRepo(db);
    await repo.like(p.id, viewer.id);
    expect(await repo.unlike(p.id, viewer.id)).toBe(true);
    expect(await repo.unlike(p.id, viewer.id)).toBe(false);
  });
});