import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { posts, users } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUserWithPassword } from "../helpers/factories.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
});

type App = Awaited<ReturnType<typeof buildServer>>;

async function loginOk(app: App, username: string, password: string) {
  const res = await request(app.server)
    .post("/auth/login")
    .send({ username, password });
  expect(res.status).toBe(200);
  return res.body as {
    accessToken: string;
    refreshToken: string;
    accountRestored?: boolean;
  };
}

function requestDeletion(
  app: App,
  token: string | null,
  body: Record<string, unknown>,
) {
  const req = request(app.server).post("/users/me/deletion");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body);
}

describe("POST /users/me/deletion", () => {
  let app: App;
  beforeAll(async () => {
    await getTestDb();
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("sem token → 401", async () => {
    const res = await requestDeletion(app, null, {
      password: "x",
      postsMode: "anonymize",
    });
    expect(res.status).toBe(401);
  });

  it("palavra-passe errada → 401 e a conta não muda", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "ana-x",
    });
    const { accessToken } = await loginOk(app, user.username, plainPassword);
    const res = await requestDeletion(app, accessToken, {
      password: "errada-errada",
      postsMode: "anonymize",
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    const db = await getTestDb();
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.deletionRequestedAt).toBeNull();
  });

  it("postsMode inválido → 400 validation_error", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "ana-y",
    });
    const { accessToken } = await loginOk(app, user.username, plainPassword);
    const res = await requestDeletion(app, accessToken, {
      password: plainPassword,
      postsMode: "apagar-tudo",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("pedido válido → 200 pending_deletion; tokens deixam de servir; o username fica reservado", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "rui-z",
    });
    const { accessToken, refreshToken } = await loginOk(
      app,
      user.username,
      plainPassword,
    );

    const res = await requestDeletion(app, accessToken, {
      password: plainPassword,
      postsMode: "anonymize",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_deletion");
    const days = (Date.parse(res.body.purgeAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // O access token ainda não expirou, mas a conta já não responde.
    const me = await request(app.server)
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
    // A sessão (refresh) foi revogada.
    const refreshed = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken });
    expect(refreshed.status).toBe(401);
    // Ninguém regista o mesmo nome durante o período pendente.
    const taken = await request(app.server).post("/auth/register").send({
      username: "rui-z",
      password: "Cavalo-azul-bateria-77",
      passwordConfirmation: "Cavalo-azul-bateria-77",
      securityQ1: "Azul",
      securityQ2: "7",
      securityQ3: "Igreja",
    });
    expect(taken.status).toBe(409);
  });

  it("pedido repetido com o mesmo token → 200 com o mesmo prazo", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "dup-u",
    });
    const { accessToken } = await loginOk(app, user.username, plainPassword);
    const body = { password: plainPassword, postsMode: "anonymize" };
    const a = await requestDeletion(app, accessToken, body);
    const b = await requestDeletion(app, accessToken, body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.purgeAt).toBe(a.body.purgeAt);
  });

  it("o último admin → 409 last_admin", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "admin-unico",
      role: "admin",
    });
    const { accessToken } = await loginOk(app, user.username, plainPassword);
    const res = await requestDeletion(app, accessToken, {
      password: plainPassword,
      postsMode: "anonymize",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("last_admin");
  });

  it("login com a palavra-passe correcta reactiva a conta e repõe as partilhas", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "volta-u",
    });
    const post = await makePost(user.id);
    const first = await loginOk(app, user.username, plainPassword);
    await requestDeletion(app, first.accessToken, {
      password: plainPassword,
      postsMode: "delete",
    });
    const db = await getTestDb();
    expect(
      (await db.select().from(posts).where(eq(posts.id, post.id)))[0]?.status,
    ).toBe("hidden");

    const back = await loginOk(app, user.username, plainPassword);
    expect(back.accountRestored).toBe(true);

    const [p] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(p?.status).toBe("published");
    const me = await request(app.server)
      .get("/auth/me")
      .set("Authorization", `Bearer ${back.accessToken}`);
    expect(me.status).toBe(200);

    // Um login seguinte já não diz que restaurou.
    const again = await loginOk(app, user.username, plainPassword);
    expect(again.accountRestored).toBeUndefined();
  });

  it("login com palavra-passe errada NÃO reactiva", async () => {
    const { user, plainPassword } = await makeUserWithPassword({
      username: "sem-volta",
    });
    const { accessToken } = await loginOk(app, user.username, plainPassword);
    await requestDeletion(app, accessToken, {
      password: plainPassword,
      postsMode: "anonymize",
    });
    const bad = await request(app.server)
      .post("/auth/login")
      .send({ username: user.username, password: "errada-errada" });
    expect(bad.status).toBe(401);
    const db = await getTestDb();
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.deletionRequestedAt).toBeInstanceOf(Date);
  });
});
