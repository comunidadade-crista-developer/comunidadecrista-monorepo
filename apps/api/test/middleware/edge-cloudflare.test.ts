import { Redis } from "ioredis";
import { Writable } from "node:stream";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, type Env } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb } from "../helpers/db.js";

const SECRET = "segredo-de-origem-com-mais-de-32-caracteres-1";
const PREVIOUS_SECRET = "segredo-anterior-com-mais-de-32-caracteres-2";
const HASH_SECRET = "segredo-hmac-do-rate-limit-com-32-caracteres";

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

async function makeApp(
  overrides: Partial<Env> = {},
  logStream?: NodeJS.WritableStream,
) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_VERSION: "test",
    EDGE_MODE: "cloudflare",
    CF_ORIGIN_SECRET: SECRET,
    IP_HASH_SECRET: HASH_SECRET,
    ...overrides,
  });
  const app = await buildServer({ env, ...(logStream ? { logStream } : {}) });
  app.get("/__test__/ip", async (req) => ({ ip: req.clientIp }));
  await app.ready();
  return app;
}

describe("EDGE_MODE=cloudflare — origem protegida", () => {
  it("sem X-Origin-Auth → 403", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/__test__/ip");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    } finally {
      await app.close();
    }
  });

  it("segredo errado → 403", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", "errado");
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("/health responde sem segredo (health check do Render)", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/health");
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("/health/deep exige segredo", async () => {
    const app = await makeApp();
    try {
      const sem = await request(app.server).get("/health/deep");
      expect(sem.status).toBe(403);
      const com = await request(app.server)
        .get("/health/deep")
        .set("X-Origin-Auth", SECRET);
      expect(com.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("segredo correcto → usa CF-Connecting-IP", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "203.0.113.5");
      expect(res.status).toBe(200);
      expect(res.body.ip).toBe("203.0.113.5");
    } finally {
      await app.close();
    }
  });

  it("aceita IPv6 em CF-Connecting-IP", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "2001:db8::1");
      expect(res.body.ip).toBe("2001:db8::1");
    } finally {
      await app.close();
    }
  });

  it("CF-Connecting-IP inválido → ignora e usa o IP da ligação", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "não-é-um-ip");
      expect(res.status).toBe(200);
      expect(res.body.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      await app.close();
    }
  });

  it("X-Forwarded-For forjado é ignorado", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "203.0.113.5")
        .set("X-Forwarded-For", "198.51.100.9");
      expect(res.body.ip).toBe("203.0.113.5");
    } finally {
      await app.close();
    }
  });

  it("rotação: aceita também o segredo anterior", async () => {
    const app = await makeApp({ CF_ORIGIN_SECRET_PREVIOUS: PREVIOUS_SECRET });
    try {
      const novo = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", SECRET);
      const antigo = await request(app.server)
        .get("/__test__/ip")
        .set("X-Origin-Auth", PREVIOUS_SECRET);
      expect(novo.status).toBe(200);
      expect(antigo.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("respostas levam Cache-Control: no-store", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/health");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});

describe("EDGE_MODE=cloudflare — rate limit por IP real", () => {
  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it("IPs Cloudflare distintos têm buckets distintos", async () => {
    const app = await makeApp({ RATE_LIMIT_LOGIN_MAX: 2 });
    const body = { username: "probe", password: "password123" };
    const post = (ip: string) =>
      request(app.server)
        .post("/auth/login")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", ip)
        .send(body);
    try {
      expect((await post("1.1.1.1")).status).toBe(401);
      expect((await post("1.1.1.1")).status).toBe(401);
      expect((await post("1.1.1.1")).status).toBe(429);
      expect((await post("2.2.2.2")).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("chaves no Redis não contêm o IP nem o username em claro", async () => {
    const url = process.env.REDIS_URL;
    if (!url) return;
    const app = await makeApp();
    const client = new Redis(url);
    try {
      await request(app.server)
        .post("/auth/login")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "203.0.113.77")
        .send({ username: "utilizador-secreto", password: "password123" });
      const keys = await client.keys("rl:*");
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain("203.0.113.77");
        expect(key.toLowerCase()).not.toContain("utilizador-secreto");
      }
    } finally {
      client.disconnect();
      await app.close();
    }
  });
});

describe("logs — sem IP, sem cabeçalhos sensíveis, sem query string", () => {
  it("nenhuma linha de log contém IP, token, segredo ou query", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = await makeApp({ LOG_LEVEL: "info" }, stream);
    try {
      await request(app.server)
        .get("/health?token=QUERY_SECRETA")
        .set("X-Forwarded-For", "203.0.113.5")
        .set("CF-Connecting-IP", "203.0.113.6")
        .set("Authorization", "Bearer TOKEN_SECRETO");
      await request(app.server)
        .post("/auth/login")
        .set("X-Origin-Auth", SECRET)
        .set("CF-Connecting-IP", "203.0.113.7")
        .send({ username: "probe", password: "password123" });
    } finally {
      await app.close();
    }

    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const forbidden of [
      "203.0.113.5",
      "203.0.113.6",
      "203.0.113.7",
      "127.0.0.1",
      "::1",
      "TOKEN_SECRETO",
      "QUERY_SECRETA",
      SECRET,
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });
});
