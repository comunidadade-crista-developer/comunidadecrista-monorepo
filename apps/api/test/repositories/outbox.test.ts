import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  idempotencyKeysRepo,
  outboxRepo,
} from "../../src/repositories/outbox.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("outboxRepo", () => {
  it("enqueue + claimBatch marca como processing", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    await repo.enqueue({
      aggregateType: "post",
      aggregateId: "11111111-1111-1111-1111-111111111111",
      eventType: "cache.invalidate",
      payload: { key: "feed" },
    });
    const claimed = await repo.claimBatch(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("processing");
    expect(claimed[0]!.attempts).toBe(1);
  });

  it("claimBatch respeita next_attempt_at no futuro", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    await repo.enqueue({
      aggregateType: "post",
      aggregateId: "22222222-2222-2222-2222-222222222222",
      eventType: "x",
      payload: {},
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    expect(await repo.claimBatch(10)).toHaveLength(0);
  });

  it("SKIP LOCKED: 2 workers em paralelo não apanham o mesmo evento", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.enqueue({
        aggregateType: "post",
        aggregateId: "33333333-3333-3333-3333-333333333333",
        eventType: "x",
        payload: {},
      });
    }
    const [a, b] = await Promise.all([repo.claimBatch(3), repo.claimBatch(3)]);
    const ids = new Set([...a.map((e) => e.id), ...b.map((e) => e.id)]);
    expect(ids.size).toBe(a.length + b.length);
  });

  it("markFailed reagenda; ao atingir 6 tentativas marca como failed", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    await repo.enqueue({
      aggregateType: "post",
      aggregateId: "44444444-4444-4444-4444-444444444444",
      eventType: "x",
      payload: {},
    });
    const [e] = await repo.claimBatch(1);
    await repo.markFailed(e!.id, 6, 100);
    const row = await db.execute<{ status: string }>(
      sql`SELECT status FROM outbox WHERE id = ${e!.id}`,
    );
    expect(row.rows[0]!.status).toBe("failed");
  });

  it("devolve os campos em camelCase (como o tipo OutboxEvent promete)", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    const aggregateId = "55555555-5555-5555-5555-555555555555";
    await repo.enqueue({
      aggregateType: "post",
      aggregateId,
      eventType: "cache.invalidate",
      payload: { key: "feed" },
    });
    const [e] = await repo.claimBatch(1);
    expect(e!.aggregateType).toBe("post");
    expect(e!.aggregateId).toBe(aggregateId);
    expect(e!.eventType).toBe("cache.invalidate");
    expect(e!.payload).toEqual({ key: "feed" });
    expect(e!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("evento reservado fica invisível: um 2.º claimBatch não o apanha", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    // evento antigo: com a lógica errada, ficava logo reclamável por outro worker
    await repo.enqueue({
      aggregateType: "post",
      aggregateId: "66666666-6666-6666-6666-666666666666",
      eventType: "x",
      payload: {},
      nextAttemptAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(await repo.claimBatch(10)).toHaveLength(1);
    expect(await repo.claimBatch(10)).toHaveLength(0);
  });

  it("evento preso em processing volta a ser reclamável depois do prazo", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    await repo.enqueue({
      aggregateType: "post",
      aggregateId: "77777777-7777-7777-7777-777777777777",
      eventType: "x",
      payload: {},
    });
    const [first] = await repo.claimBatch(1);
    // simula o worker ter morrido: o prazo de invisibilidade já passou
    await db.execute(
      sql`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = ${first!.id}`,
    );
    const again = await repo.claimBatch(1);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first!.id);
    expect(again[0]!.attempts).toBe(2);
  });

  it("purgeDone apaga só concluídos antigos; failed e recentes ficam", async () => {
    const db = await getTestDb();
    const repo = outboxRepo(db);
    const make = async (id: string) =>
      (
        await repo.enqueue({
          aggregateType: "post",
          aggregateId: id,
          eventType: "x",
          payload: {},
        })
      ).id;
    const oldDone = await make("88888888-8888-8888-8888-888888888881");
    const recentDone = await make("88888888-8888-8888-8888-888888888882");
    const oldFailed = await make("88888888-8888-8888-8888-888888888883");
    await db.execute(
      sql`UPDATE outbox SET status = 'done', processed_at = now() - interval '10 days' WHERE id = ${oldDone}`,
    );
    await db.execute(
      sql`UPDATE outbox SET status = 'done', processed_at = now() WHERE id = ${recentDone}`,
    );
    await db.execute(
      sql`UPDATE outbox SET status = 'failed', processed_at = now() - interval '10 days' WHERE id = ${oldFailed}`,
    );

    const removed = await repo.purgeDone(
      new Date(Date.now() - 7 * 24 * 60 * 60_000),
    );
    expect(removed).toBe(1);
    const left = await db.execute<{ id: string }>(sql`SELECT id FROM outbox`);
    expect(left.rows.map((r) => r.id).sort()).toEqual(
      [recentDone, oldFailed].sort(),
    );
  });
});

describe("idempotencyKeysRepo", () => {
  it("set + get", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("key-1", user.id, "post.create", { postId: "xxx" });
    const found = await repo.get(user.id, "key-1");
    expect(found?.operation).toBe("post.create");
    expect(found?.response).toEqual({ postId: "xxx" });
  });

  it("set é idempotente (não rebenta com duplicado)", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("key-2", user.id, "op", { a: 1 });
    await repo.set("key-2", user.id, "op", { a: 2 });
    const found = await repo.get(user.id, "key-2");
    expect(found?.response).toEqual({ a: 1 });
  });

  it("a mesma chave em utilizadores diferentes não colide nem se lê entre eles", async () => {
    const db = await getTestDb();
    const alice = await makeUser();
    const bruno = await makeUser();
    const repo = idempotencyKeysRepo(db);

    await repo.set("partilhada", alice.id, "post.create", {
      postId: "da-alice",
    });
    // o Bruno não vê a resposta da Alice
    expect(await repo.get(bruno.id, "partilhada")).toBeNull();

    // e pode usar a mesma chave sem ser bloqueado pela da Alice
    await repo.set("partilhada", bruno.id, "post.create", {
      postId: "do-bruno",
    });
    expect((await repo.get(alice.id, "partilhada"))?.response).toEqual({
      postId: "da-alice",
    });
    expect((await repo.get(bruno.id, "partilhada"))?.response).toEqual({
      postId: "do-bruno",
    });
  });

  it("chaves expiradas não são devolvidas", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("velha", user.id, "op", { a: 1 }, -1000);
    expect(await repo.get(user.id, "velha")).toBeNull();
  });

  it("purgeExpired apaga só as expiradas", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("velha", user.id, "op", {}, -1000);
    await repo.set("nova", user.id, "op", {});
    expect(await repo.purgeExpired()).toBe(1);
    expect(await repo.get(user.id, "nova")).not.toBeNull();
  });
});
