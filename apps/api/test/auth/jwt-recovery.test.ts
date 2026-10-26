import { beforeAll, describe, expect, it } from "vitest";
import { createJwtService, type JwtService } from "../../src/auth/jwt.js";
import { loadEnv } from "../../src/env.js";

let jwt: JwtService;

beforeAll(async () => {
  jwt = await createJwtService(loadEnv({ NODE_ENV: "test" }));
});

describe("sessão de recuperação — jti e método", () => {
  it("cada sessão tem um jti único", async () => {
    const a = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1", "code"),
    );
    const b = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1", "code"),
    );
    expect(a.jti).toBeTruthy();
    expect(a.jti).not.toBe(b.jti);
  });

  it("o método fica preservado", async () => {
    const code = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1", "code"),
    );
    const questions = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1", "questions"),
    );
    expect(code.method).toBe("code");
    expect(questions.method).toBe("questions");
  });

  it("por omissão o método é o de menor privilégio (questions)", async () => {
    const payload = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1"),
    );
    expect(payload.method).toBe("questions");
  });

  it("expiresAt está no futuro", async () => {
    const payload = await jwt.verifyRecoverySession(
      await jwt.signRecoverySession("u1", "code"),
    );
    expect(payload.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
