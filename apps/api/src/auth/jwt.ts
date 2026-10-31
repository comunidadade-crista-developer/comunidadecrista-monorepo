import { randomUUID } from "node:crypto";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import type { Env } from "../env.js";

export interface AccessTokenPayload {
  sub: string;
  role: "user" | "admin";
}

export type RecoveryMethod = "code" | "questions";

export interface RecoverySessionPayload {
  sub: string;
  jti: string;
  method: RecoveryMethod;
  expiresAt: Date;
}

export interface JwtService {
  readonly keyId: string;
  signAccessToken(payload: AccessTokenPayload): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
  signRecoverySession(userId: string, method?: RecoveryMethod): Promise<string>;
  verifyRecoverySession(token: string): Promise<RecoverySessionPayload>;
}

type VerifyKey = { kid: string; key: Awaited<ReturnType<typeof importJWK>> };

function parseJwk(raw: string, name: string): JWK {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} não é JSON válido`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} tem de ser um objecto JWK`);
  }
  const jwk = value as JWK;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error(`${name} tem de ser uma chave Ed25519 (kty OKP)`);
  }
  return jwk;
}

function assertPublicOnly(jwk: JWK, name: string): void {
  if ("d" in jwk) {
    throw new Error(`${name} não pode conter a parte privada (d)`);
  }
}

async function loadVerifyKey(jwk: JWK): Promise<VerifyKey> {
  return {
    kid: await calculateJwkThumbprint({
      kty: "OKP",
      crv: "Ed25519",
      x: jwk.x as string,
    }),
    key: await importJWK(jwk, "EdDSA"),
  };
}

export async function createJwtService(env: Env): Promise<JwtService> {
  if (!env.JWT_PRIVATE_JWK || !env.JWT_PUBLIC_JWK) {
    throw new Error(
      "JWT_PRIVATE_JWK e JWT_PUBLIC_JWK são obrigatórios. Corre: pnpm --filter @comunidade/api generate-jwt-keys",
    );
  }

  const privateJwk = parseJwk(env.JWT_PRIVATE_JWK, "JWT_PRIVATE_JWK");
  if (typeof privateJwk.d !== "string") {
    throw new Error("JWT_PRIVATE_JWK tem de conter a parte privada (d)");
  }
  const publicJwk = parseJwk(env.JWT_PUBLIC_JWK, "JWT_PUBLIC_JWK");
  assertPublicOnly(publicJwk, "JWT_PUBLIC_JWK");
  if (privateJwk.x !== publicJwk.x) {
    throw new Error(
      "JWT_PRIVATE_JWK e JWT_PUBLIC_JWK não são o mesmo par de chaves",
    );
  }

  const privateKey = await importJWK(privateJwk, "EdDSA");
  const current = await loadVerifyKey(publicJwk);

  const verifyKeys: VerifyKey[] = [current];
  if (env.JWT_PUBLIC_JWK_PREVIOUS) {
    const previousJwk = parseJwk(
      env.JWT_PUBLIC_JWK_PREVIOUS,
      "JWT_PUBLIC_JWK_PREVIOUS",
    );
    assertPublicOnly(previousJwk, "JWT_PUBLIC_JWK_PREVIOUS");
    if (previousJwk.x === publicJwk.x) {
      throw new Error(
        "JWT_PUBLIC_JWK_PREVIOUS é igual à chave actual: retira-a da configuração",
      );
    }
    verifyKeys.push(await loadVerifyKey(previousJwk));
  }

  async function verify(
    token: string,
    opts: { issuer: string; audience: string },
  ): Promise<JWTPayload> {
    let header: { alg?: string; kid?: unknown };
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new Error("invalid_token");
    }
    if (header.alg !== "EdDSA") throw new Error("invalid_alg");

    const candidates =
      header.kid === undefined
        ? verifyKeys
        : verifyKeys.filter((k) => k.kid === header.kid);
    if (candidates.length === 0) throw new Error("unknown_kid");

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const { payload } = await jwtVerify(token, candidate.key, {
          ...opts,
          algorithms: ["EdDSA"],
        });
        return payload;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  const accessOpts = {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  };
  const recoveryAudience = `${env.JWT_AUDIENCE}:recovery`;
  const recoveryOpts = {
    issuer: env.JWT_ISSUER,
    audience: recoveryAudience,
  };
  const header = { alg: "EdDSA", kid: current.kid } as const;

  return {
    keyId: current.kid,
    async signAccessToken({ sub, role }) {
      return new SignJWT({ role })
        .setProtectedHeader(header)
        .setSubject(sub)
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(env.JWT_AUDIENCE)
        .setExpirationTime(env.ACCESS_TOKEN_TTL)
        .sign(privateKey);
    },
    async verifyAccessToken(token) {
      const payload = await verify(token, accessOpts);
      if (typeof payload.sub !== "string") throw new Error("invalid_subject");
      const role = payload.role === "admin" ? "admin" : "user";
      return { sub: payload.sub, role };
    },
    async signRecoverySession(userId, method = "questions") {
      return new SignJWT({ purpose: "recovery", method })
        .setProtectedHeader(header)
        .setSubject(userId)
        .setJti(randomUUID())
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(recoveryAudience)
        .setExpirationTime(env.RECOVERY_SESSION_TTL)
        .sign(privateKey);
    },
    async verifyRecoverySession(token) {
      const payload = await verify(token, recoveryOpts);
      if (payload.purpose !== "recovery") throw new Error("invalid_purpose");
      if (typeof payload.sub !== "string") throw new Error("invalid_subject");
      if (typeof payload.jti !== "string" || payload.jti.length === 0) {
        throw new Error("invalid_jti");
      }
      if (payload.method !== "code" && payload.method !== "questions") {
        throw new Error("invalid_method");
      }
      if (typeof payload.exp !== "number") throw new Error("invalid_exp");
      return {
        sub: payload.sub,
        jti: payload.jti,
        method: payload.method,
        expiresAt: new Date(payload.exp * 1000),
      };
    },
  };
}
