import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { refreshTokensRepo, usersRepo } from "../../src/repositories/users.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("usersRepo", () => {
  it("create + findById", async () => {
    const db = await getTestDb();
    const repo = usersRepo(db);
    const u = await makeUser();
    const found = await repo.findById(u.id);
    expect(found?.id).toBe(u.id);
    expect(found?.username).toBe(u.username);
  });

  it("findByUsername é case-insensitive (citext)", async () => {
    const db = await getTestDb();
    const repo = usersRepo(db);
    await makeUser({ username: "JoaoSilva" });
    const found = await repo.findByUsername("joaosilva");
    expect(found).not.toBeNull();
  });

  it("username duplicado rebenta (unique)", async () => {
    await makeUser({ username: "maria" });
    await expect(makeUser({ username: "Maria" })).rejects.toThrow();
  });

  it("findById devolve null para inexistente", async () => {
    const db = await getTestDb();
    const repo = usersRepo(db);
    expect(
      await repo.findById("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("softDelete esconde de findByUsername", async () => {
    const db = await getTestDb();
    const repo = usersRepo(db);
    const u = await makeUser({ username: "para-apagar" });
    await repo.softDelete(u.id);
    expect(await repo.findByUsername("para-apagar")).toBeNull();
  });

  it("updateUsername altera", async () => {
    const db = await getTestDb();
    const repo = usersRepo(db);
    const u = await makeUser({ username: "antigo" });
    const updated = await repo.updateUsername(u.id, "novo");
    expect(updated?.username).toBe("novo");
  });
});

describe("refreshTokensRepo", () => {
  it("create + findActiveByHash", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const repo = refreshTokensRepo(db);
    const familyId = "11111111-1111-1111-1111-111111111111";
    const t = await repo.create({
      userId: u.id,
      tokenHash: "hash-1",
      familyId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const found = await repo.findActiveByHash("hash-1");
    expect(found?.id).toBe(t.id);
  });

  it("revokeFamily revoga todos da família", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const repo = refreshTokensRepo(db);
    const familyId = "22222222-2222-2222-2222-222222222222";
    await repo.create({
      userId: u.id,
      tokenHash: "a",
      familyId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.create({
      userId: u.id,
      tokenHash: "b",
      familyId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.revokeFamily(familyId);
    expect(await repo.findActiveByHash("a")).toBeNull();
    expect(await repo.findActiveByHash("b")).toBeNull();
  });

  it("revoked token não aparece como activo", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const repo = refreshTokensRepo(db);
    const t = await repo.create({
      userId: u.id,
      tokenHash: "para-revogar",
      familyId: "33333333-3333-3333-3333-333333333333",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.revoke(t.id);
    expect(await repo.findActiveByHash("para-revogar")).toBeNull();
  });
});
