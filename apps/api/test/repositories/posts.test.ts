import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { posts, reports } from "../../src/db/schema.js";
import {
  InvalidCursorError,
  postLikesRepo,
  postsRepo,
} from "../../src/repositories/posts.js";
import { reportsRepo } from "../../src/repositories/reports.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeLike, makePost, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("postsRepo — create/find/delete", () => {
  it("create publica e preenche publishedAt", async () => {
    const u = await makeUser();
    const p = await makePost(u.id, { status: "published" });
    expect(p.publishedAt).toBeInstanceOf(Date);
  });

  it("create pending_review não preenche publishedAt", async () => {
    const u = await makeUser();
    const p = await makePost(u.id, { status: "pending_review" });
    expect(p.publishedAt).toBeNull();
  });

  it("delete remove", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p = await makePost(u.id);
    await postsRepo(db).delete(p.id);
    expect(await postsRepo(db).findById(p.id)).toBeNull();
  });
});

describe("postsRepo — feed", () => {
  it("filtro recent devolve por created_at desc", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const a = await makePost(u.id, { title: "A" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await makePost(u.id, { title: "B" });
    const { items } = await postsRepo(db).list({ filter: "recent" });
    expect(items.map((p) => p.title)).toEqual(["B", "A"]);
    expect(items[0]!.id).toBe(b.id);
    expect(items[1]!.id).toBe(a.id);
  });

  it("filtro recent respeita cursor pagination", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    for (let i = 0; i < 5; i++) {
      await makePost(u.id, { title: `P${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const page1 = await postsRepo(db).list({ filter: "recent", limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await postsRepo(db).list({
      filter: "recent",
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(2);
    const ids1 = new Set(page1.items.map((p) => p.id));
    const overlap = page2.items.filter((p) => ids1.has(p.id));
    expect(overlap).toHaveLength(0);
  });

  it("filtro top ordena por likesCount", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p1 = await makePost(u.id, { title: "Poucos" });
    const p2 = await makePost(u.id, { title: "Muitos" });
    for (let i = 0; i < 3; i++) {
      const l = await makeUser();
      await makeLike(p2.id, l.id);
    }
    const { items } = await postsRepo(db).list({ filter: "top" });
    expect(items[0]!.id).toBe(p2.id);
    expect(items[1]!.id).toBe(p1.id);
  });

  it("filtro liked devolve só os que o viewer amou", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const p1 = await makePost(author.id, { title: "Amado" });
    const p2 = await makePost(author.id, { title: "Não amado" });
    await makeLike(p1.id, viewer.id);
    const { items } = await postsRepo(db).list({
      filter: "liked",
      viewerId: viewer.id,
    });
    expect(items.map((p) => p.id)).toEqual([p1.id]);
    expect(items.map((p) => p.id)).not.toContain(p2.id);
  });

  it("esconde posts que não estão published", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    await makePost(u.id, { status: "published", title: "Público" });
    await makePost(u.id, { status: "pending_review", title: "Oculto" });
    await makePost(u.id, { status: "hidden", title: "Oculto2" });
    const { items } = await postsRepo(db).list({ filter: "recent" });
    expect(items.map((p) => p.title)).toEqual(["Público"]);
  });
});

describe("postsRepo — contadores", () => {
  it("incrementLikes soma e não desce abaixo de 0", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const p = await makePost(u.id);
    const repo = postsRepo(db);
    expect(await repo.incrementLikes(p.id, 1)).toBe(1);
    expect(await repo.incrementLikes(p.id, 1)).toBe(2);
    expect(await repo.incrementLikes(p.id, -1)).toBe(1);
    expect(await repo.incrementLikes(p.id, -1)).toBe(0);
  });
});

describe("postLikesRepo", () => {
  it("like é idempotente", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const viewer = await makeUser();
    const p = await makePost(u.id);
    const repo = postLikesRepo(db);
    expect(await repo.like(p.id, viewer.id)).toBe(true);
    expect(await repo.like(p.id, viewer.id)).toBe(false);
  });

  it("unlike remove", async () => {
    const db = await getTestDb();
    const u = await makeUser();
    const viewer = await makeUser();
    const p = await makePost(u.id);
    const repo = postLikesRepo(db);
    await repo.like(p.id, viewer.id);
    expect(await repo.unlike(p.id, viewer.id)).toBe(true);
    expect(await repo.unlike(p.id, viewer.id)).toBe(false);
  });
});

/** Fixa o created_at de um post com precisão de microssegundos (o Date do JS só tem ms). */
async function setCreatedAt(id: string, iso: string): Promise<void> {
  const db = await getTestDb();
  await db.execute(
    sql`UPDATE posts SET created_at = ${iso}::timestamptz WHERE id = ${id}`,
  );
}

describe("postsRepo — soft delete", () => {
  it("esconde o post de findById, do feed e das contagens, mas a linha fica", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const keep = await makePost(author.id, { title: "Fica" });
    const gone = await makePost(author.id, { title: "Apagado" });
    const repo = postsRepo(db);

    expect(await repo.softDelete(gone.id, author.id)).toBe(true);

    expect(await repo.findById(gone.id)).toBeNull();
    expect((await repo.findById(gone.id, { includeDeleted: true }))?.id).toBe(
      gone.id,
    );
    expect((await repo.list()).items.map((p) => p.id)).toEqual([keep.id]);
    expect((await repo.listByAuthor(author.id)).map((p) => p.id)).toEqual([
      keep.id,
    ]);
    expect(await repo.countByAuthor(author.id)).toBe(1);
    expect(
      await repo.findLatestByAuthorInFilter(author.id, {
        statuses: ["published"],
      }),
    ).toMatchObject({ id: keep.id });
    // A linha continua na base de dados (evidência até à purga).
    const [row] = await db.select().from(posts).where(eq(posts.id, gone.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("só o autor apaga, e só uma vez", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const other = await makeUser();
    const post = await makePost(author.id);
    const repo = postsRepo(db);

    expect(await repo.softDelete(post.id, other.id)).toBe(false);
    expect(await repo.softDelete(post.id, author.id)).toBe(true);
    expect(await repo.softDelete(post.id, author.id)).toBe(false);
  });

  it("setStatus não actua em posts apagados", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const repo = postsRepo(db);
    await repo.softDelete(post.id, author.id);
    expect(await repo.setStatus(post.id, "published")).toBeNull();
  });

  it("o feed 'liked' também não mostra posts apagados", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const post = await makePost(author.id);
    await makeLike(post.id, viewer.id);
    await postsRepo(db).softDelete(post.id, author.id);
    const { items } = await postsRepo(db).list({
      filter: "liked",
      viewerId: viewer.id,
    });
    expect(items).toEqual([]);
  });
});

describe("postsRepo.purgeDeleted", () => {
  it("elimina de vez só os apagados há mais do que o prazo, com likes e denúncias", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const liker = await makeUser();
    const reporter = await makeUser();
    const old = await makePost(author.id, { title: "Velho" });
    const recent = await makePost(author.id, { title: "Recente" });
    const live = await makePost(author.id, { title: "Vivo" });
    await makeLike(old.id, liker.id);
    await reportsRepo(db).file({
      postId: old.id,
      reporterId: reporter.id,
      category: "spam",
    });
    const repo = postsRepo(db);
    await repo.softDelete(old.id, author.id);
    await repo.softDelete(recent.id, author.id);
    await db.execute(
      sql`UPDATE posts SET deleted_at = now() - interval '40 days' WHERE id = ${old.id}`,
    );

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(await repo.purgeDeleted(cutoff)).toBe(1);

    expect(
      await db.select().from(posts).where(eq(posts.id, old.id)),
    ).toHaveLength(0);
    expect(await db.select().from(reports)).toHaveLength(0);
    expect(
      (await db.select().from(posts).where(eq(posts.id, recent.id))).length,
    ).toBe(1);
    expect(
      (await db.select().from(posts).where(eq(posts.id, live.id))).length,
    ).toBe(1);
  });

  it("respeita o tamanho do lote", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const repo = postsRepo(db);
    for (let i = 0; i < 3; i++) {
      const p = await makePost(author.id);
      await repo.softDelete(p.id, author.id);
    }
    const future = new Date(Date.now() + 60_000);
    expect(await repo.purgeDeleted(future, 2)).toBe(2);
    expect(await repo.purgeDeleted(future, 2)).toBe(1);
    expect(await repo.purgeDeleted(future, 2)).toBe(0);
  });
});

describe("postsRepo — cursor composto", () => {
  it("não salta linhas criadas a microssegundos de distância", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const a = await makePost(author.id, { title: "A" });
    const b = await makePost(author.id, { title: "B" });
    const c = await makePost(author.id, { title: "C" });
    await setCreatedAt(a.id, "2026-01-01T00:00:00.123100Z");
    await setCreatedAt(b.id, "2026-01-01T00:00:00.123500Z");
    await setCreatedAt(c.id, "2026-01-01T00:00:00.123900Z");

    const repo = postsRepo(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await repo.list({
        filter: "recent",
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.items.map((p) => p.title));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["C", "B", "A"]);
  });

  it("posts com o mesmo created_at não se repetem nem se perdem", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await makePost(author.id, { title: `P${i}` });
      await setCreatedAt(p.id, "2026-01-01T00:00:00.500000Z");
      ids.push(p.id);
    }
    const repo = postsRepo(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await repo.list({
        filter: "recent",
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.items.map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("cursor inválido, adulterado ou de outro filtro → InvalidCursorError", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    for (let i = 0; i < 3; i++) await makePost(author.id);
    const repo = postsRepo(db);
    const page = await repo.list({ filter: "recent", limit: 1 });
    expect(page.nextCursor).not.toBeNull();

    await expect(
      repo.list({ filter: "recent", cursor: "lixo" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      repo.list({ filter: "recent", cursor: page.nextCursor!.slice(0, -3) }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    // O cursor do «recent» não serve para o «top».
    await expect(
      repo.list({ filter: "top", cursor: page.nextCursor! }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("top pagina por likes, depois por data", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const titles = ["zero", "um", "dois", "tres"];
    for (const [i, title] of titles.entries()) {
      const p = await makePost(author.id, { title });
      await db.update(posts).set({ likesCount: i }).where(eq(posts.id, p.id));
    }
    const repo = postsRepo(db);
    const first = await repo.list({ filter: "top", limit: 2 });
    expect(first.items.map((p) => p.title)).toEqual(["tres", "dois"]);
    const second = await repo.list({
      filter: "top",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((p) => p.title)).toEqual(["um", "zero"]);
    expect(second.nextCursor).toBeNull();
  });

  it("liked pagina pelo momento do like (mais recente primeiro)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const a = await makePost(author.id, { title: "A" });
    const b = await makePost(author.id, { title: "B" });
    const c = await makePost(author.id, { title: "C" });
    // Curtidos por ordem B, A, C — a ordem do feed é a inversa: C, A, B.
    for (const post of [b, a, c]) {
      await makeLike(post.id, viewer.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    const repo = postsRepo(db);
    const first = await repo.list({
      filter: "liked",
      viewerId: viewer.id,
      limit: 2,
    });
    expect(first.items.map((p) => p.title)).toEqual(["C", "A"]);
    const second = await repo.list({
      filter: "liked",
      viewerId: viewer.id,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((p) => p.title)).toEqual(["B"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("postsRepo.setStatus — publishedAt", () => {
  it("aprovar um post em revisão preenche publishedAt, uma só vez", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const repo = postsRepo(db);
    expect(post.publishedAt).toBeNull();

    const approved = await repo.setStatus(post.id, "published");
    expect(approved?.publishedAt).toBeInstanceOf(Date);

    await repo.setStatus(post.id, "hidden");
    const again = await repo.setStatus(post.id, "published");
    // Não volta a mudar: a data da primeira publicação mantém-se.
    expect(again?.publishedAt?.getTime()).toBe(
      approved?.publishedAt?.getTime(),
    );
  });
});

describe("postLikesRepo.listLikedPostIds", () => {
  it("devolve os mais recentes e diz quando cortou", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    for (let i = 0; i < 3; i++) {
      const p = await makePost(author.id);
      await makeLike(p.id, viewer.id);
    }
    const repo = postLikesRepo(db);
    const all = await repo.listLikedPostIds(viewer.id, 3);
    expect(all.ids).toHaveLength(3);
    expect(all.truncated).toBe(false);
    const cut = await repo.listLikedPostIds(viewer.id, 2);
    expect(cut.ids).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    expect(await repo.findLikedPostIds(viewer.id, [])).toEqual([]);
  });
});
