import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  moderationLog,
  outbox,
  pendingPasswordResets,
  posts,
  refreshTokens,
  reports,
  users,
} from "../../src/db/schema.js";
import {
  accountDeletionRepo,
  publicAuthorId,
} from "../../src/repositories/account-deletion.js";
import { postLikesRepo, postsRepo } from "../../src/repositories/posts.js";
import { reportsRepo } from "../../src/repositories/reports.js";
import { refreshTokensRepo } from "../../src/repositories/users.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";
import { uuidv7 } from "uuidv7";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

async function userRow(id: string) {
  const db = await getTestDb();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

async function postRow(id: string) {
  const db = await getTestDb();
  const [row] = await db.select().from(posts).where(eq(posts.id, id));
  return row;
}

/** Recua o pedido de apagamento para simular que o prazo já passou. */
async function ageDeletion(userId: string, days: number) {
  const db = await getTestDb();
  await db
    .update(users)
    .set({ deletionRequestedAt: new Date(Date.now() - days * DAY_MS) })
    .where(eq(users.id, userId));
}

async function like(postId: string, userId: string) {
  const db = await getTestDb();
  await postLikesRepo(db).like(postId, userId);
  await postsRepo(db).incrementLikes(postId, 1);
}

describe("accountDeletionRepo.request", () => {
  it("fica pendente, revoga sessões, cancela pedido de palavra-passe e cria evento", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await refreshTokensRepo(db).create({
      userId: user.id,
      tokenHash: `hash-${uuidv7()}`,
      familyId: uuidv7(),
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    await db.insert(pendingPasswordResets).values({
      userId: user.id,
      passwordHash: "$argon2id$x",
      effectiveAt: new Date(Date.now() + DAY_MS),
    });

    const before = Date.now();
    const result = await accountDeletionRepo(db).request({
      userId: user.id,
      postsMode: "anonymize",
    });

    expect(result.outcome).toBe("requested");
    if (result.outcome !== "requested") return;
    const expected = before + 30 * DAY_MS;
    expect(Math.abs(result.purgeAt.getTime() - expected)).toBeLessThan(10_000);

    const row = await userRow(user.id);
    expect(row?.deletionRequestedAt).toBeInstanceOf(Date);
    expect(row?.deletionPostsMode).toBe("anonymize");
    const tokens = await db.select().from(refreshTokens);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
    expect(await db.select().from(pendingPasswordResets)).toHaveLength(0);
    const events = await db.select().from(outbox);
    expect(events.map((e) => e.eventType)).toContain("user.deletion_requested");
  });

  it("anonymize: posts ficam visíveis mas sem autor público", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const post = await makePost(user.id);
    await accountDeletionRepo(db).request({
      userId: user.id,
      postsMode: "anonymize",
    });
    const row = await postRow(post.id);
    expect(row?.status).toBe("published");
    expect(row?.authorHidden).toBe(true);
    expect(publicAuthorId(row!)).toBeNull();
    const feed = await postsRepo(db).list({});
    expect(feed.items.map((p) => p.id)).toContain(post.id);
  });

  it("delete: posts ficam ocultos e guardam o estado anterior; os já ocultos não se tocam", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const published = await makePost(user.id, { status: "published" });
    const review = await makePost(user.id, { status: "pending_review" });
    const hidden = await makePost(user.id, { status: "hidden" });

    await accountDeletionRepo(db).request({
      userId: user.id,
      postsMode: "delete",
    });

    const p = await postRow(published.id);
    expect(p?.status).toBe("hidden");
    expect(p?.suspendedStatus).toBe("published");
    const r = await postRow(review.id);
    expect(r?.status).toBe("hidden");
    expect(r?.suspendedStatus).toBe("pending_review");
    const h = await postRow(hidden.id);
    expect(h?.status).toBe("hidden");
    expect(h?.suspendedStatus).toBeNull();
    const feed = await postsRepo(db).list({});
    expect(feed.items.map((x) => x.id)).not.toContain(published.id);
  });

  it("pedido repetido → already_pending com o prazo original e sem mudar a escolha", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = accountDeletionRepo(db);
    const first = await repo.request({
      userId: user.id,
      postsMode: "anonymize",
    });
    const second = await repo.request({ userId: user.id, postsMode: "delete" });
    expect(second.outcome).toBe("already_pending");
    if (first.outcome === "requested" && second.outcome === "already_pending") {
      expect(second.purgeAt.getTime()).toBe(first.purgeAt.getTime());
    }
    expect((await userRow(user.id))?.deletionPostsMode).toBe("anonymize");
  });

  it("utilizador inexistente → not_found", async () => {
    const db = await getTestDb();
    const result = await accountDeletionRepo(db).request({
      userId: uuidv7(),
      postsMode: "anonymize",
    });
    expect(result.outcome).toBe("not_found");
  });

  it("o último admin não se pode apagar; havendo outro, sim", async () => {
    const db = await getTestDb();
    const a = await makeUser({ role: "admin" });
    const b = await makeUser({ role: "admin" });
    const repo = accountDeletionRepo(db);
    expect(
      (await repo.request({ userId: a.id, postsMode: "anonymize" })).outcome,
    ).toBe("requested");
    expect(
      (await repo.request({ userId: b.id, postsMode: "anonymize" })).outcome,
    ).toBe("last_admin");
  });

  it("dois admins a pedir ao mesmo tempo: só um passa", async () => {
    const db = await getTestDb();
    const a = await makeUser({ role: "admin" });
    const b = await makeUser({ role: "admin" });
    const repo = accountDeletionRepo(db);
    const results = await Promise.all([
      repo.request({ userId: a.id, postsMode: "anonymize" }),
      repo.request({ userId: b.id, postsMode: "anonymize" }),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["last_admin", "requested"]);
  });
});

describe("accountDeletionRepo.restore", () => {
  it("repõe estado, posts e autor", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const published = await makePost(user.id, { status: "published" });
    const review = await makePost(user.id, { status: "pending_review" });
    const hidden = await makePost(user.id, { status: "hidden" });
    const repo = accountDeletionRepo(db);

    await repo.request({ userId: user.id, postsMode: "delete" });
    expect(await repo.restore(user.id)).toBe("restored");

    const row = await userRow(user.id);
    expect(row?.deletionRequestedAt).toBeNull();
    expect(row?.deletionPostsMode).toBeNull();
    expect((await postRow(published.id))?.status).toBe("published");
    expect((await postRow(review.id))?.status).toBe("pending_review");
    expect((await postRow(hidden.id))?.status).toBe("hidden");
    expect((await postRow(published.id))?.suspendedStatus).toBeNull();
  });

  it("anonymize: o autor volta a ser público", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const post = await makePost(user.id);
    const repo = accountDeletionRepo(db);
    await repo.request({ userId: user.id, postsMode: "anonymize" });
    await repo.restore(user.id);
    const row = await postRow(post.id);
    expect(row?.authorHidden).toBe(false);
    expect(publicAuthorId(row!)).toBe(user.id);
  });

  it("já activa → already_active; inexistente → gone", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = accountDeletionRepo(db);
    expect(await repo.restore(user.id)).toBe("already_active");
    expect(await repo.restore(uuidv7())).toBe("gone");
  });

  it("depois de reactivada, a purga já não a apanha", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = accountDeletionRepo(db);
    await repo.request({ userId: user.id, postsMode: "anonymize" });
    await ageDeletion(user.id, 31);
    await repo.restore(user.id);
    const summary = await repo.purgeDue();
    expect(summary.accounts).toBe(0);
    expect(await userRow(user.id)).toBeDefined();
  });
});

describe("accountDeletionRepo.purgeDue", () => {
  it("não apaga dentro do prazo", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const repo = accountDeletionRepo(db);
    await repo.request({ userId: user.id, postsMode: "anonymize" });
    await ageDeletion(user.id, 29);
    expect((await repo.purgeDue()).accounts).toBe(0);
    expect(await userRow(user.id)).toBeDefined();
  });

  it("anonymize: apaga a conta, mantém os posts sem autor", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const post = await makePost(user.id);
    const repo = accountDeletionRepo(db);
    await repo.request({ userId: user.id, postsMode: "anonymize" });
    await ageDeletion(user.id, 31);

    const summary = await repo.purgeDue();
    expect(summary).toEqual({ accounts: 1, postsDeleted: 0, failed: 0 });
    expect(await userRow(user.id)).toBeUndefined();
    const row = await postRow(post.id);
    expect(row?.authorId).toBeNull();
    expect(row?.authorHidden).toBe(true);
    expect(row?.status).toBe("published");
  });

  it("delete: apaga a conta e as partilhas (e o log de moderação perde só a referência)", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const post = await makePost(user.id);
    await db.insert(moderationLog).values({
      postId: post.id,
      moderatorId: admin.id,
      action: "approved",
    });
    const repo = accountDeletionRepo(db);
    await repo.request({ userId: user.id, postsMode: "delete" });
    await ageDeletion(user.id, 31);

    const summary = await repo.purgeDue();
    expect(summary).toEqual({ accounts: 1, postsDeleted: 1, failed: 0 });
    expect(await postRow(post.id)).toBeUndefined();
    const log = await db.select().from(moderationLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.postId).toBeNull();
  });

  it("acerta os contadores das partilhas dos outros (likes e denúncias abertas)", async () => {
    const db = await getTestDb();
    const leaver = await makeUser();
    const other = await makeUser();
    const author = await makeUser();
    const post = await makePost(author.id);
    await like(post.id, leaver.id);
    await like(post.id, other.id);
    const filed = await reportsRepo(db).file({
      postId: post.id,
      reporterId: leaver.id,
      reason: "x",
    });
    expect(filed.outcome).toBe("created");
    await reportsRepo(db).file({
      postId: post.id,
      reporterId: other.id,
      reason: "x",
    });
    expect((await postRow(post.id))?.likesCount).toBe(2);
    expect((await postRow(post.id))?.reportsCount).toBe(2);

    const repo = accountDeletionRepo(db);
    await repo.request({ userId: leaver.id, postsMode: "anonymize" });
    await ageDeletion(leaver.id, 31);
    await repo.purgeDue();

    const row = await postRow(post.id);
    expect(row?.likesCount).toBe(1);
    expect(row?.reportsCount).toBe(1);
    expect(await db.select().from(reports)).toHaveLength(1);
  });

  it("denúncia já resolvida não mexe em reports_count ao apagar o autor dela", async () => {
    const db = await getTestDb();
    const leaver = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id);
    const rr = reportsRepo(db);
    await rr.file({ postId: post.id, reporterId: leaver.id, reason: "x" });
    await rr.resolveAllForPost(post.id, "resolved_kept", admin.id);
    expect((await postRow(post.id))?.reportsCount).toBe(0);

    const repo = accountDeletionRepo(db);
    await repo.request({ userId: leaver.id, postsMode: "anonymize" });
    await ageDeletion(leaver.id, 31);
    await repo.purgeDue();
    expect((await postRow(post.id))?.reportsCount).toBe(0);
  });

  it("respeita o limite do lote", async () => {
    const db = await getTestDb();
    const repo = accountDeletionRepo(db);
    for (let i = 0; i < 3; i++) {
      const u = await makeUser();
      await repo.request({ userId: u.id, postsMode: "anonymize" });
      await ageDeletion(u.id, 31);
    }
    expect((await repo.purgeDue({ batch: 2 })).accounts).toBe(2);
    expect((await repo.purgeDue({ batch: 2 })).accounts).toBe(1);
  });

  it("duas purgas em simultâneo não duplicam nem falham", async () => {
    const db = await getTestDb();
    const repo = accountDeletionRepo(db);
    const u = await makeUser();
    await makePost(u.id);
    await repo.request({ userId: u.id, postsMode: "delete" });
    await ageDeletion(u.id, 31);
    const [a, b] = await Promise.all([repo.purgeDue(), repo.purgeDue()]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.accounts + b.accounts).toBe(1);
  });
});

describe("publicAuthorId", () => {
  it("nulo se oculto ou sem autor", () => {
    expect(publicAuthorId({ authorId: "a", authorHidden: false })).toBe("a");
    expect(publicAuthorId({ authorId: "a", authorHidden: true })).toBeNull();
    expect(publicAuthorId({ authorId: null, authorHidden: false })).toBeNull();
  });
});
