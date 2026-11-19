import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { buildServer } from "../src/server.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
  BODY_LIMIT_BYTES: 1024,
  CORS_ORIGIN: "http://localhost:5173",
});

describe("limites e CORS do servidor", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("corpo acima de BODY_LIMIT_BYTES → 413 payload_too_large", async () => {
    const res = await request(app.server)
      .post("/auth/login")
      .send({ username: "a", password: "x".repeat(4000) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("CORS não envia Access-Control-Allow-Credentials", async () => {
    const res = await request(app.server)
      .get("/health")
      .set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("/health/deep tem limite próprio (30/min) e devolve 429 ao exceder", async () => {
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (await request(app.server).get("/health/deep")).status;
    }
    expect(last).toBe(429);
  });
});
