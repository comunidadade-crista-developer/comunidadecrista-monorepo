import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cardsRepo } from "../../src/repositories/cards.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";

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
    gospelReference: "Mateus 2",
    summary: "Resumo de teste.",
    otReferences: ["Isaías 7:14"],
    ntReferences: ["Mateus 2:1-12"],
    orderIndex,
  };
}

describe("cardsRepo", () => {
  it("create + list ordenado por orderIndex", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.create(sample("terceiro", 3));
    await repo.create(sample("primeiro", 1));
    await repo.create(sample("segundo", 2));
    const all = await repo.list();
    expect(all.map((c) => c.slug)).toEqual(["primeiro", "segundo", "terceiro"]);
  });

  it("findBySlug devolve null para inexistente", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    expect(await repo.findBySlug("nao-existe")).toBeNull();
  });

  it("slug é único", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.create(sample("duplicado", 1));
    await expect(repo.create(sample("duplicado", 2))).rejects.toThrow();
  });

  it("upsertBySlug corre 2x sem duplicar", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.upsertBySlug(sample("unico", 1));
    await repo.upsertBySlug({ ...sample("unico", 2), title: "Actualizado" });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("Actualizado");
    expect(all[0]!.orderIndex).toBe(2);
  });
});

describe("cardsRepo.upsertMany", () => {
  it("cria e actualiza numa só chamada e devolve as contagens", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    await repo.create(sample("existente", 1));

    const result = await repo.upsertMany([
      { ...sample("existente", 1), title: "Novo título" },
      sample("novo", 2),
    ]);
    expect(result).toEqual({ created: 1, updated: 1 });

    const all = await repo.list();
    expect(all.map((c) => c.slug)).toEqual(["existente", "novo"]);
    expect(all[0]!.title).toBe("Novo título");
  });

  it("é idempotente", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    const items = [sample("a", 1), sample("b", 2)];
    expect(await repo.upsertMany(items)).toEqual({ created: 2, updated: 0 });
    expect(await repo.upsertMany(items)).toEqual({ created: 0, updated: 2 });
    expect(await repo.list()).toHaveLength(2);
  });

  it("transacção: se um item falha, nenhum fica gravado", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    const broken = {
      ...sample("quebrado", 2),
      title: null as unknown as string,
    };
    await expect(repo.upsertMany([sample("bom", 1), broken])).rejects.toThrow();
    expect(await repo.list()).toHaveLength(0);
  });

  it("lista vazia não faz nada", async () => {
    const db = await getTestDb();
    expect(await cardsRepo(db).upsertMany([])).toEqual({
      created: 0,
      updated: 0,
    });
  });
});
