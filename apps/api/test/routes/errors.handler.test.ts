import { LoginRequest } from "@comunidade/shared";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Writable } from "node:stream";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb } from "../helpers/db.js";

afterAll(async () => {
  await closeTestDb();
});

// O .env local também é lido: fixar o que interessa a estes testes.
async function makeApp(logStream?: NodeJS.WritableStream) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    APP_VERSION: "test",
    EDGE_MODE: "none",
    CF_ORIGIN_SECRET: undefined,
    CF_ORIGIN_SECRET_PREVIOUS: undefined,
    IP_HASH_SECRET: "segredo-hmac-do-rate-limit-com-32-caracteres",
  });
  const app = await buildServer({ env, ...(logStream ? { logStream } : {}) });
  app.get("/__test__/boom", async () => {
    throw new Error("postgres://utilizador:SEGREDO_NO_ERRO@host/db");
  });
  app.get("/__test__/boom-500", async () => {
    throw Object.assign(new Error("SEGREDO_NO_ERRO"), { statusCode: 500 });
  });
  app.get("/__test__/forbidden", async () => {
    throw Object.assign(new Error("SEGREDO_NO_ERRO"), { statusCode: 403 });
  });
  app.post("/__test__/echo", async (req) => ({ ok: true, body: req.body }));
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/__test__/validate",
      { schema: { body: LoginRequest } },
      async () => ({ ok: true }),
    );
  await app.ready();
  return app;
}

describe("formato único de erro", () => {
  it("rota desconhecida → 404 { error: not_found }", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/nao-existe");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    } finally {
      await app.close();
    }
  });

  it("erro interno → 500 genérico; nem a resposta nem os logs levam a mensagem", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = await makeApp(stream);
    try {
      const res = await request(app.server).get("/__test__/boom");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal_error" });
      expect(JSON.stringify(res.body)).not.toContain("SEGREDO_NO_ERRO");
    } finally {
      await app.close();
    }
    const logs = lines.join("\n");
    expect(logs).toContain("unhandled error");
    expect(logs).not.toContain("SEGREDO_NO_ERRO");
  });

  it("erro com statusCode 500 explícito também é genérico", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/__test__/boom-500");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal_error" });
    } finally {
      await app.close();
    }
  });

  it("4xx lançado no código não repete a mensagem", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server).get("/__test__/forbidden");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "forbidden" });
    } finally {
      await app.close();
    }
  });

   it("JSON inválido → 400 bad_request", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .post("/__test__/echo")
        .set("Content-Type", "application/json")
        .send("{");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "bad_request" });
    } finally {
      await app.close();
    }
  });

  it("content-type não suportado → 415", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .post("/__test__/echo")
        .set("Content-Type", "application/xml")
        .send("<a/>");
      expect(res.status).toBe(415);
      expect(res.body).toEqual({ error: "unsupported_media_type" });
    } finally {
      await app.close();
    }
  });

  it("corpo acima do limite → 413", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .post("/__test__/echo")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ a: "x".repeat(1_200_000) }));
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "payload_too_large" });
    } finally {
      await app.close();
    }
  });

  // Depende da forma do erro que o type provider do zod produz.
  it("validação → 400 validation_error com fields por campo", async () => {
    const app = await makeApp();
    try {
      const res = await request(app.server)
        .post("/__test__/validate")
        .send({ username: "a", password: "" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_error");
      expect(Object.keys(res.body.fields ?? {})).toEqual(
        expect.arrayContaining(["username", "password"]),
      );
    } finally {
      await app.close();
    }
  });

  it("rate limit global → 429 { error: rate_limited } com Retry-After", async () => {
    const app = await makeApp();
    try {
      let last = await request(app.server).get("/health");
      for (let i = 0; i < 100; i++) {
        last = await request(app.server).get("/health");
      }
      expect(last.status).toBe(429);
      expect(last.body).toEqual({ error: "rate_limited" });
      expect(last.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
