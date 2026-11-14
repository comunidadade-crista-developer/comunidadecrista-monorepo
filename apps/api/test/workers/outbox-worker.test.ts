import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "../../src/db/schema.js";
import { outboxRepo } from "../../src/repositories/outbox.js";
import {
  backoffMs,
  processOutboxBatch,
} from "../../src/workers/outbox-worker.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";

const AGG = "0190a0a0-0000-7000-8000-000000000001";

async function enqueue(eventType: string) {
  const db = await getTestDb();
  return outboxRepo(db).enqueue({
    aggregateType: "post",
    aggregateId: AGG,
    eventType,
    payload: { postId: AGG },
  });
}

async function statusOf(id: string) {
  const db = await getTestDb();
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row!;
}

beforeAll(async () => {
  await getTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await truncateAll();
});

describe("outbox worker", () => {
  it("evento sem handler fica concluído (a tabela não cresce)", async () => {
    const db = await getTestDb();
    const e = await enqueue("post.liked");
    const r = await processOutboxBatch(db, { batchSize: 10 });
    expect(r).toEqual({ claimed: 1, done: 1, failed: 0 });
    const row = await statusOf(e.id);
    expect(row.status).toBe("done");
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it("chama o handler do tipo certo, uma vez", async () => {
    const db = await getTestDb();
    const seen: string[] = [];
    await enqueue("post.created");
    await enqueue("post.liked");
    const r = await processOutboxBatch(db, {
      batchSize: 10,
      handlers: {
        "post.created": async (ev) => {
          seen.push(ev.eventType);
        },
      },
    });
    expect(seen).toEqual(["post.created"]);
    expect(r.done).toBe(2);
  });

  it("handler que lança: volta à fila com atraso e o log não traz a mensagem", async () => {
    const db = await getTestDb();
    const logs: Record<string, unknown>[] = [];
    const e = await enqueue("post.created");
    const r = await processOutboxBatch(db, {
      batchSize: 10,
      log: { info: () => {}, warn: (o) => void logs.push(o) },
      handlers: {
        "post.created": async () => {
          throw new Error("segredo do utilizador");
        },
      },
    });
    expect(r).toEqual({ claimed: 1, done: 0, failed: 1 });
    const row = await statusOf(e.id);
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(logs)).not.toContain("segredo");

    // Ainda não é elegível: a ronda seguinte não o apanha.
    const again = await processOutboxBatch(db, { batchSize: 10 });
    expect(again.claimed).toBe(0);
  });

  it("respeita o tamanho do lote", async () => {
    const db = await getTestDb();
    for (let i = 0; i < 3; i++) await enqueue("post.liked");
    const r = await processOutboxBatch(db, { batchSize: 2 });
    expect(r.claimed).toBe(2);
  });

  it("backoff exponencial com tecto", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(4)).toBe(8000);
    expect(backoffMs(50)).toBe(5 * 60_000);
  });
});
