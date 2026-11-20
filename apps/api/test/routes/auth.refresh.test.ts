import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { refreshTokens } from "../../src/db/schema.js";
import { hashRefreshToken } from "../../src/auth/refresh.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUserWithPassword } from "../helpers/factories.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
  // Sem tolerância: estes testes verificam a detecção estrita de reutilização.
  REFRESH_REUSE_GRACE_S: 0,
});

async function login(
  app: Awaited<ReturnType<typeof buildServer>>,
  username: string,
  password: string,
) {
  const res = await request(app.server)
    .post("/auth/login")
    .send({ username, password });
  return res.body.refreshToken as string;
}

describe("POST /auth/refresh", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
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

  it("refresh válido devolve novo par de tokens", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "paula" });
    const refresh = await login(app, "paula", plainPassword);
    const res = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: refresh });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refresh);
  });

  it("reuso do token antigo → 401 + revoga família", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "reuse" });
    const refresh1 = await login(app, "reuse", plainPassword);
    const r1 = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: refresh1 });
    expect(r1.status).toBe(200);
    const refresh2 = r1.body.refreshToken as string;

    // Reuso do refresh1 (já usado)
    const r2 = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: refresh1 });
    expect(r2.status).toBe(401);
    expect(r2.body.error).toBe("token_reuse");

    // refresh2 também deve estar revogado (família inteira)
    const r3 = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: refresh2 });
    expect(r3.status).toBe(401);
  });

  it("refresh desconhecido → 401", async () => {
    const res = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: "inventado" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_refresh");
  });
});

describe("POST /auth/refresh — tolerância ao reenvio (REFRESH_REUSE_GRACE_S)", () => {
  const graceEnv = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_VERSION: "test",
    REFRESH_REUSE_GRACE_S: 10,
  });
  let app: Awaited<ReturnType<typeof buildServer>>;
  let db: Awaited<ReturnType<typeof getTestDb>>;
  beforeAll(async () => {
    db = await getTestDb();
    app = await buildServer({ env: graceEnv });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  const refresh = (token: string) =>
    request(app.server).post("/auth/refresh").send({ refreshToken: token });

  it("reenvio do token antigo dentro da janela → 200 e a família continua viva", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "tab" });
    const t0 = await login(app, "tab", plainPassword);
    const first = await refresh(t0);
    expect(first.status).toBe(200);

    const second = await refresh(t0);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);

    // Os dois tokens filhos continuam válidos.
    expect((await refresh(first.body.refreshToken)).status).toBe(200);
    expect((await refresh(second.body.refreshToken)).status).toBe(200);
  });

  it("dois pedidos simultâneos com o mesmo token → ambos 200", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "par" });
    const t0 = await login(app, "par", plainPassword);
    const [a, b] = await Promise.all([refresh(t0), refresh(t0)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.refreshToken).not.toBe(b.body.refreshToken);
  });

  it("fora da janela → token_reuse e revoga a família", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "tarde" });
    const t0 = await login(app, "tarde", plainPassword);
    const first = await refresh(t0);
    expect(first.status).toBe(200);

    // Recua o momento da rotação para além da janela.
    await db
      .update(refreshTokens)
      .set({ rotatedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(t0)));

    const late = await refresh(t0);
    expect(late.status).toBe(401);
    expect(late.body.error).toBe("token_reuse");
    expect((await refresh(first.body.refreshToken)).status).toBe(401);
  });

  it("depois de logout do token filho, o antigo não tem tolerância", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "sai" });
    const t0 = await login(app, "sai", plainPassword);
    const first = await refresh(t0);
    expect(first.status).toBe(200);
    await request(app.server)
      .post("/auth/logout")
      .send({ refreshToken: first.body.refreshToken });

    const again = await refresh(t0);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("token_reuse");
  });

  it("token revogado por logout (sem rotação) → token_reuse, mesmo dentro da janela", async () => {
    const { plainPassword } = await makeUserWithPassword({
      username: "logout",
    });
    const t0 = await login(app, "logout", plainPassword);
    await request(app.server).post("/auth/logout").send({ refreshToken: t0 });

    const res = await refresh(t0);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("token_reuse");
  });

  it("a rotação regista rotated_at; tokens novos ficam sem ele", async () => {
    const { plainPassword } = await makeUserWithPassword({ username: "col" });
    const t0 = await login(app, "col", plainPassword);
    const first = await refresh(t0);
    const [old] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(t0)));
    const [fresh] = await db
      .select()
      .from(refreshTokens)
      .where(
        eq(refreshTokens.tokenHash, hashRefreshToken(first.body.refreshToken)),
      );
    expect(old!.rotatedAt).toBeInstanceOf(Date);
    expect(fresh!.rotatedAt).toBeNull();
  });
});
