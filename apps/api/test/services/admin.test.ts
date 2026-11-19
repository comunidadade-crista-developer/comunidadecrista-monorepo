import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "@comunidade/shared";
import { outbox, posts, reports } from "../../src/db/schema.js";
import { postsRepo } from "../../src/repositories/posts.js";
import { moderationLogRepo } from "../../src/repositories/reports.js";
import {
  approvePost,
  getAdminPostDetail,
  listAdminModerationLog,
  listAdminPosts,
  listAdminReports,
  rejectPost,
} from "../../src/services/admin.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeReport, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeTestDb();
});

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
const query = { status: "pending_review" as const, limit: 10 };

describe("listAdminPosts", () => {
  it("devolve só os pending_review, do mais antigo para o mais recente, sem apagados", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    await makePost(author.id, { status: "published", title: "Publicado" });
    await makePost(author.id, {
      status: "pending_review",
      title: "Segundo",
      createdAt: at(2),
    });
    await makePost(author.id, {
      status: "pending_review",
      title: "Primeiro",
      createdAt: at(1),
    });
    await makePost(author.id, {
      status: "pending_review",
      title: "Apagado",
      createdAt: at(3),
      deletedAt: new Date(),
    });

    const r = await listAdminPosts(db, query);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.posts.map((p) => p.title)).toEqual(["Primeiro", "Segundo"]);
    expect(r.data.nextCursor).toBeNull();
  });

  it("os outros estados vêm do mais recente", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    await makePost(author.id, {
      status: "rejected",
      title: "A",
      createdAt: at(1),
    });
    await makePost(author.id, {
      status: "rejected",
      title: "B",
      createdAt: at(2),
    });
    const r = await listAdminPosts(db, { status: "rejected", limit: 10 });
    expect(r.ok && r.data.posts.map((p) => p.title)).toEqual(["B", "A"]);
  });

  it("pagina com cursor composto, sem repetir nem saltar (inclui empate no instante)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Os dois primeiros partilham o mesmo instante: o desempate é pelo id.
      const p = await makePost(author.id, {
        status: "pending_review",
        title: `P${i}`,
        createdAt: at(i < 2 ? 1 : i),
      });
      ids.push(p.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await listAdminPosts(db, {
        status: "pending_review",
        limit: 2,
        cursor,
      });
      if (!r.ok) throw new Error("falhou");
      seen.push(...r.data.posts.map((p) => p.id));
      if (r.data.nextCursor === null) break;
      cursor = r.data.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("denúncias abertas por categoria; as tratadas não contam", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    await makeReport(post.id, (await makeUser()).id, { category: "spam" });
    await makeReport(post.id, (await makeUser()).id, { category: "spam" });
    await makeReport(post.id, (await makeUser()).id, { category: "doctrine" });
    await makeReport(post.id, (await makeUser()).id, {
      category: "offensive",
      status: "resolved_kept",
    });

    const r = await listAdminPosts(db, query);
    if (!r.ok) throw new Error("falhou");
    const item = r.data.posts[0]!;
    expect(item.reportsCount).toBe(3);
    expect(item.reportsByCategory).toEqual({
      spam: 2,
      off_topic: 0,
      offensive: 0,
      doctrine: 1,
      other: 0,
    });
  });

  it("excerto cortado sem partir emojis; autor removido → null", async () => {
    const db = await getTestDb();
    const author = await makeUser({ username: "autor" });
    await makePost(author.id, {
      status: "pending_review",
      content: "😀".repeat(300),
      createdAt: at(1),
    });
    const orphan = await makePost(author.id, {
      status: "pending_review",
      createdAt: at(2),
    });
    await db
      .update(posts)
      .set({ authorId: null })
      .where(eq(posts.id, orphan.id));

    const r = await listAdminPosts(db, query);
    if (!r.ok) throw new Error("falhou");
    const [long, anon] = r.data.posts;
    expect(Array.from(long!.excerpt)).toHaveLength(201); // 200 + «…»
    expect(long!.excerpt.endsWith("…")).toBe(true);
    expect(long!.author).toEqual({ username: "autor" });
    expect(anon!.author).toBeNull();
  });

  it("cursor de outra lista → invalid_cursor (400)", async () => {
    const db = await getTestDb();
    const cursor = encodeCursor({
      k: "admin_log",
      t: "2026-01-01T00:00:00.000000Z",
      id: "0190a0a0-0000-7000-8000-000000000001",
    });
    const r = await listAdminPosts(db, { ...query, cursor });
    expect(r).toEqual({
      ok: false,
      error: { code: "invalid_cursor", status: 400 },
    });
  });
});

describe("getAdminPostDetail", () => {
  it("devolve conteúdo completo, denúncias com username e decisões anteriores", async () => {
    const db = await getTestDb();
    const author = await makeUser({ username: "autor" });
    const reporter = await makeUser({ username: "denunciante" });
    const admin = await makeUser({ username: "moderadora", role: "admin" });
    const post = await makePost(author.id, {
      status: "pending_review",
      content: "x".repeat(900),
      reviewFlags: ["reports_high"],
    });
    await makeReport(post.id, reporter.id, {
      category: "doctrine",
      reason: "motivo",
    });
    await moderationLogRepo(db).create({
      postId: post.id,
      moderatorId: admin.id,
      action: "rejected",
      reason: "decisão anterior",
    });

    const r = await getAdminPostDetail(db, post.id);
    if (!r.ok) throw new Error("falhou");
    expect(r.data.post.content).toHaveLength(900);
    expect(r.data.post.reviewFlags).toEqual(["reports_high"]);
    expect(r.data.post.author).toEqual({ username: "autor" });
    expect(r.data.post.reportsByCategory.doctrine).toBe(1);
    expect(r.data.reports).toHaveLength(1);
    expect(r.data.reports[0]).toMatchObject({
      reporter: { username: "denunciante" },
      category: "doctrine",
      severity: "high",
      status: "open",
    });
    expect(r.data.moderation[0]).toMatchObject({
      action: "rejected",
      moderator: { username: "moderadora" },
      reason: "decisão anterior",
    });
    // Nenhum identificador interno de utilizador sai.
    expect(JSON.stringify(r.data)).not.toContain(author.id);
    expect(JSON.stringify(r.data)).not.toContain(reporter.id);
  });

  it("inexistente ou apagado → not_found", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const deleted = await makePost(author.id, { deletedAt: new Date() });
    for (const id of [crypto.randomUUID(), deleted.id]) {
      const r = await getAdminPostDetail(db, id);
      expect(r).toEqual({
        ok: false,
        error: { code: "not_found", status: 404 },
      });
    }
  });
});

describe("approvePost", () => {
  it("publica, resolve as denúncias, regista a decisão e cria o evento", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const reporter = await makeUser();
    const report = await makeReport(post.id, reporter.id);

    const r = await approvePost(db, admin.id, post.id, { note: "tudo bem" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.post.status).toBe("published");
    expect(r.data.post.publishedAt).not.toBeNull();

    const after = await postsRepo(db).findById(post.id);
    expect(after!.status).toBe("published");
    expect(after!.reportsCount).toBe(0);

    const [rep] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, report.id));
    expect(rep).toMatchObject({
      status: "resolved_kept",
      resolvedBy: admin.id,
    });

    const logs = await moderationLogRepo(db).listByPost(post.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "approved",
      moderatorId: admin.id,
      reason: "tudo bem",
    });

    const events = await db.select().from(outbox);
    expect(events.map((e) => e.eventType)).toEqual(["post.approved"]);
    expect(events[0]!.aggregateId).toBe(post.id);
  });

  it("só a partir de pending_review: published, rejected e hidden → invalid_state, sem efeitos", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const suspended = await makePost(author.id, {
      status: "hidden",
      suspendedStatus: "pending_review",
    });
    const others = await Promise.all([
      makePost(author.id, { status: "published" }),
      makePost(author.id, { status: "rejected" }),
    ]);
    for (const p of [suspended, ...others]) {
      const r = await approvePost(db, admin.id, p.id, {});
      expect(r).toEqual({
        ok: false,
        error: { code: "invalid_state", status: 409 },
      });
    }
    // Um post suspenso por apagamento de conta continua suspenso.
    expect((await postsRepo(db).findById(suspended.id))!.status).toBe("hidden");
    expect(await moderationLogRepo(db).listRecent()).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it("inexistente ou apagado → not_found", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const deleted = await makePost(author.id, {
      status: "pending_review",
      deletedAt: new Date(),
    });
    for (const id of [crypto.randomUUID(), deleted.id]) {
      const r = await approvePost(db, admin.id, id, {});
      expect(r).toEqual({
        ok: false,
        error: { code: "not_found", status: 404 },
      });
    }
  });

  it("dois admins a aprovar o mesmo post: um vence, o outro recebe 409, uma só entrada de auditoria", async () => {
    const db = await getTestDb();
    const a1 = await makeUser({ role: "admin" });
    const a2 = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });

    const [r1, r2] = await Promise.all([
      approvePost(db, a1.id, post.id, {}),
      approvePost(db, a2.id, post.id, {}),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toEqual({
      ok: false,
      error: { code: "invalid_state", status: 409 },
    });
    expect(await moderationLogRepo(db).listByPost(post.id)).toHaveLength(1);
    expect(await db.select().from(outbox)).toHaveLength(1);
  });

  it("aprovar e rejeitar em simultâneo: só uma decisão fica", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const results = await Promise.all([
      approvePost(db, admin.id, post.id, {}),
      rejectPost(db, admin.id, post.id, { reason: "fora da doutrina" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await moderationLogRepo(db).listByPost(post.id)).toHaveLength(1);
  });
});

describe("rejectPost", () => {
  it("rejeita, resolve as denúncias como removidas e guarda o motivo", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const report = await makeReport(post.id, (await makeUser()).id, {
      category: "offensive",
    });

    const r = await rejectPost(db, admin.id, post.id, {
      reason: "fora da doutrina",
    });
    expect(r.ok && r.data.post.status).toBe("rejected");

    const [rep] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, report.id));
    expect(rep!.status).toBe("resolved_removed");
    const logs = await moderationLogRepo(db).listByPost(post.id);
    expect(logs[0]).toMatchObject({
      action: "rejected",
      reason: "fora da doutrina",
    });
    const events = await db.select().from(outbox);
    expect(events.map((e) => e.eventType)).toEqual(["post.rejected"]);
  });

  it("já rejeitado → invalid_state", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id, { status: "rejected" });
    const r = await rejectPost(db, admin.id, post.id, {
      reason: "x".repeat(20),
    });
    expect(r).toEqual({
      ok: false,
      error: { code: "invalid_state", status: 409 },
    });
  });
});

describe("listAdminReports", () => {
  it("filtra por estado, das mais recentes, com título e username", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser({ username: "denunciante" });
    const post = await makePost(author.id, { title: "Título" });
    await makeReport(post.id, reporter.id, { createdAt: at(1) });
    await makeReport(post.id, (await makeUser()).id, { createdAt: at(2) });
    await makeReport(post.id, (await makeUser()).id, {
      status: "resolved_kept",
      createdAt: at(3),
    });

    const open = await listAdminReports(db, { status: "open", limit: 10 });
    if (!open.ok) throw new Error("falhou");
    expect(open.data.reports).toHaveLength(2);
    expect(open.data.reports[1]).toMatchObject({
      postTitle: "Título",
      reporter: { username: "denunciante" },
    });
    expect(
      new Date(open.data.reports[0]!.createdAt) >
        new Date(open.data.reports[1]!.createdAt),
    ).toBe(true);

    const kept = await listAdminReports(db, {
      status: "resolved_kept",
      limit: 10,
    });
    expect(kept.ok && kept.data.reports).toHaveLength(1);
  });

  it("pagina sem repetir", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    for (let i = 0; i < 5; i++) {
      await makeReport(post.id, (await makeUser()).id, { createdAt: at(i) });
    }
    const p1 = await listAdminReports(db, { status: "open", limit: 3 });
    if (!p1.ok) throw new Error("falhou");
    expect(p1.data.nextCursor).not.toBeNull();
    const p2 = await listAdminReports(db, {
      status: "open",
      limit: 3,
      cursor: p1.data.nextCursor!,
    });
    if (!p2.ok) throw new Error("falhou");
    const ids = [...p1.data.reports, ...p2.data.reports].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(p2.data.nextCursor).toBeNull();
  });
});

describe("listAdminModerationLog", () => {
  it("mostra moderador, alvo e título; filtra por acção e por post", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ username: "moderadora", role: "admin" });
    const target = await makeUser({ username: "alvo" });
    const author = await makeUser();
    const post = await makePost(author.id, { title: "Título" });
    const log = moderationLogRepo(db);
    await log.create({
      postId: post.id,
      moderatorId: admin.id,
      action: "approved",
    });
    await log.create({
      moderatorId: null,
      targetUserId: target.id,
      action: "admin.promoted",
    });

    const all = await listAdminModerationLog(db, { limit: 10 });
    if (!all.ok) throw new Error("falhou");
    expect(all.data.entries).toHaveLength(2);
    const promoted = all.data.entries.find(
      (e) => e.action === "admin.promoted",
    )!;
    expect(promoted).toMatchObject({
      moderator: null,
      target: { username: "alvo" },
    });
    const approved = all.data.entries.find((e) => e.action === "approved")!;
    expect(approved).toMatchObject({
      moderator: { username: "moderadora" },
      postTitle: "Título",
    });

    const onlyPromoted = await listAdminModerationLog(db, {
      action: "admin.promoted",
      limit: 10,
    });
    expect(onlyPromoted.ok && onlyPromoted.data.entries).toHaveLength(1);
    const onlyPost = await listAdminModerationLog(db, {
      postId: post.id,
      limit: 10,
    });
    expect(onlyPost.ok && onlyPost.data.entries).toHaveLength(1);
  });

  it("a entrada sobrevive ao fim do post e do moderador (SET NULL)", async () => {
    const db = await getTestDb();
    const admin = await makeUser({ role: "admin" });
    const author = await makeUser();
    const post = await makePost(author.id);
    await moderationLogRepo(db).create({
      postId: post.id,
      moderatorId: admin.id,
      action: "approved",
    });
    await db.delete(posts).where(eq(posts.id, post.id));

    const r = await listAdminModerationLog(db, { limit: 10 });
    if (!r.ok) throw new Error("falhou");
    expect(r.data.entries).toHaveLength(1);
    expect(r.data.entries[0]).toMatchObject({ postId: null, postTitle: null });
  });
});
