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
});

describe("idempotencyKeysRepo", () => {
  it("set + get", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("key-1", user.id, "post.create", { postId: "xxx" });
    const found = await repo.get("key-1");
    expect(found?.operation).toBe("post.create");
    expect(found?.response).toEqual({ postId: "xxx" });
  });

  it("set é idempotente (não rebenta com duplicado)", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = idempotencyKeysRepo(db);
    await repo.set("key-2", user.id, "op", { a: 1 });
    await repo.set("key-2", user.id, "op", { a: 2 });
    const found = await repo.get("key-2");
    expect(found?.response).toEqual({ a: 1 });
  });
});
