import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cardsRepo } from '../../src/repositories/cards.js';
import { closeTestDb, getTestDb, truncateAll } from '../helpers/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

function sample(slug: string, orderIndex: number) {
  return {
    slug,
    title: `Card ${slug}`,
    gospelReference: 'Mateus 2',
    summary: 'Resumo de teste.',
    otReferences: ['Isaías 7:14'],
    ntReferences: ['Mateus 2:1-12'],
    orderIndex,
  };
}

describe('cardsRepo', () => {
  it('create + list ordenado por orderIndex', async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.create(sample('terceiro', 3));
    await repo.create(sample('primeiro', 1));
    await repo.create(sample('segundo', 2));
    const all = await repo.list();
    expect(all.map((c) => c.slug)).toEqual(['primeiro', 'segundo', 'terceiro']);
  });

  it('findBySlug devolve null para inexistente', async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    expect(await repo.findBySlug('nao-existe')).toBeNull();
  });

  it('slug é único', async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.create(sample('duplicado', 1));
    await expect(repo.create(sample('duplicado', 2))).rejects.toThrow();
  });

  it('upsertBySlug corre 2x sem duplicar', async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.upsertBySlug(sample('unico', 1));
    await repo.upsertBySlug({ ...sample('unico', 2), title: 'Actualizado' });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('Actualizado');
    expect(all[0]!.orderIndex).toBe(2);
  });
});