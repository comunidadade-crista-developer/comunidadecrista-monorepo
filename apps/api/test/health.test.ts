import { DeepHealthResponse, HealthResponse } from "@comunidade/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, type Env } from "../src/env.js";
import { buildServer } from "../src/server.js";

const baseEnv: Env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
});

describe("GET /health", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer({ env: baseEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responde 200 com contrato esperado", async () => {
    const res = await request(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(() => HealthResponse.parse(res.body)).not.toThrow();
    expect(res.body.status).toBe("ok");
    expect(res.body.version).toBe("test");
  });

  it("responde Content-Type application/json", async () => {
    const res = await request(app.server).get("/health");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("é leve: responde em < 50ms", async () => {
    const start = Date.now();
    await request(app.server).get("/health");
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("GET /health/deep — com serviços configurados", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer({ env: baseEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responde 200 com contrato esperado", async () => {
    const res = await request(app.server).get("/health/deep");
    expect(res.status).toBe(200);
    expect(() => DeepHealthResponse.parse(res.body)).not.toThrow();
  });

  it("marca DB como ok quando a base de dados está acessível", async () => {
    const res = await request(app.server).get("/health/deep");
    expect(res.body.checks.db).toBe("ok");
  });

  it("marca Redis como ok quando o Redis está acessível", async () => {
    const res = await request(app.server).get("/health/deep");
    expect(res.body.checks.redis).toBe("ok");
  });
});

describe("GET /health/deep — sem serviços configurados", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const envSemServicos = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_VERSION: "test",
    DATABASE_URL: undefined,
    REDIS_URL: undefined,
  });

  beforeAll(async () => {
    app = await buildServer({ env: envSemServicos });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("marca checks como not_configured", async () => {
    const res = await request(app.server).get("/health/deep");
    expect(res.body.checks.db).toBe("not_configured");
    expect(res.body.checks.redis).toBe("not_configured");
    expect(res.body.status).toBe("ok");
  });
});
