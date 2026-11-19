import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/env.js";

const LONG = "x".repeat(40);

// O .env local do programador também é lido (dotenv). Estes testes fixam explicitamente os
// campos em causa para não dependerem dele.
const CLEAN = {
  EDGE_MODE: "none",
  CF_ORIGIN_SECRET: undefined,
  CF_ORIGIN_SECRET_PREVIOUS: undefined,
  IP_HASH_SECRET: undefined,
} as const;

// Mínimo para NODE_ENV=production (testes fixam tudo para não dependerem do .env local).
const PROD = {
  ...CLEAN,
  NODE_ENV: "production",
  IP_HASH_SECRET: LONG,
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_PRIVATE_JWK: "{}",
  JWT_PUBLIC_JWK: "{}",
  ARGON2_MEMORY_KB: 19456,
  ARGON2_TIME_COST: 2,
} as const;

describe("loadEnv — TRUST_PROXY", () => {
  it("boolean true (overrides em testes) → true", () => {
    expect(loadEnv({ ...CLEAN, TRUST_PROXY: true }).TRUST_PROXY).toBe(true);
  });

  it("string 'true' (process.env) → true", () => {
    const env = loadEnv({
      ...CLEAN,
      TRUST_PROXY: "true" as unknown as boolean,
    });
    expect(env.TRUST_PROXY).toBe(true);
  });

  it("string 'false' e ausente → false", () => {
    expect(
      loadEnv({ ...CLEAN, TRUST_PROXY: "false" as unknown as boolean })
        .TRUST_PROXY,
    ).toBe(false);
    expect(loadEnv({ ...CLEAN, TRUST_PROXY: undefined }).TRUST_PROXY).toBe(
      false,
    );
  });
});

describe("loadEnv — modo Cloudflare e produção", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("EDGE_MODE=cloudflare sem CF_ORIGIN_SECRET → erro", () => {
    expect(() => loadEnv({ ...CLEAN, EDGE_MODE: "cloudflare" })).toThrow(
      "Invalid environment variables",
    );
  });

  it("CF_ORIGIN_SECRET curto (< 32) → erro", () => {
    expect(() =>
      loadEnv({ ...CLEAN, EDGE_MODE: "cloudflare", CF_ORIGIN_SECRET: "curto" }),
    ).toThrow();
  });

  it("EDGE_MODE=cloudflare + TRUST_PROXY → erro", () => {
    expect(() =>
      loadEnv({
        ...CLEAN,
        EDGE_MODE: "cloudflare",
        CF_ORIGIN_SECRET: LONG,
        TRUST_PROXY: true,
      }),
    ).toThrow();
  });

  it("EDGE_MODE=cloudflare com segredo válido → ok", () => {
    const env = loadEnv({
      ...CLEAN,
      EDGE_MODE: "cloudflare",
      CF_ORIGIN_SECRET: LONG,
    });
    expect(env.EDGE_MODE).toBe("cloudflare");
  });

  it("string vazia conta como ausente (CF_ORIGIN_SECRET= no .env)", () => {
    const env = loadEnv({
      ...CLEAN,
      CF_ORIGIN_SECRET: "" as unknown as undefined,
    });
    expect(env.CF_ORIGIN_SECRET).toBeUndefined();
  });

  it("produção completa → ok", () => {
    expect(loadEnv({ ...PROD }).NODE_ENV).toBe("production");
  });

  it.each([
    "IP_HASH_SECRET",
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_PRIVATE_JWK",
    "JWT_PUBLIC_JWK",
  ] as const)("produção sem %s → erro", (key) => {
    expect(() => loadEnv({ ...PROD, [key]: undefined })).toThrow(
      "Invalid environment variables",
    );
  });

  it("produção com argon2 abaixo do mínimo → erro", () => {
    expect(() => loadEnv({ ...PROD, ARGON2_MEMORY_KB: 4096 })).toThrow();
    expect(() => loadEnv({ ...PROD, ARGON2_TIME_COST: 1 })).toThrow();
  });

  it("fora de produção os mínimos de argon2 não se aplicam", () => {
    const env = loadEnv({
      ...CLEAN,
      NODE_ENV: "test",
      ARGON2_MEMORY_KB: 1024,
      ARGON2_TIME_COST: 1,
    });
    expect(env.ARGON2_MEMORY_KB).toBe(1024);
  });
});

describe("loadEnv — limites do servidor", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("valores por omissão", () => {
    const env = loadEnv({ ...CLEAN });
    expect(env.RATE_LIMIT_GLOBAL_MAX).toBe(300);
    expect(env.BODY_LIMIT_BYTES).toBe(524_288);
    expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("recusa limites fora do intervalo", () => {
    expect(() => loadEnv({ ...CLEAN, BODY_LIMIT_BYTES: 10 })).toThrow();
    expect(() => loadEnv({ ...CLEAN, REQUEST_TIMEOUT_MS: 10 })).toThrow();
  });
});
