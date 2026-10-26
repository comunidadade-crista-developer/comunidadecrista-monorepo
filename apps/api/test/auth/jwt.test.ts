import { beforeAll, describe, expect, it } from "vitest";
import { createJwtService, type JwtService } from "../../src/auth/jwt.js";
import { loadEnv } from "../../src/env.js";

let jwt: JwtService;
const env = loadEnv({ NODE_ENV: "test" });

beforeAll(async () => {
  jwt = await createJwtService(env);
});

describe("jwt service", () => {
  it("sign + verify access token", async () => {
    const token = await jwt.signAccessToken({ sub: "abc", role: "user" });
    const payload = await jwt.verifyAccessToken(token);
    expect(payload).toEqual({ sub: "abc", role: "user" });
  });

  it("role admin é preservado", async () => {
    const token = await jwt.signAccessToken({ sub: "xyz", role: "admin" });
    expect((await jwt.verifyAccessToken(token)).role).toBe("admin");
  });

  it("token alterado falha", async () => {
    const token = await jwt.signAccessToken({ sub: "abc", role: "user" });
    const tampered = token.slice(0, -3) + "AAA";
    await expect(jwt.verifyAccessToken(tampered)).rejects.toThrow();
  });

  it("recovery session NÃO passa como access token", async () => {
    const session = await jwt.signRecoverySession("abc");
    await expect(jwt.verifyAccessToken(session)).rejects.toThrow();
  });

  it("access token NÃO passa como recovery session", async () => {
    const token = await jwt.signAccessToken({ sub: "abc", role: "user" });
    await expect(jwt.verifyRecoverySession(token)).rejects.toThrow();
  });

  it("recovery session válida para recovery", async () => {
    const session = await jwt.signRecoverySession("abc");
    const payload = await jwt.verifyRecoverySession(session);
    expect(payload.sub).toBe("abc");
  });
});
