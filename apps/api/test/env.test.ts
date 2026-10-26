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

  it("produção sem IP_HASH_SECRET → erro; com segredo → ok", () => {
    expect(() => loadEnv({ ...CLEAN, NODE_ENV: "production" })).toThrow();
    const env = loadEnv({
      ...CLEAN,
      NODE_ENV: "production",
      IP_HASH_SECRET: LONG,
    });
    expect(env.NODE_ENV).toBe("production");
  });
});
