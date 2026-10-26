import { describe, expect, it } from "vitest";
import { createPasswordService } from "../../src/auth/password.js";
import {
  createRecoveryService,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from "../../src/auth/recovery.js";
import { loadEnv } from "../../src/env.js";

const env = loadEnv({ NODE_ENV: "test" });
const recovery = createRecoveryService(createPasswordService(env));

describe("recovery codes", () => {
  it("formato XXXX-XXXX-XXXX-XXXX e 16 chars canónicos", () => {
    const c = generateRecoveryCode();
    expect(c.formatted).toMatch(
      /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/,
    );
    expect(c.canonical).toHaveLength(16);
  });

  it("normalizeRecoveryCode remove hífens e espaços, upper", () => {
    expect(normalizeRecoveryCode("abcd-efgh ijkl-mnop")).toBe(
      "ABCDEFGHIJKLMNOP",
    );
  });

  it("verifyCode aceita formatted e canonical", async () => {
    const c = generateRecoveryCode();
    const hash = await recovery.hashCode(c.canonical);
    expect(await recovery.verifyCode(hash, c.formatted)).toBe(true);
    expect(await recovery.verifyCode(hash, c.canonical)).toBe(true);
    expect(await recovery.verifyCode(hash, "XXXXXXXXXXXXXXX")).toBe(false);
  });

  it("cada código é único", () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateRecoveryCode().canonical),
    );
    expect(codes.size).toBe(50);
  });
});
