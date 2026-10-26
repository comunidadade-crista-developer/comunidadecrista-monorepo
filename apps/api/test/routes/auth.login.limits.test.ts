import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUserWithPassword } from "../helpers/factories.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
  RATE_LIMIT_LOGIN_MAX: 2,
});

async function flushRateLimitKeys(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const client = new Redis(url);
  try {
    const keys = await client.keys("rl:*");
    if (keys.length > 0) await client.del(...keys);
  } finally {
    client.disconnect();
  }
}

describe("POST /auth/login — um login válido repõe o balde IP+utilizador", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await getTestDb();
    await truncateAll();
    await flushRateLimitKeys();
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it("sucesso no meio não deixa o dono bloqueado; falhas seguidas continuam a bloquear", async () => {
    const { plainPassword } = await makeUserWithPassword({
      username: "limites1",
    });
    const post = (password: string) =>
      request(app.server)
        .post("/auth/login")
        .send({ username: "limites1", password });

    expect((await post("errada123")).status).toBe(401); // 1 ponto
    expect((await post(plainPassword)).status).toBe(200); // sucesso → repõe
    expect((await post("errada123")).status).toBe(401); // 1
    expect((await post("errada123")).status).toBe(401); // 2
    const blocked = await post("errada123"); // 3.º → bloqueado
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});
