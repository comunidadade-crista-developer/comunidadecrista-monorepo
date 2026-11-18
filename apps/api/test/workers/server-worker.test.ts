import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { outboxRepo } from "../../src/repositories/outbox.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";

const AGG = "0190a0a0-0000-7000-8000-000000000002";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
  OUTBOX_WORKER_INTERVAL_MS: 200,
} as const;

async function enqueue() {
  const db = await getTestDb();
  return outboxRepo(db).enqueue({
    aggregateType: "post",
    aggregateId: AGG,
    eventType: "post.liked",
    payload: { postId: AGG },
  });
}

async function statusOf(id: string) {
  const db = await getTestDb();
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row!.status;
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

describe("buildServer: worker do outbox", () => {
  it("em testes não arranca por omissão", async () => {
    const app = await buildServer({ env: loadEnv(baseEnv) });
    await app.ready();
    const e = await enqueue();
    await new Promise((r) => setTimeout(r, 700));
    expect(await statusOf(e.id)).toBe("pending");
    await app.close();
  });

  it("com disableWorker: false arranca em onReady e pára em close", async () => {
    const app = await buildServer({
      env: loadEnv(baseEnv),
      disableWorker: false,
    });
    const e = await enqueue();
    // Antes de `ready()` (onReady) nada corre.
    await new Promise((r) => setTimeout(r, 450));
    expect(await statusOf(e.id)).toBe("pending");

    await app.ready();
    const start = Date.now();
    while ((await statusOf(e.id)) !== "done") {
      if (Date.now() - start > 4000) throw new Error("worker não arrancou");
      await new Promise((r) => setTimeout(r, 50));
    }
    await app.close();

    const e2 = await enqueue();
    await new Promise((r) => setTimeout(r, 450));
    expect(await statusOf(e2.id)).toBe("pending");
  });
});
