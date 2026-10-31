import {
  SignJWT,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createJwtService } from "../../src/auth/jwt.js";
import { loadEnv, type Env } from "../../src/env.js";

interface Pair {
  privateJwk: JWK;
  publicJwk: JWK;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  kid: string;
}

async function makePair(): Promise<Pair> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint({
    kty: "OKP",
    crv: "Ed25519",
    x: publicJwk.x as string,
  });
  return { privateJwk, publicJwk, privateKey, kid };
}

function envFor(
  current: Pair,
  extra: Partial<Env> = {},
  overrides: Partial<Env> = {},
): Env {
  return loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    APP_VERSION: "test",
    JWT_PRIVATE_JWK: JSON.stringify(current.privateJwk),
    JWT_PUBLIC_JWK: JSON.stringify(current.publicJwk),
    JWT_PUBLIC_JWK_PREVIOUS: undefined,
    ...extra,
    ...overrides,
  });
}

const USER = "11111111-1111-4111-8111-111111111111";

describe("rotação de chaves JWT (kid)", () => {
  let oldPair: Pair;
  let newPair: Pair;
  let thirdPair: Pair;

  beforeAll(async () => {
    oldPair = await makePair();
    newPair = await makePair();
    thirdPair = await makePair();
  });

  it("assina com kid = thumbprint da chave pública actual", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    expect(jwt.keyId).toBe(oldPair.kid);

    const access = await jwt.signAccessToken({ sub: USER, role: "user" });
    const header = decodeProtectedHeader(access);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(oldPair.kid);

    const recovery = await jwt.signRecoverySession(USER, "code");
    expect(decodeProtectedHeader(recovery).kid).toBe(oldPair.kid);
  });

  it("sem rotação, verifica os próprios tokens", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    const access = await jwt.signAccessToken({ sub: USER, role: "admin" });
    await expect(jwt.verifyAccessToken(access)).resolves.toEqual({
      sub: USER,
      role: "admin",
    });
  });

  it("durante a rotação, tokens da chave antiga continuam válidos", async () => {
    const before = await createJwtService(envFor(oldPair));
    const oldAccess = await before.signAccessToken({ sub: USER, role: "user" });
    const oldRecovery = await before.signRecoverySession(USER, "code");

    const after = await createJwtService(
      envFor(newPair, {
        JWT_PUBLIC_JWK_PREVIOUS: JSON.stringify(oldPair.publicJwk),
      }),
    );
    expect(after.keyId).toBe(newPair.kid);

    await expect(after.verifyAccessToken(oldAccess)).resolves.toEqual({
      sub: USER,
      role: "user",
    });
    const rec = await after.verifyRecoverySession(oldRecovery);
    expect(rec.sub).toBe(USER);
    expect(rec.method).toBe("code");

    // Tokens novos assinam-se com a chave nova.
    const fresh = await after.signAccessToken({ sub: USER, role: "user" });
    expect(decodeProtectedHeader(fresh).kid).toBe(newPair.kid);
    await expect(after.verifyAccessToken(fresh)).resolves.toBeDefined();
  });

  it("sem a chave anterior configurada, tokens antigos são recusados (compromisso)", async () => {
    const before = await createJwtService(envFor(oldPair));
    const oldAccess = await before.signAccessToken({ sub: USER, role: "user" });

    const after = await createJwtService(envFor(newPair));
    await expect(after.verifyAccessToken(oldAccess)).rejects.toThrow(
      "unknown_kid",
    );
  });

  it("recusa um kid desconhecido", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    const token = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "EdDSA", kid: "kid-que-nao-existe" })
      .setSubject(USER)
      .setIssuedAt()
      .setIssuer("comunidade-crista")
      .setAudience("comunidade-crista-api")
      .setExpirationTime("5m")
      .sign(thirdPair.privateKey);
    await expect(jwt.verifyAccessToken(token)).rejects.toThrow("unknown_kid");
  });

  it("um kid forjado não dá acesso: a assinatura é sempre verificada", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    const forged = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "EdDSA", kid: oldPair.kid })
      .setSubject(USER)
      .setIssuedAt()
      .setIssuer("comunidade-crista")
      .setAudience("comunidade-crista-api")
      .setExpirationTime("5m")
      .sign(thirdPair.privateKey);
    await expect(jwt.verifyAccessToken(forged)).rejects.toThrow();
  });

  it("tokens sem kid (emitidos antes da rotação existir) continuam válidos", async () => {
    const legacy = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(USER)
      .setIssuedAt()
      .setIssuer("comunidade-crista")
      .setAudience("comunidade-crista-api")
      .setExpirationTime("5m")
      .sign(oldPair.privateKey);

    const current = await createJwtService(envFor(oldPair));
    await expect(current.verifyAccessToken(legacy)).resolves.toEqual({
      sub: USER,
      role: "user",
    });

    const rotated = await createJwtService(
      envFor(newPair, {
        JWT_PUBLIC_JWK_PREVIOUS: JSON.stringify(oldPair.publicJwk),
      }),
    );
    await expect(rotated.verifyAccessToken(legacy)).resolves.toBeDefined();

    const noPrevious = await createJwtService(envFor(newPair));
    await expect(noPrevious.verifyAccessToken(legacy)).rejects.toThrow();
  });

  it("recusa algoritmos diferentes de EdDSA", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    const hs = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256", kid: oldPair.kid })
      .setSubject(USER)
      .setIssuedAt()
      .setIssuer("comunidade-crista")
      .setAudience("comunidade-crista-api")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(64)));
    await expect(jwt.verifyAccessToken(hs)).rejects.toThrow("invalid_alg");

    const none = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ sub: USER, role: "admin", iss: "comunidade-crista" }),
      ).toString("base64url"),
      "",
    ].join(".");
    await expect(jwt.verifyAccessToken(none)).rejects.toThrow();
  });

  it("recusa lixo que não é um JWT", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    await expect(jwt.verifyAccessToken("isto-nao-e-um-jwt")).rejects.toThrow();
    await expect(jwt.verifyRecoverySession("")).rejects.toThrow();
  });

  it("um access token não serve como sessão de recuperação (audiências separadas)", async () => {
    const jwt = await createJwtService(envFor(oldPair));
    const access = await jwt.signAccessToken({ sub: USER, role: "user" });
    await expect(jwt.verifyRecoverySession(access)).rejects.toThrow();
    const recovery = await jwt.signRecoverySession(USER);
    await expect(jwt.verifyAccessToken(recovery)).rejects.toThrow();
  });
});

describe("validação das chaves no arranque", () => {
  let a: Pair;
  let b: Pair;
  beforeAll(async () => {
    a = await makePair();
    b = await makePair();
  });

  it("recusa um par que não corresponde", async () => {
    const env = envFor(a, { JWT_PUBLIC_JWK: JSON.stringify(b.publicJwk) });
    await expect(createJwtService(env)).rejects.toThrow(/mesmo par/);
  });

  it("recusa chave pública que contém a parte privada", async () => {
    const env = envFor(a, { JWT_PUBLIC_JWK: JSON.stringify(a.privateJwk) });
    await expect(createJwtService(env)).rejects.toThrow(/parte privada/);
  });

  it("recusa chave privada sem a parte privada", async () => {
    const env = envFor(a, { JWT_PRIVATE_JWK: JSON.stringify(a.publicJwk) });
    await expect(createJwtService(env)).rejects.toThrow(/parte privada/);
  });

  it("recusa chave anterior com a parte privada", async () => {
    const env = envFor(a, {
      JWT_PUBLIC_JWK_PREVIOUS: JSON.stringify(b.privateJwk),
    });
    await expect(createJwtService(env)).rejects.toThrow(/PREVIOUS.*privada/);
  });

  it("recusa chave anterior igual à actual", async () => {
    const env = envFor(a, {
      JWT_PUBLIC_JWK_PREVIOUS: JSON.stringify(a.publicJwk),
    });
    await expect(createJwtService(env)).rejects.toThrow(/igual à chave actual/);
  });

  it("recusa chaves que não são Ed25519", async () => {
    const env = envFor(a, {
      JWT_PUBLIC_JWK: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }),
    });
    await expect(createJwtService(env)).rejects.toThrow(/Ed25519/);
  });

  it("recusa JSON inválido sem revelar o conteúdo", async () => {
    const env = envFor(a, { JWT_PUBLIC_JWK: "{segredo-invalido" });
    const err = await createJwtService(env).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/JSON válido/);
    expect((err as Error).message).not.toContain("segredo-invalido");
  });

  it("JWT_PUBLIC_JWK_PREVIOUS vazio conta como ausente", () => {
    const env = envFor(a, {}, { JWT_PUBLIC_JWK_PREVIOUS: "" });
    expect(env.JWT_PUBLIC_JWK_PREVIOUS).toBeUndefined();
  });
});
