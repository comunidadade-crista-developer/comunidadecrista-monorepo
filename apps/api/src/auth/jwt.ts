import { SignJWT, importJWK, jwtVerify, type JWK } from 'jose';
import type { Env } from '../env.js';

export interface AccessTokenPayload {
  sub: string;
  role: 'user' | 'admin';
}

export interface JwtService {
  signAccessToken(payload: AccessTokenPayload): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
  signRecoverySession(userId: string): Promise<string>;
  verifyRecoverySession(token: string): Promise<{ sub: string }>;
}

export async function createJwtService(env: Env): Promise<JwtService> {
  if (!env.JWT_PRIVATE_JWK || !env.JWT_PUBLIC_JWK) {
    throw new Error(
      'JWT_PRIVATE_JWK e JWT_PUBLIC_JWK são obrigatórios. Corre: pnpm --filter @comunidade/api generate-jwt-keys',
    );
  }
  const privateKey = await importJWK(JSON.parse(env.JWT_PRIVATE_JWK) as JWK, 'EdDSA');
  const publicKey = await importJWK(JSON.parse(env.JWT_PUBLIC_JWK) as JWK, 'EdDSA');

  const accessOpts = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE };
  const recoveryAudience = `${env.JWT_AUDIENCE}:recovery`;
  const recoveryOpts = { issuer: env.JWT_ISSUER, audience: recoveryAudience };

  return {
    async signAccessToken({ sub, role }) {
      return new SignJWT({ role })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(env.JWT_AUDIENCE)
        .setExpirationTime(env.ACCESS_TOKEN_TTL)
        .sign(privateKey);
    },
    async verifyAccessToken(token) {
      const { payload } = await jwtVerify(token, publicKey, accessOpts);
      if (typeof payload.sub !== 'string') throw new Error('invalid_subject');
      const role = payload.role === 'admin' ? 'admin' : 'user';
      return { sub: payload.sub, role };
    },
    async signRecoverySession(userId) {
      return new SignJWT({ purpose: 'recovery' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(userId)
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(recoveryAudience)
        .setExpirationTime(env.RECOVERY_SESSION_TTL)
        .sign(privateKey);
    },
    async verifyRecoverySession(token) {
      const { payload } = await jwtVerify(token, publicKey, recoveryOpts);
      if (payload.purpose !== 'recovery') throw new Error('invalid_purpose');
      if (typeof payload.sub !== 'string') throw new Error('invalid_subject');
      return { sub: payload.sub };
    },
  };
}