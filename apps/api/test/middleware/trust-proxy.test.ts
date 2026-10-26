import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb } from "../helpers/db.js";

afterAll(async () => {
  await closeTestDb();
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

async function makeApp(trustProxy: boolean) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_VERSION: "test",
    TRUST_PROXY: trustProxy,
  });
  const app = await buildServer({ env });
  app.get("/__test__/ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  return app;
}

describe("trustProxy", () => {
  it("sem trustProxy: ignora X-Forwarded-For", async () => {
    const app = await makeApp(false);
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Forwarded-For", "203.0.113.5");
      expect(res.body.ip === "203.0.113.5").toBe(false);
      expect(res.body.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await app.close();
    }
  });

  it("com trustProxy: respeita X-Forwarded-For", async () => {
    const app = await makeApp(true);
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Forwarded-For", "203.0.113.5");
      expect(res.body.ip).toBe("203.0.113.5");
    } finally {
      await app.close();
    }
  });
});

describe("trustProxy — rate limit por IP", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await flushRateLimitKeys();
    const env = loadEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      APP_VERSION: "test",
      TRUST_PROXY: true,
      RATE_LIMIT_LOGIN_MAX: 2,
    });
    app = await buildServer({ env });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it("IPs distintos têm buckets distintos", async () => {
    const body = { username: "probe", password: "password123" };

    // 2 pedidos de 1.1.1.1 → bucket esgota
    for (let i = 0; i < 2; i++) {
      const r = await request(app.server)
        .post("/auth/login")
        .set("X-Forwarded-For", "1.1.1.1")
        .send(body);
      expect(r.status).toBe(401);
    }

    // 3º de 1.1.1.1 → bloqueado
    const blocked = await request(app.server)
      .post("/auth/login")
      .set("X-Forwarded-For", "1.1.1.1")
      .send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();

    // 1º de 2.2.2.2 → bucket próprio, não bloqueado
    const other = await request(app.server)
      .post("/auth/login")
      .set("X-Forwarded-For", "2.2.2.2")
      .send(body);
    expect(other.status).toBe(401);
  });
});
