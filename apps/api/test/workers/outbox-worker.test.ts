import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "../../src/db/schema.js";
import { outboxRepo } from "../../src/repositories/outbox.js";
import {
  backoffMs,
  processOutboxBatch,
  startOutboxWorker,
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

const silent = { info: () => {}, warn: () => {} };

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs)
      throw new Error("waitFor: tempo esgotado");
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

describe("outbox worker: concorrência e paragem", () => {
  it("duas rondas em simultâneo nunca tratam o mesmo evento duas vezes", async () => {
    const db = await getTestDb();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await enqueue("post.created")).id);

    const handled: string[] = [];
    const handlers = {
      "post.created": async (ev: { id: string }) => {
        handled.push(ev.id);
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    const [a, b] = await Promise.all([
      processOutboxBatch(db, { batchSize: 20, handlers }),
      processOutboxBatch(db, { batchSize: 20, handlers }),
    ]);

    expect(a.claimed + b.claimed).toBe(20);
    expect(handled).toHaveLength(20);
    expect(new Set(handled).size).toBe(20);
    expect([...handled].sort()).toEqual([...ids].sort());
  });

  it("startOutboxWorker processa eventos e stop() espera pela ronda em curso", async () => {
    const db = await getTestDb();
    const e = await enqueue("post.created");
    let finished = false;
    let started = false;

    const stop = startOutboxWorker({
      db,
      log: silent,
      intervalMs: 10,
      batchSize: 10,
      handlers: {
        "post.created": async () => {
          started = true;
          await new Promise((r) => setTimeout(r, 150));
          finished = true;
        },
      },
    });

    await waitFor(async () => started);
    await stop(); // a meio do handler: tem de esperar
    expect(finished).toBe(true);
    expect((await statusOf(e.id)).status).toBe("done");
  });

  it("ronda que falha regista nome, código e causa, nunca a mensagem", async () => {
    const secret = "ep-segredo.neon.tech";
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw Object.assign(new Error(`connect ECONNRESET ${secret}`), {
            code: "ECONNRESET",
          });
        },
      },
    ) as unknown as Awaited<ReturnType<typeof getTestDb>>;
    const logged: Record<string, unknown>[] = [];

    const stop = startOutboxWorker({
      db: failingDb,
      log: {
        info: () => {},
        warn: (obj, msg) => {
          if (msg === "outbox: worker round failed") logged.push(obj);
        },
      },
      intervalMs: 10,
      batchSize: 10,
    });
    await waitFor(async () => logged.length > 0);
    await stop();

    expect(logged[0]).toEqual({ errorName: "Error", errorCode: "ECONNRESET" });
    expect(JSON.stringify(logged[0])).not.toContain(secret);
  });

  it("depois de stop() o worker já não consome eventos", async () => {
    const db = await getTestDb();
    const stop = startOutboxWorker({
      db,
      log: silent,
      intervalMs: 10,
      batchSize: 10,
    });
    await stop();

    const e = await enqueue("post.liked");
    await new Promise((r) => setTimeout(r, 150));
    expect((await statusOf(e.id)).status).toBe("pending");
  });
});
