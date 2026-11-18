import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { postsRepo } from "../../src/repositories/posts.js";
import { buildServer } from "../../src/server.js";
import { cardsRepo } from "../../src/repositories/cards.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import {
  makeLike,
  makePost,
  makeUserWithPassword,
} from "../helpers/factories.js";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
} as const;

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let redis: Redis | null = null;
let counter = 0;

const uuid = () =>
  `0190a0a0-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
const key = () => `sync-chave-${String(++counter).padStart(8, "0")}-abcdef`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function account(a: App = app, role: "user" | "admin" = "user") {
  const { user, plainPassword } = await makeUserWithPassword({ role });
  const res = await request(a.server)
    .post("/auth/login")
    .send({ username: user.username, password: plainPassword });
  return { user, token: res.body.accessToken as string };
}

const op = {
  create: (extra: Record<string, unknown> = {}, k = key()) => ({
    op_id: uuid(),
    idempotency_key: k,
    type: "post.create",
    payload: {
      category: "entendimento",
      title: "Offline",
      content: "Escrito sem rede.",
      ...extra,
    },
  }),
  postOp: (
    type: string,
    postId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    op_id: uuid(),
    idempotency_key: key(),
    type,
    payload: { postId, ...extra },
  }),
};

function sync(a: App, token: string, operations: unknown[]) {
  return request(a.server)
    .post("/sync")
    .set(bearer(token))
    .send({ operations });
}

async function flush(): Promise<void> {
  if (!redis) return;
  for (const pattern of ["cc:v1:feed:*", "rl:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

beforeAll(async () => {
  await getTestDb();
  if (process.env.REDIS_URL) redis = new Redis(process.env.REDIS_URL);
  app = await buildServer({ env: loadEnv(baseEnv) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await redis?.quit();
  await closeTestDb();
});
beforeEach(async () => {
  await truncateAll();
  await flush();
});

describe("POST /sync", () => {
  it("sem sessão → 401 antes de validar o corpo", async () => {
    const res = await request(app.server).post("/sync").send({});
    expect(res.status).toBe(401);
  });

  it("lote vazio, demais operações, op_id repetido ou campos a mais → 400", async () => {
    const { token } = await account();
    expect((await sync(app, token, [])).status).toBe(400);
    const many = Array.from({ length: 21 }, () => op.create());
    expect((await sync(app, token, many)).status).toBe(400);

    const one = op.create();
    const dup = await sync(app, token, [
      one,
      { ...op.create(), op_id: one.op_id },
    ]);
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe("validation_error");

    const extra = op.create({ authorId: "x" });
    expect((await sync(app, token, [extra])).status).toBe(400);
  });

  it("aplica o lote por ordem; repetir o lote devolve `duplicate` sem repetir efeitos", async () => {
    const author = await account();
    const me = await account();
    const target = await makePost(author.user.id);

    const create = op.create();
    const like = op.postOp("post.like", target.id);
    const report = op.postOp("post.report", target.id, { category: "spam" });
    const batch = [create, like, report];

    const first = await sync(app, me.token, batch);
    expect(first.status).toBe(200);
    expect(first.body.results.map((r: { op_id: string }) => r.op_id)).toEqual(
      batch.map((o) => o.op_id),
    );
    expect(first.body.results.map((r: { status: string }) => r.status)).toEqual(
      ["applied", "applied", "applied"],
    );
    expect(first.body.results[0].result.status).toBe("published");
    expect(first.body.results[1].result).toEqual({
      likesCount: 1,
      isLiked: true,
    });
    expect(first.body.results[2].result).toEqual({ outcome: "created" });
    expect(first.body.results[0].result).not.toHaveProperty("replayed");

    const second = await sync(app, me.token, batch);
    expect(
      second.body.results.map((r: { status: string }) => r.status),
    ).toEqual(["duplicate", "duplicate", "duplicate"]);
    // O post criado é o mesmo e só há um.
    expect(second.body.results[0].result.post.id).toBe(
      first.body.results[0].result.post.id,
    );
    const db = await getTestDb();
    expect(await postsRepo(db).countByAuthor(me.user.id)).toBe(1);
  });

  it("apagar e retirar: applied na 1.ª vez, duplicate na 2.ª", async () => {
    const author = await account();
    const reporter = await account();
    const post = await makePost(author.user.id);
    await sync(app, reporter.token, [
      op.postOp("post.report", post.id, { category: "spam" }),
    ]);

    const unreport = op.postOp("post.unreport", post.id);
    const r1 = await sync(app, reporter.token, [unreport]);
    expect(r1.body.results[0]).toMatchObject({
      status: "applied",
      result: { withdrawn: true },
    });
    const r2 = await sync(app, reporter.token, [
      { ...unreport, op_id: uuid() },
    ]);
    expect(r2.body.results[0].status).toBe("duplicate");

    const del = op.postOp("post.delete", post.id);
    const d1 = await sync(app, author.token, [del]);
    expect(d1.body.results[0]).toMatchObject({
      status: "applied",
      result: { deleted: true },
    });
    const d2 = await sync(app, author.token, [{ ...del, op_id: uuid() }]);
    expect(d2.body.results[0].status).toBe("duplicate");
  });

  it("erro de uma operação não impede as outras (rejected com o código)", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    const res = await sync(app, author.token, [
      op.postOp("post.like", "0190a0a0-0000-7000-8000-00000000ffff"),
      op.postOp("post.report", post.id, { category: "spam" }), // o próprio post
      op.create({ content: "vê https://exemplo.com" }),
      op.create({ content: "liga +258 84 123 4567" }),
      op.create({ gospelCardSlug: "nao-existe" }),
      op.create(),
    ]);
    expect(res.status).toBe(200);
    const out = res.body.results as {
      status: string;
      error?: { code: string };
    }[];
    expect(out.map((r) => [r.status, r.error?.code])).toEqual([
      ["rejected", "not_found"],
      ["rejected", "own_post"],
      ["rejected", "contains_link"],
      ["rejected", "contains_contact"],
      ["rejected", "gospel_card_not_found"],
      ["applied", undefined],
    ]);
  });

  it("mesma chave com outro corpo → rejected idempotency_key_conflict", async () => {
    const { token } = await account();
    const k = key();
    await sync(app, token, [op.create({}, k)]);
    const res = await sync(app, token, [op.create({ title: "Outro" }, k)]);
    expect(res.body.results[0]).toMatchObject({
      status: "rejected",
      error: { code: "idempotency_key_conflict" },
    });
  });

  it("a mesma chave em operações de tipos diferentes: só a primeira passa", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    const other = await account();
    const k = key();
    const like = { ...op.postOp("post.like", post.id), idempotency_key: k };
    const create = op.create({}, k);
    const res = await sync(app, other.token, [like, create]);
    const out = res.body.results as {
      status: string;
      error?: { code: string };
    }[];
    expect(out.map((r) => [r.status, r.error?.code])).toEqual([
      ["applied", undefined],
      ["rejected", "idempotency_key_conflict"],
    ]);
    // A criação recusada não deixou nada.
    const db = await getTestDb();
    expect(await postsRepo(db).listByAuthor(other.user.id, 10)).toHaveLength(0);
  });

  it("chave de uma criação já gravada, reutilizada por outro tipo (outro lote) → rejected", async () => {
    const { token, user } = await account();
    const post = await makePost(user.id);
    const k = key();
    await sync(app, token, [op.create({}, k)]);
    const del = { ...op.postOp("post.delete", post.id), idempotency_key: k };
    const res = await sync(app, token, [del]);
    expect(res.body.results[0]).toMatchObject({
      status: "rejected",
      error: { code: "idempotency_key_conflict" },
    });
    // O post alheio ao conflito continua lá.
    const db = await getTestDb();
    expect((await postsRepo(db).findById(post.id))?.deletedAt).toBeNull();
  });

  it("chaves iguais mas do mesmo tipo e operações naturalmente idempotentes não conflituam", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    const other = await account();
    const k = key();
    const like = { ...op.postOp("post.like", post.id), idempotency_key: k };
    const again = { ...op.postOp("post.like", post.id), idempotency_key: k };
    const res = await sync(app, other.token, [like, again]);
    expect(
      (res.body.results as { status: string }[]).map((r) => r.status),
    ).toEqual(["applied", "duplicate"]);
  });

  it("conta em apagamento: tudo rejected com forbidden", async () => {
    const { token, user } = await account();
    const db = await getTestDb();
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, user.id));
    const res = await sync(app, token, [op.create()]);
    expect(res.body.results[0]).toMatchObject({
      status: "rejected",
      error: { code: "forbidden" },
    });
  });

  it("post em revisão no lote: applied, mas não invalida nem aparece no feed público", async () => {
    const { token } = await account();
    const res = await sync(app, token, [
      op.create({
        title: "A".repeat(60),
        content: "B".repeat(60),
      }),
    ]);
    expect(res.body.results[0].result.status).toBe("pending_review");
    expect((await request(app.server).get("/posts")).body.posts).toHaveLength(
      0,
    );
  });

  it("a criação em lote invalida o feed (aparece logo)", async () => {
    const { token } = await account();
    await request(app.server).get("/posts");
    await sync(app, token, [op.create()]);
    expect((await request(app.server).get("/posts")).body.posts).toHaveLength(
      1,
    );
  });
});

describe("POST /sync — limites por operação (D5)", () => {
  let limited: App;
  beforeAll(async () => {
    limited = await buildServer({
      env: loadEnv({ ...baseEnv, RATE_LIMIT_LIKES_MAX: 2 }),
    });
    await limited.ready();
  });
  afterAll(async () => {
    await limited.close();
  });

  it("operações acima do limite do tipo voltam `deferred` com rate_limited e retryAfter", async () => {
    const author = await account(limited);
    const me = await account(limited);
    const posts = [];
    for (let i = 0; i < 4; i++) posts.push(await makePost(author.user.id));

    const res = await sync(
      limited,
      me.token,
      posts.map((p) => op.postOp("post.like", p.id)),
    );
    expect(res.status).toBe(200);
    const out = res.body.results as {
      status: string;
      error?: { code: string; retryAfter?: number };
    }[];
    expect(out.map((r) => r.status)).toEqual([
      "applied",
      "applied",
      "deferred",
      "deferred",
    ]);
    expect(out[2]?.error?.code).toBe("rate_limited");
    expect(out[2]?.error?.retryAfter).toBeGreaterThan(0);
  });

  it("os likes consumidos no REST contam para o /sync (mesmo balde)", async () => {
    const author = await account(limited);
    const me = await account(limited);
    const a = await makePost(author.user.id);
    const b = await makePost(author.user.id);
    const c = await makePost(author.user.id);
    await request(limited.server)
      .post(`/posts/${a.id}/like`)
      .set(bearer(me.token));
    await request(limited.server)
      .post(`/posts/${b.id}/like`)
      .set(bearer(me.token));

    const res = await sync(limited, me.token, [op.postOp("post.like", c.id)]);
    expect(res.body.results[0].status).toBe("deferred");
  });
});

describe("POST /sync — limite do lote", () => {
  it("pedidos /sync acima do limite → 429 com Retry-After", async () => {
    const tight = await buildServer({
      env: loadEnv({ ...baseEnv, RATE_LIMIT_SYNC_MAX: 1 }),
    });
    await tight.ready();
    try {
      const { token } = await account(tight);
      expect((await sync(tight, token, [op.create()])).status).toBe(200);
      const blocked = await sync(tight, token, [op.create()]);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: "rate_limited" });
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await tight.close();
    }
  });
});

describe("GET /sync/bootstrap", () => {
  it("sem sessão → 401", async () => {
    expect((await request(app.server).get("/sync/bootstrap")).status).toBe(401);
  });

  it("devolve o estado do utilizador sem expor authorId", async () => {
    const me = await account();
    const other = await account();
    const db = await getTestDb();
    await cardsRepo(db).create({
      slug: "card-001",
      title: "Card",
      gospelReference: "Mateus 2",
      summary: "Resumo",
      otReferences: [],
      ntReferences: [],
      orderIndex: 1,
    });
    const mine = await makePost(me.user.id, { title: "minha" });
    const pending = await makePost(me.user.id, {
      title: "em revisão",
      status: "pending_review",
    });
    const liked = await makePost(other.user.id, { title: "dele" });
    await makeLike(liked.id, me.user.id);
    await sync(app, me.token, [
      op.postOp("post.report", liked.id, { category: "spam" }),
    ]);
    await sync(app, me.token, [op.postOp("post.unreport", liked.id)]);

    const res = await request(app.server)
      .get("/sync/bootstrap")
      .set(bearer(me.token));
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.user).toMatchObject({
      id: me.user.id,
      username: me.user.username,
    });
    expect(body.cards.map((c: { slug: string }) => c.slug)).toEqual([
      "card-001",
    ]);

    const myIds = body.myPosts.map((p: { id: string }) => p.id);
    expect(myIds).toContain(mine.id);
    expect(myIds).toContain(pending.id);
    expect(body.myPostsTruncated).toBe(false);

    expect(body.myLikedPostIds).toEqual([liked.id]);
    expect(body.myLikedPostIdsTruncated).toBe(false);

    const recent = body.recentPosts.posts as {
      id: string;
      isMine: boolean;
      isLiked: boolean;
    }[];
    expect(recent.find((p) => p.id === mine.id)?.isMine).toBe(true);
    expect(recent.find((p) => p.id === liked.id)?.isLiked).toBe(true);
    expect(recent.map((p) => p.id)).not.toContain(pending.id);

    expect(body.myReports).toHaveLength(1);
    expect(body.myReports[0]).toMatchObject({
      postId: liked.id,
      category: "spam",
      status: "withdrawn",
    });
    expect(body.myReportsTruncated).toBe(false);

    // Os outros utilizadores nunca aparecem pelo identificador.
    expect(JSON.stringify(body.recentPosts)).not.toContain(other.user.id);
    expect(JSON.stringify(body.myPosts)).not.toContain('"authorId"');
  });

  it("conta em apagamento → 403 account_inactive", async () => {
    const { token, user } = await account();
    const db = await getTestDb();
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, user.id));
    const res = await request(app.server)
      .get("/sync/bootstrap")
      .set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_inactive");
  });
});
