import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  idempotencyKeys,
  outbox,
  posts,
  reports,
} from "../../src/db/schema.js";
import { cardsRepo } from "../../src/repositories/cards.js";
import { REPORTER_MIN_AGE_DAYS } from "../../src/repositories/reports.js";
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
} from "../../src/services/posts.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeLike, makePost, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = () => `chave-${crypto.randomUUID()}`;
const INPUT = {
  category: "entendimento" as const,
  title: "Título",
  content: "Conteúdo da partilha.",
};

async function eventsOf(type: string) {
  const db = await getTestDb();
  return db.select().from(outbox).where(eq(outbox.eventType, type));
}

describe("createPostService", () => {
  it("cria o post, devolve-o no formato público e regista o evento", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const result = await createPostService({ db }, user.id, INPUT, KEY());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("published");
    expect(result.data.replayed).toBe(false);
    expect(result.data.post).toMatchObject({
      title: "Título",
      isMine: true,
      isLiked: false,
      author: { username: user.username },
    });
    expect("authorId" in result.data.post).toBe(false);
    expect(await eventsOf("post.created")).toHaveLength(1);
  });

  it("mesma chave e mesmo corpo repete a resposta sem criar outro post", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const key = KEY();
    const first = await createPostService({ db }, user.id, INPUT, key);
    const second = await createPostService({ db }, user.id, INPUT, key);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.post.id).toBe(first.data.post.id);
    expect(second.data.replayed).toBe(true);
    expect(await db.select().from(posts)).toHaveLength(1);
    expect(await eventsOf("post.created")).toHaveLength(1);
  });

  it("mesma chave com OUTRO corpo é um conflito (409), não uma repetição", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const key = KEY();
    await createPostService({ db }, user.id, INPUT, key);
    const result = await createPostService(
      { db },
      user.id,
      { ...INPUT, title: "Outro título" },
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "idempotency_key_conflict",
      status: 409,
    });
    expect(await db.select().from(posts)).toHaveLength(1);
  });

  it("dois pedidos CONCORRENTES com a mesma chave criam um só post", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const key = KEY();
    const [a, b] = await Promise.all([
      createPostService({ db }, user.id, INPUT, key),
      createPostService({ db }, user.id, INPUT, key),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.post.id).toBe(b.data.post.id);
    expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
    expect(await db.select().from(posts)).toHaveLength(1);
  });

  it("a chave é por utilizador", async () => {
    const db = await getTestDb();
    const a = await makeUser();
    const b = await makeUser();
    const key = KEY();
    const first = await createPostService({ db }, a.id, INPUT, key);
    const second = await createPostService({ db }, b.id, INPUT, key);
    expect(first.ok && second.ok).toBe(true);
    expect(await db.select().from(posts)).toHaveLength(2);
  });

  it("link ou contacto são rejeitados e não gastam a chave", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const key = KEY();
    const link = await createPostService(
      { db },
      user.id,
      { ...INPUT, content: "veja igreja.org" },
      key,
    );
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.error.code).toBe("contains_link");

    const contact = await createPostService(
      { db },
      user.id,
      { ...INPUT, content: "ligue 912345678" },
      key,
    );
    expect(contact.ok).toBe(false);
    if (!contact.ok) expect(contact.error.code).toBe("contains_contact");

    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
    // Corrigido, a mesma chave serve.
    const fixed = await createPostService({ db }, user.id, INPUT, key);
    expect(fixed.ok).toBe(true);
  });

  it("sinais de spam vão para pending_review e ficam registados", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const result = await createPostService(
      { db },
      user.id,
      { ...INPUT, content: "ganhe dinheiro rápido com o nosso sorteio" },
      KEY(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_review");
    const [row] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, result.data.post.id));
    expect(row?.status).toBe("pending_review");
    expect(row?.publishedAt).toBeNull();
    expect(row?.reviewFlags).toEqual(["keywords"]);
  });

  it("conta nova NÃO vai para revisão só por ser nova (ADR-013)", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const result = await createPostService({ db }, user.id, INPUT, KEY());
    expect(result.ok && result.data.status).toBe("published");
  });

  it("gospelCardSlug inexistente → 400; existente liga o card", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const missing = await createPostService(
      { db },
      user.id,
      { ...INPUT, gospelCardSlug: "nao-existe" },
      KEY(),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("gospel_card_not_found");

    await cardsRepo(db).create({
      slug: "natividade",
      title: "Natividade",
      gospelReference: "Mateus 2",
      summary: "Resumo.",
      otReferences: [],
      ntReferences: [],
      orderIndex: 1,
    });
    const ok = await createPostService(
      { db },
      user.id,
      { ...INPUT, gospelCardSlug: "natividade" },
      KEY(),
    );
    expect(ok.ok && ok.data.post.gospelCardSlug).toBe("natividade");
  });

  it("é atómico: se a transacção de fora desfaz, não fica post, chave nem evento", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    await expect(
      db.transaction(async (tx) => {
        const result = await createPostService(
          { db: tx },
          user.id,
          INPUT,
          KEY(),
        );
        expect(result.ok).toBe(true);
        throw new Error("desfazer");
      }),
    ).rejects.toThrow("desfazer");
    expect(await db.select().from(posts)).toHaveLength(0);
    expect(await db.select().from(idempotencyKeys)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
  });
});

describe("conta em apagamento", () => {
  it("não pode criar, apagar, curtir, descurtir, denunciar nem retirar denúncia", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const leaver = await makeUser({ deletionRequestedAt: new Date() });
    const deps = { db };

    const results = await Promise.all([
      createPostService(deps, leaver.id, INPUT, KEY()),
      deletePostService(deps, leaver.id, post.id),
      likePostService(deps, leaver.id, post.id),
      unlikePostService(deps, leaver.id, post.id),
      reportPostService(deps, leaver.id, post.id, "spam", undefined),
      unreportPostService(deps, leaver.id, post.id),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ code: "account_inactive", status: 403 });
      }
    }
    expect(await db.select().from(reports)).toHaveLength(0);
  });
});

describe("deletePostService", () => {
  it("apaga (soft), é idempotente e não confirma posts alheios", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const other = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const foreign = await deletePostService(deps, other.id, post.id);
    expect(foreign).toEqual({
      ok: false,
      error: { code: "not_found", status: 404 },
    });

    const first = await deletePostService(deps, author.id, post.id);
    expect(first).toEqual({ ok: true, data: { deleted: true, changed: true } });
    const again = await deletePostService(deps, author.id, post.id);
    expect(again).toEqual({
      ok: true,
      data: { deleted: true, changed: false },
    });

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await eventsOf("post.deleted")).toHaveLength(1);

    const missing = await deletePostService(
      deps,
      author.id,
      crypto.randomUUID(),
    );
    expect(missing.ok).toBe(false);
  });

  it("um post apagado deixa de aceitar likes e denúncias", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const post = await makePost(author.id);
    await deletePostService({ db }, author.id, post.id);

    const like = await likePostService({ db }, viewer.id, post.id);
    expect(like.ok).toBe(false);
    const report = await reportPostService(
      { db },
      viewer.id,
      post.id,
      "spam",
      undefined,
    );
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error.code).toBe("not_found");
  });
});

describe("likes", () => {
  it("curtir e descurtir mantêm o contador certo e são idempotentes", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const first = await likePostService(deps, viewer.id, post.id);
    expect(first).toEqual({
      ok: true,
      data: { likesCount: 1, isLiked: true, changed: true },
    });
    const again = await likePostService(deps, viewer.id, post.id);
    expect(again).toEqual({
      ok: true,
      data: { likesCount: 1, isLiked: true, changed: false },
    });
    expect(await eventsOf("post.liked")).toHaveLength(1);

    const off = await unlikePostService(deps, viewer.id, post.id);
    expect(off).toEqual({
      ok: true,
      data: { likesCount: 0, isLiked: false, changed: true },
    });
    const offAgain = await unlikePostService(deps, viewer.id, post.id);
    expect(offAgain).toEqual({
      ok: true,
      data: { likesCount: 0, isLiked: false, changed: false },
    });
  });

  it("likes concorrentes de utilizadores diferentes somam todos", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const viewers = await Promise.all([1, 2, 3, 4, 5].map(() => makeUser()));
    await Promise.all(
      viewers.map((v) => likePostService({ db }, v.id, post.id)),
    );
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row?.likesCount).toBe(5);
  });

  it("só se curte um post publicado; descurtir permite-se noutros estados", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const hidden = await makePost(author.id, { status: "hidden" });
    await makeLike(hidden.id, viewer.id);

    const like = await likePostService({ db }, viewer.id, hidden.id);
    expect(like.ok).toBe(false);
    const unlike = await unlikePostService({ db }, viewer.id, hidden.id);
    expect(unlike.ok).toBe(true);
  });
});

describe("denúncias", () => {
  it("«other» exige motivo", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    const result = await reportPostService(
      { db },
      reporter.id,
      post.id,
      "other",
      "  ",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("reason_required");
  });

  it("cria, repete (duplicate) e recusa o próprio post", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const own = await reportPostService(
      deps,
      author.id,
      post.id,
      "spam",
      undefined,
    );
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.error.code).toBe("own_post");

    const first = await reportPostService(
      deps,
      reporter.id,
      post.id,
      "spam",
      undefined,
    );
    expect(first).toEqual({
      ok: true,
      data: { outcome: "created", changed: true },
    });
    const second = await reportPostService(
      deps,
      reporter.id,
      post.id,
      "spam",
      undefined,
    );
    expect(second).toEqual({
      ok: true,
      data: { outcome: "duplicate", changed: false },
    });
    expect(await eventsOf("post.reported")).toHaveLength(1);
  });

  it("3 denúncias válidas de doutrina escalam o post e geram o evento", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);

    for (let i = 0; i < 3; i++) {
      const reporter = await makeUser({
        createdAt: new Date(Date.now() - (REPORTER_MIN_AGE_DAYS + 1) * DAY_MS),
      });
      await makePost(reporter.id);
      const result = await reportPostService(
        { db },
        reporter.id,
        post.id,
        "doctrine",
        undefined,
      );
      expect(result.ok).toBe(true);
    }

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row?.status).toBe("pending_review");
    expect(row?.reviewFlags).toEqual(["reports_high"]);
    const escalated = await eventsOf("post.escalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.payload).toEqual({
      postId: post.id,
      severity: "high",
    });
  });

  it("retirar a denúncia é idempotente; sem denúncia é not_found", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const stranger = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };
    await reportPostService(deps, reporter.id, post.id, "spam", undefined);

    const first = await unreportPostService(deps, reporter.id, post.id);
    expect(first).toEqual({
      ok: true,
      data: { withdrawn: true, changed: true },
    });
    const again = await unreportPostService(deps, reporter.id, post.id);
    expect(again).toEqual({
      ok: true,
      data: { withdrawn: true, changed: false },
    });

    const never = await unreportPostService(deps, stranger.id, post.id);
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.error.code).toBe("not_found");

    // Retirada fica registada, não apagada, e o contador desceu.
    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("withdrawn");
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row?.reportsCount).toBe(0);
  });
});
