import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { moderationLog, posts, users } from "../../src/db/schema.js";
import { moderationLogRepo } from "../../src/repositories/reports.js";
import { refreshTokensRepo } from "../../src/repositories/users.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("purga de contas: o que sobrevive", () => {
  it("apagar o autor anonimiza as partilhas (author_id = null) em vez de as apagar", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);

    await db.delete(users).where(eq(users.id, author.id));

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row).toBeDefined();
    expect(row!.authorId).toBeNull();
    expect(row!.content).toBe(post.content);
  });

  it("apagar o moderador não apaga o registo de auditoria", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const moderator = await makeUser({ role: "admin" });
    const post = await makePost(author.id);
    const entry = await moderationLogRepo(db).create({
      postId: post.id,
      moderatorId: moderator.id,
      action: "rejected",
      reason: "fora da doutrina",
    });

    await db.delete(users).where(eq(users.id, moderator.id));

    const [row] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.id, entry.id));
    expect(row).toBeDefined();
    expect(row!.moderatorId).toBeNull();
    expect(row!.reason).toBe("fora da doutrina");
  });

  it("apagar a partilha não apaga o registo de auditoria", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const moderator = await makeUser({ role: "admin" });
    const post = await makePost(author.id);
    const entry = await moderationLogRepo(db).create({
      postId: post.id,
      moderatorId: moderator.id,
      action: "approved",
    });

    await db.delete(posts).where(eq(posts.id, post.id));

    const [row] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.id, entry.id));
    expect(row).toBeDefined();
    expect(row!.postId).toBeNull();
    expect(row!.action).toBe("approved");
  });
});

describe("refreshTokensRepo.purgeExpired", () => {
  it("apaga só os tokens expirados antes do limite", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = refreshTokensRepo(db);
    const day = 24 * 60 * 60_000;
    const base = {
      userId: user.id,
      familyId: "99999999-9999-9999-9999-999999999999",
    };

    await repo.create({
      ...base,
      tokenHash: "expirado-ha-10-dias",
      expiresAt: new Date(Date.now() - 10 * day),
    });
    await repo.create({
      ...base,
      tokenHash: "expirado-ha-1-hora",
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    await repo.create({
      ...base,
      tokenHash: "valido",
      expiresAt: new Date(Date.now() + 10 * day),
    });

    expect(await repo.purgeExpired(new Date(Date.now() - day))).toBe(1);
    expect(await repo.findActiveByHash("valido")).not.toBeNull();
    expect(await repo.findActiveByHash("expirado-ha-1-hora")).not.toBeNull();
    expect(await repo.findActiveByHash("expirado-ha-10-dias")).toBeNull();
  });
});
