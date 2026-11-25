import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  idempotencyKeys,
  outbox,
  posts,
  refreshTokens,
  users,
} from "../src/db/schema.js";
import { runMaintenance, startMaintenance } from "../src/maintenance.js";
import { accountDeletionRepo } from "../src/repositories/account-deletion.js";
import { idempotencyKeysRepo, outboxRepo } from "../src/repositories/outbox.js";
import { refreshTokensRepo } from "../src/repositories/users.js";
import { closeTestDb, getTestDb, truncateAll } from "./helpers/db.js";
import { makePost, makeUser } from "./helpers/factories.js";
import { uuidv7 } from "uuidv7";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("runMaintenance", () => {
  it("purga o que expirou e deixa o que ainda vale", async () => {
    const db = await getTestDb();
    const user = await makeUser();

    // Idempotência: uma expirada, uma válida.
    const idem = idempotencyKeysRepo(db);
    await idem.set("velha", user.id, "post.create", {}, -1000);
    await idem.set("nova", user.id, "post.create", {}, DAY_MS);

    // Outbox: concluído há 8 dias (purga), concluído agora (fica), pendente (fica).
    const ob = outboxRepo(db);
    const old = await ob.enqueue({
      aggregateType: "t",
      aggregateId: uuidv7(),
      eventType: "e",
      payload: {},
    });
    await ob.markDone(old.id);
    await db
      .update(outbox)
      .set({ processedAt: new Date(Date.now() - 8 * DAY_MS) })
      .where(eq(outbox.id, old.id));
    const recent = await ob.enqueue({
      aggregateType: "t",
      aggregateId: uuidv7(),
      eventType: "e",
      payload: {},
    });
    await ob.markDone(recent.id);
    await ob.enqueue({
      aggregateType: "t",
      aggregateId: uuidv7(),
      eventType: "e",
      payload: {},
    });

    // Refresh tokens: um expirado há 2 dias (purga), um válido (fica).
    const rt = refreshTokensRepo(db);
    await rt.create({
      userId: user.id,
      tokenHash: `h-${uuidv7()}`,
      familyId: uuidv7(),
      expiresAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await rt.create({
      userId: user.id,
      tokenHash: `h-${uuidv7()}`,
      familyId: uuidv7(),
      expiresAt: new Date(Date.now() + DAY_MS),
    });

    // Conta em apagamento há 31 dias.
    const leaver = await makeUser();
    await accountDeletionRepo(db).request({
      userId: leaver.id,
      postsMode: "anonymize",
    });
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date(Date.now() - 31 * DAY_MS) })
      .where(eq(users.id, leaver.id));

    const summary = await runMaintenance(db, { accountGraceDays: 30 });

    expect(summary.idempotencyKeys).toBe(1);
    expect(summary.outboxDone).toBe(1);
    expect(summary.refreshTokens).toBe(1);
    expect(summary.accounts).toBe(1);
    expect(summary.failedAccounts).toBe(0);

    expect(await db.select().from(idempotencyKeys)).toHaveLength(1);
    // 'recent' + 'pendente' + o evento user.deletion_requested da conta apagada.
    expect((await db.select().from(outbox)).length).toBe(3);
    expect(await db.select().from(refreshTokens)).toHaveLength(1);
    expect(
      await db.select().from(users).where(eq(users.id, leaver.id)),
    ).toHaveLength(0);
  });

  it("segunda execução não faz nada (idempotente)", async () => {
    const db = await getTestDb();
    const first = await runMaintenance(db, { accountGraceDays: 30 });
    const second = await runMaintenance(db, { accountGraceDays: 30 });
    expect(first).toEqual(second);
    expect(second.accounts).toBe(0);
  });

  it("o prazo da conta é configurável", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    await accountDeletionRepo(db).request({
      userId: u.id,
      postsMode: "anonymize",
    });
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date(Date.now() - 5 * DAY_MS) })
      .where(eq(users.id, u.id));
    expect((await runMaintenance(db, { accountGraceDays: 30 })).accounts).toBe(
      0,
    );
    expect((await runMaintenance(db, { accountGraceDays: 3 })).accounts).toBe(
      1,
    );
  });
});

describe("runMaintenance — posts apagados pelo autor", () => {
  it("elimina de vez só os apagados há mais do que o prazo (configurável)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const old = await makePost(author.id, { title: "Velho" });
    const recent = await makePost(author.id, { title: "Recente" });
    const live = await makePost(author.id, { title: "Vivo" });
    await db.execute(
      sql`UPDATE posts SET deleted_at = now() - interval '31 days' WHERE id = ${old.id}`,
    );
    await db.execute(
      sql`UPDATE posts SET deleted_at = now() - interval '5 days' WHERE id = ${recent.id}`,
    );

    const first = await runMaintenance(db, { accountGraceDays: 30 });
    expect(first.softDeletedPosts).toBe(1);
    const left = await db.select().from(posts);
    expect(left.map((p) => p.id).sort()).toEqual([recent.id, live.id].sort());

    // Com um prazo de 3 dias, o «recente» também vai.
    const second = await runMaintenance(db, {
      accountGraceDays: 30,
      postsDeletedRetentionDays: 3,
    });
    expect(second.softDeletedPosts).toBe(1);
    expect((await db.select().from(posts)).map((p) => p.id)).toEqual([live.id]);
  });
});

describe("startMaintenance: falha registada sem a mensagem", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("regista nome e código do erro e não o texto", async () => {
    vi.useFakeTimers();
    const secret = "ep-segredo.neon.tech";
    const failingDb = new Proxy(
      {},
      {
        get() {
          throw Object.assign(new Error(`connect ETIMEDOUT ${secret}`), {
            code: "ETIMEDOUT",
          });
        },
      },
    ) as unknown as Awaited<ReturnType<typeof getTestDb>>;
    const logged: Record<string, unknown>[] = [];

    const stop = startMaintenance({
      db: failingDb,
      env: {
        ACCOUNT_DELETION_GRACE_DAYS: 30,
        MAINTENANCE_INTERVAL_MINUTES: 60,
        POSTS_DELETED_RETENTION_DAYS: 30,
      },
      log: {
        info: () => {},
        warn: (obj, msg) => {
          if (msg === "maintenance failed") logged.push(obj);
        },
      },
    });
    await vi.advanceTimersByTimeAsync(31_000);
    stop();

    expect(logged[0]).toEqual({ errorName: "Error", errorCode: "ETIMEDOUT" });
    expect(JSON.stringify(logged[0])).not.toContain(secret);
  });
});
