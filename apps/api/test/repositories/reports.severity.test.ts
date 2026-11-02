import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { posts } from '../../src/db/schema.js';
import {
  DEFAULT_THRESHOLDS,
  REPORTER_MIN_AGE_DAYS,
  reportsRepo,
} from '../../src/repositories/reports.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makePost, makeUser } from '../helpers/factories.js';

const DAY_MS = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeTestDb();
});

async function makeValidReporter() {
  const u = await makeUser({
    createdAt: new Date(Date.now() - (REPORTER_MIN_AGE_DAYS + 1) * DAY_MS),
  });
  await makePost(u.id);
  return u;
}

async function status(id: string) {
  const db = await getTestDb();
  const [row] = await db.select({ s: posts.status }).from(posts).where(eq(posts.id, id));
  return row!.s;
}

describe('escalonamento por severidade', () => {
  it('10 spam → pending_review', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < DEFAULT_THRESHOLDS.basic; i++) {
      const rep = await makeValidReporter();
      const r = await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'spam',
        reason: 'x',
      });
      expect(r.outcome).toBe('created');
    }
    expect(await status(post.id)).toBe('pending_review');
  });

  it('5 offensive → pending_review', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < DEFAULT_THRESHOLDS.medium; i++) {
      const rep = await makeValidReporter();
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'offensive',
        reason: 'x',
      });
    }
    expect(await status(post.id)).toBe('pending_review');
  });

  it('2 doctrine → pending_review', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < DEFAULT_THRESHOLDS.high; i++) {
      const rep = await makeValidReporter();
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'doctrine',
        reason: 'x',
      });
    }
    expect(await status(post.id)).toBe('pending_review');
  });

  it('9 spam + 1 doctrine = não escala (spam 9<10, doctrine 1<2)', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < 9; i++) {
      const rep = await makeValidReporter();
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'spam',
        reason: 'x',
      });
    }
    const rep = await makeValidReporter();
    await reportsRepo(db).file({
      postId: post.id,
      reporterId: rep.id,
      category: 'doctrine',
      reason: 'x',
    });
    expect(await status(post.id)).toBe('published');
  });

  it('9 spam + 2 doctrine = escala (doctrine atinge 2)', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < 9; i++) {
      const rep = await makeValidReporter();
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'spam',
        reason: 'x',
      });
    }
    for (let i = 0; i < 2; i++) {
      const rep = await makeValidReporter();
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'doctrine',
        reason: 'x',
      });
    }
    expect(await status(post.id)).toBe('pending_review');
  });

  it('validReportsBySeverity é devolvido e cumulativo', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const r1 = await makeValidReporter();
    const r2 = await makeValidReporter();
    const r3 = await makeValidReporter();

    const a = await repo.file({ postId: post.id, reporterId: r1.id, category: 'spam', reason: 'x' });
    const b = await repo.file({ postId: post.id, reporterId: r2.id, category: 'offensive', reason: 'x' });
    const c = await repo.file({ postId: post.id, reporterId: r3.id, category: 'doctrine', reason: 'x' });

    expect(a.outcome === 'created' && a.validReportsBySeverity).toEqual({ basic: 1, medium: 0, high: 0 });
    expect(b.outcome === 'created' && b.validReportsBySeverity).toEqual({ basic: 1, medium: 1, high: 0 });
    expect(c.outcome === 'created' && c.validReportsBySeverity).toEqual({ basic: 1, medium: 1, high: 1 });
  });

  it('thresholds customizados', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const rep = await makeValidReporter();
    const r = await reportsRepo(db).file(
      { postId: post.id, reporterId: rep.id, category: 'doctrine', reason: 'x' },
      { thresholds: { high: 1 } },
    );
    expect(r.outcome === 'created' && r.escalated).toBe(true);
    expect(await status(post.id)).toBe('pending_review');
  });

  it('contas novas não contam para severidade', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    // 2 reportes doctrine de contas novas: não escalam
    for (let i = 0; i < 2; i++) {
      const rep = await makeUser(); // conta nova
      await makePost(rep.id);
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'doctrine',
        reason: 'x',
      });
    }
    expect(await status(post.id)).toBe('published');
  });

  it('denúncia de conta antiga sem posts não conta para doutrina', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < 2; i++) {
      const rep = await makeUser({ createdAt: new Date(Date.now() - 30 * DAY_MS) });
      await reportsRepo(db).file({
        postId: post.id,
        reporterId: rep.id,
        category: 'doctrine',
        reason: 'x',
      });
    }
    expect(await status(post.id)).toBe('published');
  });
});