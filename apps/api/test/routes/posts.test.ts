import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { postsRepo } from "../../src/repositories/posts.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import {
  makeLike,
  makePost,
  makeUserWithPassword,
} from "../helpers/factories.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
});

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let redis: Redis | null = null;
let keyCounter = 0;

const idem = () =>
  `chave-teste-${String(++keyCounter).padStart(8, "0")}-abcdef`;

async function account(role: "user" | "admin" = "user") {
  const { user, plainPassword } = await makeUserWithPassword({ role });
  const res = await request(app.server)
    .post("/auth/login")
    .send({ username: user.username, password: plainPassword });
  expect(res.status).toBe(200);
  return { user, token: res.body.accessToken as string };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function create(token: string, body: Record<string, unknown>, key = idem()) {
  return request(app.server)
    .post("/posts")
    .set(bearer(token))
    .set("Idempotency-Key", key)
    .send({
      category: "entendimento",
      title: "Uma partilha",
      content: "O que entendi da leitura de hoje.",
      ...body,
    });
}

beforeAll(async () => {
  await getTestDb();
  if (process.env.REDIS_URL) redis = new Redis(process.env.REDIS_URL);
  app = await buildServer({ env });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await redis?.quit();
  await closeTestDb();
});
beforeEach(async () => {
  await truncateAll();
  if (redis) {
    const keys = await redis.keys("cc:v1:feed:*");
    if (keys.length > 0) await redis.del(...keys);
  }
});

describe("GET /posts", () => {
  it("anónimo: só publicados, sem authorId, isLiked/isMine a false", async () => {
    const { user } = await account();
    await makePost(user.id, { title: "visível" });
    await makePost(user.id, { title: "revisão", status: "pending_review" });

    const res = await request(app.server).get("/posts");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.posts).toHaveLength(1);
    const post = res.body.posts[0];
    expect(post.title).toBe("visível");
    expect(post.author).toEqual({ username: user.username });
    expect(post.isLiked).toBe(false);
    expect(post.isMine).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(user.id);
    expect(post).not.toHaveProperty("authorId");
  });

  it("autenticado: isLiked e isMine por espectador (mesma página em cache)", async () => {
    const a = await account();
    const b = await account();
    const post = await makePost(a.user.id);
    await makeLike(post.id, b.user.id);

    const asA = await request(app.server).get("/posts").set(bearer(a.token));
    const asB = await request(app.server).get("/posts").set(bearer(b.token));
    const anon = await request(app.server).get("/posts");
    expect(asA.body.posts[0]).toMatchObject({ isMine: true, isLiked: false });
    expect(asB.body.posts[0]).toMatchObject({ isMine: false, isLiked: true });
    expect(anon.body.posts[0]).toMatchObject({ isMine: false, isLiked: false });
  });

  it("token inválido ou esquema errado → 401 (não degrada para anónimo)", async () => {
    const bad = await request(app.server)
      .get("/posts")
      .set("Authorization", "Bearer lixo");
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("invalid_token");
    const scheme = await request(app.server)
      .get("/posts")
      .set("Authorization", "Basic abc");
    expect(scheme.status).toBe(401);
  });

  it("o autor vê no topo a sua partilha em revisão, só na 1.ª página", async () => {
    const a = await account();
    const other = await account();
    await makePost(other.user.id, { title: "de outro" });
    const pending = await makePost(a.user.id, {
      title: "minha em revisão",
      status: "pending_review",
    });

    const mine = await request(app.server).get("/posts").set(bearer(a.token));
    expect(mine.body.posts.map((p: { id: string }) => p.id)[0]).toBe(
      pending.id,
    );
    expect(mine.body.posts[0].isMine).toBe(true);
    expect(mine.body.posts).toHaveLength(2);

    const others = await request(app.server)
      .get("/posts")
      .set(bearer(other.token));
    expect(others.body.posts).toHaveLength(1);
  });

  it("pagina por cursor sem repetir nem saltar; limite respeitado", async () => {
    const { user } = await account();
    for (let i = 0; i < 5; i++) await makePost(user.id, { title: `P${i}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: request.Response = await request(app.server)
        .get("/posts")
        .query({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.posts.map((p: { id: string }) => p.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("cursor adulterado ou de outro filtro → 400 validation_error", async () => {
    const bad = await request(app.server)
      .get("/posts")
      .query({ cursor: "abc" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("validation_error");
    expect(bad.body.fields).toHaveProperty("cursor");

    const { user } = await account();
    for (let i = 0; i < 3; i++) await makePost(user.id);
    const p1 = await request(app.server).get("/posts").query({ limit: 2 });
    const wrong = await request(app.server)
      .get("/posts")
      .query({ limit: 2, filter: "top", cursor: p1.body.nextCursor });
    expect(wrong.status).toBe(400);
  });

  it("filter=liked: exige sessão e devolve só os curtidos", async () => {
    const a = await account();
    const author = await account();
    const liked = await makePost(author.user.id, { title: "curtido" });
    await makePost(author.user.id, { title: "outro" });
    await makeLike(liked.id, a.user.id);

    const anon = await request(app.server)
      .get("/posts")
      .query({ filter: "liked" });
    expect(anon.status).toBe(401);

    const res = await request(app.server)
      .get("/posts")
      .query({ filter: "liked" })
      .set(bearer(a.token));
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { title: string }) => p.title)).toEqual([
      "curtido",
    ]);
    expect(res.body.posts[0].isLiked).toBe(true);
  });

  it("autor com conta em apagamento aparece como [removido] (author null)", async () => {
    const a = await account();
    await makePost(a.user.id);
    const db = await getTestDb();
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, a.user.id));
    const res = await request(app.server).get("/posts");
    expect(res.body.posts[0].author).toBeNull();
  });
});

describe("POST /posts", () => {
  it("sem sessão → 401 antes de validar o corpo", async () => {
    const res = await request(app.server).post("/posts").send({ lixo: true });
    expect(res.status).toBe(401);
  });

  it("cria (201), e a mesma chave repete a resposta (200) sem criar outro", async () => {
    const { token, user } = await account();
    const key = idem();
    const first = await create(token, {}, key);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("published");
    expect(first.body.post.isMine).toBe(true);
    expect(first.body).not.toHaveProperty("replayed");

    const again = await create(token, {}, key);
    expect(again.status).toBe(200);
    expect(again.body.post.id).toBe(first.body.post.id);

    const db = await getTestDb();
    expect(await postsRepo(db).countByAuthor(user.id)).toBe(1);
  });

  it("mesma chave com outro corpo → 409 idempotency_key_conflict", async () => {
    const { token } = await account();
    const key = idem();
    await create(token, {}, key);
    const res = await create(token, { title: "Outro título" }, key);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("idempotency_key_conflict");
  });

  it("sem Idempotency-Key → 400 validation_error", async () => {
    const { token } = await account();
    const res = await request(app.server)
      .post("/posts")
      .set(bearer(token))
      .send({ category: "entendimento", title: "T", content: "C" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("link e contacto → 400 com o código", async () => {
    const { token } = await account();
    const link = await create(token, {
      content: "vê https://exemplo.com agora",
    });
    expect(link.status).toBe(400);
    expect(link.body.error).toBe("contains_link");
    const phone = await create(token, { content: "liga +258 84 123 4567" });
    expect(phone.status).toBe(400);
    expect(phone.body.error).toBe("contains_contact");
  });

  it("post novo aparece logo no feed (a criação invalida a cache)", async () => {
    const { token } = await account();
    const before = await request(app.server).get("/posts");
    expect(before.body.posts).toHaveLength(0);
    await create(token, {});
    const after = await request(app.server).get("/posts");
    expect(after.body.posts).toHaveLength(1);
  });

  it("sinal de spam → pending_review: fora do feed público, visível ao autor", async () => {
    const { token } = await account();
    const res = await create(token, {
      title: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      content: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_review");
    const pub = await request(app.server).get("/posts");
    expect(pub.body.posts).toHaveLength(0);
    const mine = await request(app.server).get("/posts").set(bearer(token));
    expect(mine.body.posts).toHaveLength(1);
  });

  it("conta em apagamento não escreve → 403 account_inactive", async () => {
    const { token, user } = await account();
    const db = await getTestDb();
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, user.id));
    const res = await create(token, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_inactive");
  });
});

describe("GET /posts/:id (visibilidade)", () => {
  it("publicado: qualquer pessoa; inexistente e id inválido", async () => {
    const { user } = await account();
    const post = await makePost(user.id);
    const res = await request(app.server).get(`/posts/${post.id}`);
    expect(res.status).toBe(200);
    expect(res.body.post.id).toBe(post.id);

    const missing = await request(app.server).get(
      "/posts/0190a0a0-0000-7000-8000-000000000099",
    );
    expect(missing.status).toBe(404);
    const invalid = await request(app.server).get("/posts/nao-e-uuid");
    expect(invalid.status).toBe(400);
  });

  it("em revisão/oculto/rejeitado: 404 para anónimos e outros; 200 para autor e admin", async () => {
    const author = await account();
    const other = await account();
    const admin = await account("admin");

    for (const status of ["pending_review", "hidden", "rejected"] as const) {
      const post = await makePost(author.user.id, { status });
      const path = `/posts/${post.id}`;
      expect((await request(app.server).get(path)).status).toBe(404);
      expect(
        (await request(app.server).get(path).set(bearer(other.token))).status,
      ).toBe(404);
      const own = await request(app.server).get(path).set(bearer(author.token));
      expect(own.status).toBe(200);
      expect(own.body.post.status).toBe(status);
      expect(
        (await request(app.server).get(path).set(bearer(admin.token))).status,
      ).toBe(200);
    }
  });

  it("admin despromovido (JWT antigo) deixa de ver", async () => {
    const author = await account();
    const admin = await account("admin");
    const post = await makePost(author.user.id, { status: "hidden" });
    const db = await getTestDb();
    await db
      .update(users)
      .set({ role: "user" })
      .where(eq(users.id, admin.user.id));
    const res = await request(app.server)
      .get(`/posts/${post.id}`)
      .set(bearer(admin.token));
    expect(res.status).toBe(404);
  });

  it("apagado pelo autor: 404 para todos, incluindo o autor", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    const del = await request(app.server)
      .delete(`/posts/${post.id}`)
      .set(bearer(author.token));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect(
      (
        await request(app.server)
          .get(`/posts/${post.id}`)
          .set(bearer(author.token))
      ).status,
    ).toBe(404);
  });
});

describe("DELETE /posts/:id", () => {
  it("só o autor; os outros recebem 404; repetir é idempotente; sai do feed", async () => {
    const author = await account();
    const other = await account();
    const post = await makePost(author.user.id);
    await request(app.server).get("/posts"); // aquece a cache

    const foreign = await request(app.server)
      .delete(`/posts/${post.id}`)
      .set(bearer(other.token));
    expect(foreign.status).toBe(404);

    const ok = await request(app.server)
      .delete(`/posts/${post.id}`)
      .set(bearer(author.token));
    expect(ok.status).toBe(200);
    const again = await request(app.server)
      .delete(`/posts/${post.id}`)
      .set(bearer(author.token));
    expect(again.status).toBe(200);

    const feed = await request(app.server).get("/posts");
    expect(feed.body.posts).toHaveLength(0);
  });

  it("sem sessão → 401", async () => {
    const res = await request(app.server).delete(
      "/posts/0190a0a0-0000-7000-8000-000000000099",
    );
    expect(res.status).toBe(401);
  });
});

describe("likes", () => {
  it("curtir/descurtir é idempotente e actualiza o contador", async () => {
    const author = await account();
    const fan = await account();
    const post = await makePost(author.user.id);
    const url = `/posts/${post.id}/like`;

    const a = await request(app.server).post(url).set(bearer(fan.token));
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ likesCount: 1, isLiked: true });
    const b = await request(app.server).post(url).set(bearer(fan.token));
    expect(b.body).toEqual({ likesCount: 1, isLiked: true });

    const c = await request(app.server).delete(url).set(bearer(fan.token));
    expect(c.body).toEqual({ likesCount: 0, isLiked: false });
    const d = await request(app.server).delete(url).set(bearer(fan.token));
    expect(d.body).toEqual({ likesCount: 0, isLiked: false });
  });

  it("post inexistente ou em revisão → 404; sem sessão → 401", async () => {
    const author = await account();
    const fan = await account();
    const pending = await makePost(author.user.id, {
      status: "pending_review",
    });
    expect(
      (
        await request(app.server)
          .post(`/posts/${pending.id}/like`)
          .set(bearer(fan.token))
      ).status,
    ).toBe(404);
    expect(
      (await request(app.server).post(`/posts/${pending.id}/like`)).status,
    ).toBe(401);
  });

  it("curtir não invalida a cache pública (D7), mas o espectador vê o seu isLiked", async () => {
    const author = await account();
    const fan = await account();
    const post = await makePost(author.user.id);
    await request(app.server).get("/posts"); // aquece
    await request(app.server)
      .post(`/posts/${post.id}/like`)
      .set(bearer(fan.token));

    const anon = await request(app.server).get("/posts");
    expect(anon.body.posts[0].likesCount).toBe(redis ? 0 : 1);
    const mine = await request(app.server).get("/posts").set(bearer(fan.token));
    expect(mine.body.posts[0].isLiked).toBe(true);
  });
});

describe("denúncias", () => {
  it("categoria obrigatória; «other» exige motivo; erros no formato único", async () => {
    const author = await account();
    const reporter = await account();
    const post = await makePost(author.user.id);
    const url = `/posts/${post.id}/report`;

    const noCategory = await request(app.server)
      .post(url)
      .set(bearer(reporter.token))
      .send({});
    expect(noCategory.status).toBe(400);
    expect(noCategory.body.error).toBe("validation_error");

    const noReason = await request(app.server)
      .post(url)
      .set(bearer(reporter.token))
      .send({ category: "other" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.fields).toHaveProperty("reason");
  });

  it("não se denuncia o próprio post (400 own_post) nem um inexistente (404)", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    const own = await request(app.server)
      .post(`/posts/${post.id}/report`)
      .set(bearer(author.token))
      .send({ category: "spam" });
    expect(own.status).toBe(400);
    expect(own.body).toEqual({ error: "own_post" });

    const missing = await request(app.server)
      .post("/posts/0190a0a0-0000-7000-8000-000000000099/report")
      .set(bearer(author.token))
      .send({ category: "spam" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not_found" });
  });

  it("criar (200 created), repetir (200 duplicate), retirar (200) e repetir retirar", async () => {
    const author = await account();
    const reporter = await account();
    const post = await makePost(author.user.id);
    const url = `/posts/${post.id}/report`;
    const send = () =>
      request(app.server)
        .post(url)
        .set(bearer(reporter.token))
        .send({ category: "offensive" });

    expect((await send()).body).toEqual({ outcome: "created" });
    expect((await send()).body).toEqual({ outcome: "duplicate" });

    const del = () =>
      request(app.server).delete(url).set(bearer(reporter.token));
    expect((await del()).body).toEqual({ withdrawn: true });
    expect((await del()).body).toEqual({ withdrawn: true });
    // Retirada continua a contar como «já denunciou» (D2).
    expect((await send()).body).toEqual({ outcome: "duplicate" });
  });

  it("retirar sem nunca ter denunciado → 404", async () => {
    const author = await account();
    const reporter = await account();
    const post = await makePost(author.user.id);
    const res = await request(app.server)
      .delete(`/posts/${post.id}/report`)
      .set(bearer(reporter.token));
    expect(res.status).toBe(404);
  });

  it("a denúncia que escala o post tira-o do feed logo (invalida a cache)", async () => {
    const author = await account();
    const post = await makePost(author.user.id);
    expect((await request(app.server).get("/posts")).body.posts).toHaveLength(
      1,
    );

    const db = await getTestDb();
    for (let i = 0; i < 3; i++) {
      const reporter = await makeUserWithPassword();
      await db
        .update(users)
        .set({ createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
        .where(eq(users.id, reporter.user.id));
      await makePost(reporter.user.id);
      const login = await request(app.server)
        .post("/auth/login")
        .send({
          username: reporter.user.username,
          password: reporter.plainPassword,
        });
      const res = await request(app.server)
        .post(`/posts/${post.id}/report`)
        .set(bearer(login.body.accessToken))
        .send({ category: "doctrine" });
      expect(res.body).toEqual({ outcome: "created" });
    }
    const feed = await request(app.server).get("/posts");
    expect(feed.body.posts.map((p: { id: string }) => p.id)).not.toContain(
      post.id,
    );
  });
});
