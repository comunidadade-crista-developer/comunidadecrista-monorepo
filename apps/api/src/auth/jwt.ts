import { randomUUID } from "node:crypto";
import { SignJWT, importJWK, jwtVerify, type JWK } from "jose";
import type { Env } from "../env.js";

export interface AccessTokenPayload {
  sub: string;
  role: "user" | "admin";
}

/** Como o utilizador provou ser o dono: o código (forte) ou as perguntas (fraco, com atraso). */
export type RecoveryMethod = "code" | "questions";

export interface RecoverySessionPayload {
  sub: string;
  /** Identificador único da sessão — consumido no reset (uso único). */
  jti: string;
  method: RecoveryMethod;
  expiresAt: Date;
}

export interface JwtService {
  signAccessToken(payload: AccessTokenPayload): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
  /** Por omissão 'questions' (o método com menos privilégios). */
  signRecoverySession(userId: string, method?: RecoveryMethod): Promise<string>;
  verifyRecoverySession(token: string): Promise<RecoverySessionPayload>;
}

export async function createJwtService(env: Env): Promise<JwtService> {
  if (!env.JWT_PRIVATE_JWK || !env.JWT_PUBLIC_JWK) {
    throw new Error(
      "JWT_PRIVATE_JWK e JWT_PUBLIC_JWK são obrigatórios. Corre: pnpm --filter @comunidade/api generate-jwt-keys",
    );
  }
  const privateKey = await importJWK(
    JSON.parse(env.JWT_PRIVATE_JWK) as JWK,
    "EdDSA",
  );
  const publicKey = await importJWK(
    JSON.parse(env.JWT_PUBLIC_JWK) as JWK,
    "EdDSA",
  );

  const accessOpts = {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithms: ["EdDSA"],
  };
  const recoveryAudience = `${env.JWT_AUDIENCE}:recovery`;
  const recoveryOpts = {
    issuer: env.JWT_ISSUER,
    audience: recoveryAudience,
    algorithms: ["EdDSA"],
  };

  return {
    async signAccessToken({ sub, role }) {
      return new SignJWT({ role })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(sub)
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(env.JWT_AUDIENCE)
        .setExpirationTime(env.ACCESS_TOKEN_TTL)
        .sign(privateKey);
    },
    async verifyAccessToken(token) {
      const { payload } = await jwtVerify(token, publicKey, accessOpts);
      if (typeof payload.sub !== "string") throw new Error("invalid_subject");
      const role = payload.role === "admin" ? "admin" : "user";
      return { sub: payload.sub, role };
    },
    async signRecoverySession(userId, method = "questions") {
      return new SignJWT({ purpose: "recovery", method })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(userId)
        .setJti(randomUUID())
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(recoveryAudience)
        .setExpirationTime(env.RECOVERY_SESSION_TTL)
        .sign(privateKey);
    },
    async verifyRecoverySession(token) {
      const { payload } = await jwtVerify(token, publicKey, recoveryOpts);
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
