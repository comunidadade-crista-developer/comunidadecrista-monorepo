import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRateLimiters } from "../../src/auth/rate-limit.js";
import { loadEnv, type Env } from "../../src/env.js";

// Sem Redis → limitadores em memória (isolados por instância), sem depender de infraestrutura.
const make = (overrides: Partial<Env> = {}) =>
  createRateLimiters(
    null,
    loadEnv({ NODE_ENV: "test", LOG_LEVEL: "fatal", ...overrides }),
  );

describe("rate limit — login", () => {
  it("IP+utilizador: bloqueia ao exceder, com retryAfter; outro utilizador não é afectado", async () => {
    const rl = make({ RATE_LIMIT_LOGIN_MAX: 2 });
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
    const blocked = await rl.checkLogin("1.1.1.1", "ana");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect((await rl.checkLogin("1.1.1.1", "rui")).allowed).toBe(true);
  });

  it("conta: o limite aplica-se mesmo mudando de IP", async () => {
    const rl = make({ RATE_LIMIT_LOGIN_ACCOUNT_MAX: 3 });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      expect((await rl.checkLogin(ip, "alvo")).allowed).toBe(true);
    }
    expect((await rl.checkLogin("4.4.4.4", "alvo")).allowed).toBe(false);
  });

  it("conta: maiúsculas/minúsculas contam como o mesmo utilizador", async () => {
    const rl = make({ RATE_LIMIT_LOGIN_ACCOUNT_MAX: 2 });
    expect((await rl.checkLogin("1.1.1.1", "Alvo")).allowed).toBe(true);
    expect((await rl.checkLogin("2.2.2.2", "ALVO")).allowed).toBe(true);
    expect((await rl.checkLogin("3.3.3.3", "alvo")).allowed).toBe(false);
  });

  it("IP: o limite aplica-se mesmo mudando de utilizador (password spraying)", async () => {
    const rl = make({ RATE_LIMIT_LOGIN_IP_MAX: 3 });
    for (const u of ["u1", "u2", "u3"]) {
      expect((await rl.checkLogin("9.9.9.9", u)).allowed).toBe(true);
    }
    expect((await rl.checkLogin("9.9.9.9", "u4")).allowed).toBe(false);
    expect((await rl.checkLogin("8.8.8.8", "u4")).allowed).toBe(true);
  });

  it("loginSucceeded repõe IP+utilizador e devolve o ponto da conta", async () => {
    const rl = make({
      RATE_LIMIT_LOGIN_MAX: 2,
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: 2,
    });
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
    await rl.loginSucceeded("1.1.1.1", "ana");
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
    expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(false);
  });
});

describe("rate limit — recuperação", () => {
  it("perguntas: limite por conta mesmo mudando de IP; o balde do código é separado", async () => {
    const rl = make({ RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_MAX: 2 });
    expect(
      (await rl.checkRecover("1.1.1.1", "alvo", "questions")).allowed,
    ).toBe(true);
    expect(
      (await rl.checkRecover("2.2.2.2", "alvo", "questions")).allowed,
    ).toBe(true);
    expect(
      (await rl.checkRecover("3.3.3.3", "alvo", "questions")).allowed,
    ).toBe(false);
    expect((await rl.checkRecover("3.3.3.3", "alvo", "code")).allowed).toBe(
      true,
    );
  });

  it("recoverSucceeded devolve o ponto da conta", async () => {
    const rl = make({ RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_MAX: 1 });
    expect((await rl.checkRecover("1.1.1.1", "ana", "questions")).allowed).toBe(
      true,
    );
    await rl.recoverSucceeded("1.1.1.1", "ana", "questions");
    expect((await rl.checkRecover("1.1.1.1", "ana", "questions")).allowed).toBe(
      true,
    );
  });

  it("IP: limite global de tentativas de recuperação", async () => {
    const rl = make({ RATE_LIMIT_RECOVER_IP_MAX: 2 });
    expect((await rl.checkRecover("1.1.1.1", "a", "code")).allowed).toBe(true);
    expect((await rl.checkRecover("1.1.1.1", "b", "code")).allowed).toBe(true);
    expect((await rl.checkRecover("1.1.1.1", "c", "code")).allowed).toBe(false);
  });
});

describe("rate limit — registo", () => {
  it("bloqueia ao exceder", async () => {
    const rl = make({ RATE_LIMIT_REGISTER_MAX: 1 });
    expect((await rl.checkRegister("1.1.1.1")).allowed).toBe(true);
    expect((await rl.checkRegister("1.1.1.1")).allowed).toBe(false);
  });
});

describe("rate limit — Redis indisponível", () => {
  it("continua a limitar em memória (não falha em aberto)", async () => {
    // Porta 1: ligação recusada. Sem fila offline, cada comando falha de imediato.
    const redis = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
    try {
      const rl = createRateLimiters(
        redis,
        loadEnv({
          NODE_ENV: "test",
          LOG_LEVEL: "fatal",
          RATE_LIMIT_LOGIN_MAX: 2,
        }),
      );
      expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
      expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(true);
      expect((await rl.checkLogin("1.1.1.1", "ana")).allowed).toBe(false);
    } finally {
      redis.disconnect();
    }
  });
});
