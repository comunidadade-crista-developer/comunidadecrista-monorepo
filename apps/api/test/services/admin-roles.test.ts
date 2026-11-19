import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { moderationLog, refreshTokens, users } from "../../src/db/schema.js";
import { accountDeletionRepo } from "../../src/repositories/account-deletion.js";
import { refreshTokensRepo } from "../../src/repositories/users.js";
import { demoteAdmin, promoteAdmin } from "../../src/services/admin-roles.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeTestDb();
});

async function sessionFor(userId: string) {
  const db = await getTestDb();
  await refreshTokensRepo(db).create({
    userId,
    tokenHash: `hash-${crypto.randomUUID()}`,
    familyId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

async function activeSessions(userId: string): Promise<number> {
  const db = await getTestDb();
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    );
  return rows.length;
}

async function roleOf(userId: string) {
  const db = await getTestDb();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u!.role;
}

describe("promoteAdmin", () => {
  it("promove, revoga as sessões e regista a acção do sistema", async () => {
    const db = await getTestDb();
    const user = await makeUser({ username: "Maria" });
    await sessionFor(user.id);
    await sessionFor(user.id);

    // O nome é insensível a maiúsculas (citext).
    const r = await promoteAdmin(db, "maria");
    expect(r).toEqual({
      ok: true,
      data: { outcome: "promoted", userId: user.id },
    });
    expect(await roleOf(user.id)).toBe("admin");
    expect(await activeSessions(user.id)).toBe(0);

    const logs = await db.select().from(moderationLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "admin.promoted",
      moderatorId: null,
      targetUserId: user.id,
      postId: null,
    });
  });

  it("já é admin: nada a fazer, sem sessões revogadas nem nova entrada", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    await sessionFor(admin.id);
    const r = await promoteAdmin(db, admin.username);
    expect(r).toEqual({
      ok: true,
      data: { outcome: "already_admin", userId: admin.id },
    });
    expect(await activeSessions(admin.id)).toBe(1);
    expect(await db.select().from(moderationLog)).toHaveLength(0);
  });

  it("utilizador inexistente → not_found", async () => {
    const db = await getTestDb();
    expect(await promoteAdmin(db, "ninguem")).toEqual({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("conta apagada → not_found; conta em apagamento → inactive; nada muda", async () => {
    const db = await getTestDb();
    const gone = await makeUser({ username: "apagada", deletedAt: new Date() });
    const pending = await makeUser({
      username: "pendente",
      deletionRequestedAt: new Date(),
    });
    expect(await promoteAdmin(db, "apagada")).toEqual({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await promoteAdmin(db, "pendente")).toEqual({
      ok: false,
      error: { code: "inactive" },
    });
    expect(await roleOf(gone.id)).toBe("user");
    expect(await roleOf(pending.id)).toBe("user");
    expect(await db.select().from(moderationLog)).toHaveLength(0);
  });
});

describe("demoteAdmin", () => {
  it("despromove quando há outro admin activo, revoga sessões e regista", async () => {
    const db = await getTestDb();
    const a = await makeUser({ role: "admin" });
    await makeUser({ role: "admin" });
    await sessionFor(a.id);

    const r = await demoteAdmin(db, a.username);
    expect(r).toEqual({
      ok: true,
      data: { outcome: "demoted", userId: a.id },
    });
    expect(await roleOf(a.id)).toBe("user");
    expect(await activeSessions(a.id)).toBe(0);
    const logs = await db.select().from(moderationLog);
    expect(logs[0]).toMatchObject({
      action: "admin.demoted",
      moderatorId: null,
      targetUserId: a.id,
    });
  });

  it("recusa despromover o último admin", async () => {
    const db = await getTestDb();
    const only = await makeUser({ role: "admin" });
    expect(await demoteAdmin(db, only.username)).toEqual({
      ok: false,
      error: { code: "last_admin" },
    });
    expect(await roleOf(only.id)).toBe("admin");
    expect(await db.select().from(moderationLog)).toHaveLength(0);
  });

  it("outro admin em apagamento ou apagado não conta como activo", async () => {
    const db = await getTestDb();
    const only = await makeUser({ role: "admin" });
    await makeUser({ role: "admin", deletionRequestedAt: new Date() });
    await makeUser({ role: "admin", deletedAt: new Date() });
    expect(await demoteAdmin(db, only.username)).toEqual({
      ok: false,
      error: { code: "last_admin" },
    });
  });

  it("um admin em apagamento pode ser despromovido (já não é activo)", async () => {
    const db = await getTestDb();
    await makeUser({ role: "admin" });
    const leaving = await makeUser({
      role: "admin",
      deletionRequestedAt: new Date(),
    });
    const r = await demoteAdmin(db, leaving.username);
    expect(r.ok && r.data.outcome).toBe("demoted");
  });

  it("não é admin → already_user, sem efeitos", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await makeUser({ role: "admin" });
    expect(await demoteAdmin(db, user.username)).toEqual({
      ok: true,
      data: { outcome: "already_user", userId: user.id },
    });
    expect(await db.select().from(moderationLog)).toHaveLength(0);
  });

  it("inexistente → not_found", async () => {
    const db = await getTestDb();
    expect(await demoteAdmin(db, "ninguem")).toEqual({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("concorrência sobre o conjunto de admins", () => {
  it("dois admins despromovidos em simultâneo: um passa, o outro fica como último", async () => {
    const db = await getTestDb();
    const a = await makeUser({ role: "admin" });
    const b = await makeUser({ role: "admin" });
    const results = await Promise.all([
      demoteAdmin(db, a.username),
      demoteAdmin(db, b.username),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: { code: "last_admin" } },
    ]);
    const roles = [await roleOf(a.id), await roleOf(b.id)];
    expect(roles.filter((r) => r === "admin")).toHaveLength(1);
  });

  it("despromoção de um admin e pedido de apagamento do outro: nunca ficam zero admins", async () => {
    const db = await getTestDb();
    const a = await makeUser({ role: "admin" });
    const b = await makeUser({ role: "admin" });
    const [demote, deletion] = await Promise.all([
      demoteAdmin(db, a.username),
      accountDeletionRepo(db).request({ userId: b.id, postsMode: "anonymize" }),
    ]);
    const demoted = demote.ok;
    const deleted = deletion.outcome === "requested";
    expect(demoted && deleted).toBe(false);

    const rows = await db.select().from(users);
    const active = rows.filter(
      (u) => u.role === "admin" && !u.deletionRequestedAt && !u.deletedAt,
    );
    expect(active.length).toBeGreaterThanOrEqual(1);
  });
});
