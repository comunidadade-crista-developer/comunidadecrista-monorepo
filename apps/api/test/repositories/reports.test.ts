import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { moderationLogRepo, reportsRepo } from '../../src/repositories/reports.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';
import { makePost, makeUser } from '../helpers/factories.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe('reportsRepo.file — unicidade', () => {
  it('create é único por (post, reporter)', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const p = await makePost(author.id);
    const repo = reportsRepo(db);

    const first = await repo.file({
      postId: p.id,
      reporterId: reporter.id,
      category: 'spam',
      reason: 'conteúdo impróprio',
    });
    expect(first.outcome).toBe('created');

    const dup = await repo.file({
      postId: p.id,
      reporterId: reporter.id,
      category: 'spam',
      reason: 'outro motivo',
    });
    expect(dup.outcome).toBe('duplicate');
  });
});

describe('reportsRepo.cancel', () => {
  it('cancel remove apenas do próprio reporter', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const r1 = await makeUser();
    const r2 = await makeUser();
    const p = await makePost(author.id);
    const repo = reportsRepo(db);
    const report = await repo.file({
      postId: p.id,
      reporterId: r1.id,
      category: 'spam',
      reason: 'x',
    });
    if (report.outcome !== 'created') throw new Error('esperava created');

    expect(await repo.cancel(report.report.id, r2.id)).toBe(false);
    expect(await repo.cancel(report.report.id, r1.id)).toBe(true);
  });
});

describe('reportsRepo.countOpenByPost', () => {
  it('conta só abertas', async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const p = await makePost(author.id);
    const repo = reportsRepo(db);
    for (let i = 0; i < 3; i++) {
      const r = await makeUser();
      await repo.file({
        postId: p.id,
        reporterId: r.id,
        category: 'spam',
        reason: 'x',
      });
    }
    expect(await repo.countOpenByPost(p.id)).toBe(3);
    await repo.resolveAllForPost(p.id, 'resolved_kept', author.id);
    expect(await repo.countOpenByPost(p.id)).toBe(0);
  });
});

describe('moderationLogRepo', () => {
  it('create + listByPost', async () => {
    const db = await getTestDb();
    const moderator = await makeUser({ role: 'admin' });
    const author = await makeUser();
    const p = await makePost(author.id);
    const repo = moderationLogRepo(db);
    await repo.create({
      postId: p.id,
      moderatorId: moderator.id,
      action: 'approved',
      reason: null,
    });
    const logs = await repo.listByPost(p.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('approved');
  });
});