import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { idempotencyKeys } from "../../src/db/schema.js";
import { idempotencyKeysRepo } from "../../src/repositories/outbox.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

const KEY = "chave-de-teste-0123456789";

describe("idempotencyKeysRepo.reserve", () => {
  it("a primeira reserva é nossa; a segunda vê que já existe", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    const args = {
      userId: user.id,
      key: KEY,
      operation: "post.create",
      requestHash: "h1",
    };
    expect(await repo.reserve(args)).toBe("reserved");
    expect(await repo.reserve(args)).toBe("exists");
    const row = await repo.get(user.id, KEY);
    expect(row?.requestHash).toBe("h1");
    expect(row?.response).toEqual({});
  });

  it("complete guarda a resposta", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.reserve({
      userId: user.id,
      key: KEY,
      operation: "post.create",
      requestHash: "h1",
    });
    await repo.complete(user.id, KEY, { ok: true });
    expect((await repo.get(user.id, KEY))?.response).toEqual({ ok: true });
  });

  it("a chave é por utilizador: o mesmo texto de outro utilizador é independente", async () => {
    const db = await getTestDb();
    const a = await makeUser();
    const b = await makeUser();
    const repo = idempotencyKeysRepo(db);
    const base = { key: KEY, operation: "post.create", requestHash: "h" };
    expect(await repo.reserve({ ...base, userId: a.id })).toBe("reserved");
    expect(await repo.reserve({ ...base, userId: b.id })).toBe("reserved");
  });

  it("uma chave expirada é reaproveitada, com o novo pedido", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.reserve({
      userId: user.id,
      key: KEY,
      operation: "post.create",
      requestHash: "antigo",
    });
    await db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idempotencyKeys.userId, user.id));
    expect(await repo.get(user.id, KEY)).toBeNull();

    expect(
      await repo.reserve({
        userId: user.id,
        key: KEY,
        operation: "post.create",
        requestHash: "novo",
      }),
    ).toBe("reserved");
    expect((await repo.get(user.id, KEY))?.requestHash).toBe("novo");
  });

  it("duas transacções concorrentes: só uma reserva; a outra espera e vê 'exists'", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const run = () =>
      db.transaction(async (tx) => {
        const result = await idempotencyKeysRepo(tx).reserve({
          userId: user.id,
          key: KEY,
          operation: "post.create",
          requestHash: "h",
        });
        // Segura a transacção aberta para a outra ter de esperar.
        await new Promise((r) => setTimeout(r, 80));
        return result;
      });
    const results = await Promise.all([run(), run()]);
    expect([...results].sort()).toEqual(["exists", "reserved"]);
    const rows = await db.execute(
      sql`SELECT count(*)::int AS c FROM idempotency_keys`,
    );
    expect(rows.rows[0]).toEqual({ c: 1 });
  });

  it("se a transacção que reservou desfaz, a chave fica livre", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await expect(
      db.transaction(async (tx) => {
        await idempotencyKeysRepo(tx).reserve({
          userId: user.id,
          key: KEY,
          operation: "post.create",
          requestHash: "h",
        });
        throw new Error("falhou a meio");
      }),
    ).rejects.toThrow("falhou a meio");
    expect(
      await idempotencyKeysRepo(db).reserve({
        userId: user.id,
        key: KEY,
        operation: "post.create",
        requestHash: "h",
      }),
    ).toBe("reserved");
  });
});
