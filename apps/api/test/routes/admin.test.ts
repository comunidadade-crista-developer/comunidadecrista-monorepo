import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "@comunidade/shared";
import { users } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import {
  makePost,
  makeReport,
  makeUser,
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

async function loginAs(target: App, role: "user" | "admin", username?: string) {
  const { user, plainPassword } = await makeUserWithPassword({
    role,
    ...(username ? { username } : {}),
  });
  const res = await request(target.server)
    .post("/auth/login")
    .send({ username: user.username, password: plainPassword });
  expect(res.status).toBe(200);
  return { user, token: res.body.accessToken as string };
}

const admin = () => loginAs(app, "admin");
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function clearRedis() {
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
  await clearRedis();
});

const ID = "0190a0a0-0000-7000-8000-000000000001";

describe("autenticação e autorização", () => {
  const routes = [
    ["get", "/admin/posts"],
    ["get", `/admin/posts/${ID}`],
    ["post", `/admin/posts/${ID}/approve`],
    ["post", `/admin/posts/${ID}/reject`],
    ["get", "/admin/reports"],
    ["get", "/admin/moderation-log"],
  ] as const;

  it.each(routes)("%s %s sem sessão → 401", async (method, path) => {
    const res = await request(app.server)[method](path);
    expect(res.status).toBe(401);
  });

  it("sem sessão, o 401 precede a validação (corpo e query inválidos)", async () => {
    const bad = await request(app.server)
      .post(`/admin/posts/${ID}/reject`)
      .send({ reason: 1, extra: true });
    expect(bad.status).toBe(401);
    const query = await request(app.server).get("/admin/posts?limit=9999");
    expect(query.status).toBe(401);
  });

  it("token inválido → 401", async () => {
    const res = await request(app.server)
      .get("/admin/posts")
      .set(bearer("isto-nao-e-um-jwt"));
    expect(res.status).toBe(401);
  });

  it.each(routes)("%s %s com utilizador comum → 403", async (method, path) => {
    const { token } = await loginAs(app, "user");
    const res = await request(app.server)[method](path).set(bearer(token));
    expect(res.status).toBe(403);
  });

  it("um utilizador comum não vê a validação: 403 mesmo com corpo inválido", async () => {
    const { token } = await loginAs(app, "user");
    const res = await request(app.server)
      .post(`/admin/posts/${ID}/reject`)
      .set(bearer(token))
      .send({ reason: 1 });
    expect(res.status).toBe(403);
  });

  it("admin com apagamento de conta pendente → 403", async () => {
    const a = await admin();
    const db = await getTestDb();
    await db
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(users.id, a.user.id));
    const res = await request(app.server)
      .get("/admin/posts")
      .set(bearer(a.token));
    expect(res.status).toBe(403);
  });

  it("despromovido depois do login → 403 no pedido seguinte (token ainda válido)", async () => {
    const a = await admin();
    const db = await getTestDb();
    await db.update(users).set({ role: "user" }).where(eq(users.id, a.user.id));
    const res = await request(app.server)
      .get("/admin/posts")
      .set(bearer(a.token));
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/posts", () => {
  it("lista a fila do mais antigo para o mais recente, sem expor identificadores de utilizador", async () => {
    const a = await admin();
    const author = await makeUser({ username: "autora" });
    await makePost(author.id, {
      status: "pending_review",
      title: "Segundo",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    await makePost(author.id, {
      status: "pending_review",
      title: "Primeiro",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makePost(author.id, { status: "published", title: "Publicado" });

    const res = await request(app.server)
      .get("/admin/posts")
      .set(bearer(a.token));
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { title: string }) => p.title)).toEqual([
      "Primeiro",
      "Segundo",
    ]);
    expect(res.body.posts[0]).toMatchObject({
      author: { username: "autora" },
      reportsCount: 0,
      status: "pending_review",
    });
    expect(JSON.stringify(res.body)).not.toContain(author.id);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("pagina com nextCursor", async () => {
    const a = await admin();
    const author = await makeUser();
    for (let i = 0; i < 3; i++) {
      await makePost(author.id, {
        status: "pending_review",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }
    const p1 = await request(app.server)
      .get("/admin/posts?limit=2")
      .set(bearer(a.token));
    expect(p1.body.posts).toHaveLength(2);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await request(app.server)
      .get(`/admin/posts?limit=2&cursor=${p1.body.nextCursor}`)
      .set(bearer(a.token));
    expect(p2.status).toBe(200);
    expect(p2.body.posts).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("parâmetros inválidos → 400 (limite, estado, cursor adulterado ou de outra lista)", async () => {
    const a = await admin();
    const otherList = encodeCursor({
      k: "admin_log",
      t: "2026-01-01T00:00:00.000000Z",
      id: ID,
    });
    for (const qs of [
      "limit=51",
      "limit=0",
      "status=inventado",
      "cursor=%%%",
      "cursor=YWJj",
      `cursor=${otherList}`,
    ]) {
      const res = await request(app.server)
        .get(`/admin/posts?${qs}`)
        .set(bearer(a.token));
      expect(res.status, qs).toBe(400);
    }
  });
});

describe("GET /admin/posts/:id", () => {
  it("200 com detalhe, denúncias e decisões", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, {
      status: "pending_review",
      content: "Conteúdo completo",
    });
    await makeReport(post.id, (await makeUser({ username: "quem" })).id, {
      category: "doctrine",
    });
    const res = await request(app.server)
      .get(`/admin/posts/${post.id}`)
      .set(bearer(a.token));
    expect(res.status).toBe(200);
    expect(res.body.post.content).toBe("Conteúdo completo");
    expect(res.body.reports[0]).toMatchObject({
      reporter: { username: "quem" },
      category: "doctrine",
    });
    expect(res.body.moderation).toEqual([]);
  });

  it("inexistente → 404; id que não é UUID → 400", async () => {
    const a = await admin();
    const missing = await request(app.server)
      .get(`/admin/posts/${ID}`)
      .set(bearer(a.token));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not_found" });
    const bad = await request(app.server)
      .get("/admin/posts/nao-e-uuid")
      .set(bearer(a.token));
    expect(bad.status).toBe(400);
  });
});

describe("POST /admin/posts/:id/approve", () => {
  it("aprova, publica e o feed passa a mostrar o post (cache invalidada)", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, {
      status: "pending_review",
      title: "Para aprovar",
    });

    // Aquece a cache do feed sem o post.
    const before = await request(app.server).get("/posts");
    expect(before.body.posts).toHaveLength(0);

    const res = await request(app.server)
      .post(`/admin/posts/${post.id}/approve`)
      .set(bearer(a.token))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.post).toMatchObject({ id: post.id, status: "published" });

    const after = await request(app.server).get("/posts");
    expect(after.body.posts.map((p: { id: string }) => p.id)).toEqual([
      post.id,
    ]);
  });

  it("repetir → 409 invalid_state; nota vazia ou campo desconhecido → 400", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const url = `/admin/posts/${post.id}/approve`;

    for (const body of [{ note: "   " }, { outro: 1 }]) {
      const bad = await request(app.server)
        .post(url)
        .set(bearer(a.token))
        .send(body);
      expect(bad.status).toBe(400);
    }
    const ok = await request(app.server)
      .post(url)
      .set(bearer(a.token))
      .send({ note: "ok" });
    expect(ok.status).toBe(200);
    const again = await request(app.server)
      .post(url)
      .set(bearer(a.token))
      .send({});
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "invalid_state" });
  });

  it("post suspenso (hidden) → 409; inexistente → 404", async () => {
    const a = await admin();
    const author = await makeUser();
    const hidden = await makePost(author.id, {
      status: "hidden",
      suspendedStatus: "pending_review",
    });
    const suspended = await request(app.server)
      .post(`/admin/posts/${hidden.id}/approve`)
      .set(bearer(a.token))
      .send({});
    expect(suspended.status).toBe(409);
    const missing = await request(app.server)
      .post(`/admin/posts/${ID}/approve`)
      .set(bearer(a.token))
      .send({});
    expect(missing.status).toBe(404);
  });
});

describe("POST /admin/posts/:id/reject", () => {
  it("exige motivo de 10 a 500 caracteres", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const url = `/admin/posts/${post.id}/reject`;
    for (const body of [
      {},
      { reason: "curto" },
      { reason: "x".repeat(501) },
      { reason: "motivo válido", extra: 1 },
    ]) {
      const res = await request(app.server)
        .post(url)
        .set(bearer(a.token))
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("rejeita e regista no log; um segundo pedido → 409", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    const url = `/admin/posts/${post.id}/reject`;
    const res = await request(app.server)
      .post(url)
      .set(bearer(a.token))
      .send({ reason: "fora da doutrina" });
    expect(res.status).toBe(200);
    expect(res.body.post.status).toBe("rejected");

    const log = await request(app.server)
      .get("/admin/moderation-log")
      .set(bearer(a.token));
    expect(log.body.entries[0]).toMatchObject({
      action: "rejected",
      reason: "fora da doutrina",
      moderator: { username: a.user.username },
    });

    const again = await request(app.server)
      .post(url)
      .set(bearer(a.token))
      .send({ reason: "fora da doutrina" });
    expect(again.status).toBe(409);
  });
});

describe("GET /admin/reports e /admin/moderation-log", () => {
  it("lista as denúncias abertas e filtra por estado", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, { title: "Título" });
    await makeReport(post.id, (await makeUser()).id);
    await makeReport(post.id, (await makeUser()).id, {
      status: "resolved_removed",
    });

    const open = await request(app.server)
      .get("/admin/reports")
      .set(bearer(a.token));
    expect(open.status).toBe(200);
    expect(open.body.reports).toHaveLength(1);
    expect(open.body.reports[0]).toMatchObject({
      postId: post.id,
      postTitle: "Título",
      status: "open",
    });
    const removed = await request(app.server)
      .get("/admin/reports?status=resolved_removed")
      .set(bearer(a.token));
    expect(removed.body.reports).toHaveLength(1);
    const bad = await request(app.server)
      .get("/admin/reports?status=inventado")
      .set(bearer(a.token));
    expect(bad.status).toBe(400);
  });

  it("registo de auditoria: filtros e cursor inválido", async () => {
    const a = await admin();
    const author = await makeUser();
    const post = await makePost(author.id, { status: "pending_review" });
    await request(app.server)
      .post(`/admin/posts/${post.id}/approve`)
      .set(bearer(a.token))
      .send({});

    const all = await request(app.server)
      .get("/admin/moderation-log")
      .set(bearer(a.token));
    expect(all.status).toBe(200);
    expect(all.body.entries).toHaveLength(1);
    const byAction = await request(app.server)
      .get("/admin/moderation-log?action=rejected")
      .set(bearer(a.token));
    expect(byAction.body.entries).toHaveLength(0);
    const bad = await request(app.server)
      .get("/admin/moderation-log?cursor=YWJj")
      .set(bearer(a.token));
    expect(bad.status).toBe(400);
  });
});

describe("limites", () => {
  it("decisões acima do limite → 429 com Retry-After; leituras têm balde próprio", async () => {
    const limited = await buildServer({
      env: loadEnv({
        ...baseEnv,
        RATE_LIMIT_ADMIN_WRITE_MAX: 1,
        RATE_LIMIT_ADMIN_READ_MAX: 2,
      }),
    });
    await limited.ready();
    try {
      const a = await loginAs(limited, "admin");
      const author = await makeUser();
      const p1 = await makePost(author.id, { status: "pending_review" });
      const p2 = await makePost(author.id, { status: "pending_review" });

      const first = await request(limited.server)
        .post(`/admin/posts/${p1.id}/approve`)
        .set(bearer(a.token))
        .send({});
      expect(first.status).toBe(200);
      const second = await request(limited.server)
        .post(`/admin/posts/${p2.id}/approve`)
        .set(bearer(a.token))
        .send({});
      expect(second.status).toBe(429);
      expect(second.body).toEqual({ error: "rate_limited" });
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);

      // O balde de leitura é outro: continua disponível.
      for (let i = 0; i < 2; i++) {
        const read = await request(limited.server)
          .get("/admin/posts")
          .set(bearer(a.token));
        expect(read.status).toBe(200);
      }
      const blocked = await request(limited.server)
        .get("/admin/posts")
        .set(bearer(a.token));
      expect(blocked.status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
