import {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  MeResponse,
  RecoverResetRequest,
  RecoverResetResponse,
  RecoverVerifyRequest,
  RecoverVerifyResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  RegisterResponse,
  type ErrorResponse,
} from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { uuidv7 } from 'uuidv7';
import type { JwtService } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import type { PasswordService } from '../auth/password.js';
import type { RateLimiters } from '../auth/rate-limit.js';
import {
  generateRefreshToken,
  hashRefreshToken,
} from '../auth/refresh.js';
import type { RecoveryService } from '../auth/recovery.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { refreshTokensRepo, usersRepo } from '../repositories/users.js';

export interface AuthRoutesOptions {
  env: Env;
  db: Database;
  password: PasswordService;
  recovery: RecoveryService;
  jwt: JwtService;
  limiters: RateLimiters;
}

const RECOVERY_WARNING =
  'Guarda este código num lugar seguro. Não voltará a ser mostrado. Usa-o para recuperar a conta se esqueceres a palavra-passe.';

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { env, db, password, recovery, jwt, limiters } = opts;
  const users = usersRepo(db);
  const tokens = refreshTokensRepo(db);

  const refreshTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

  f.post<{ Body: typeof RegisterRequest }>(
    '/auth/register',
    { schema: { body: RegisterRequest } },
    async (request, reply) => {
      const rl = await limiters.checkRegister(request.ip);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const body = request.body;
      const existing = await users.findByUsername(body.username);
      if (existing) {
        return reply.code(409).send({ error: 'username_taken' });
      }

      const [passwordHash, q1, q2, q3] = await Promise.all([
        password.hashPassword(body.password),
        password.hashAnswer(body.securityQ1),
        password.hashAnswer(body.securityQ2),
        password.hashAnswer(body.securityQ3),
      ]);

      const code = recovery.generate();
      const recoveryCodeHash = await recovery.hashCode(code.canonical);

      let user;
      try {
        user = await users.create({
          username: body.username,
          passwordHash,
          recoveryCodeHash,
          securityQ1Hash: q1,
          securityQ2Hash: q2,
          securityQ3Hash: q3,
          avatarSeed: `seed-${uuidv7()}`,
        });
      } catch {
        return reply.code(409).send({ error: 'username_taken' });
      }

      const familyId = uuidv7();
      const refreshToken = generateRefreshToken();
      await tokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      });

      const accessToken = await jwt.signAccessToken({ sub: user.id, role: user.role });

      const response: RegisterResponse = {
        user: { id: user.id, username: user.username, role: user.role },
        accessToken,
        refreshToken,
        recoveryCode: code.formatted,
        recoveryCodeWarning: RECOVERY_WARNING,
      };
      return reply.code(201).send(response);
    },
  );

  f.post<{ Body: typeof LoginRequest }>(
    '/auth/login',
    { schema: { body: LoginRequest } },
    async (request, reply) => {
      const body = request.body;
      const rl = await limiters.checkLogin(request.ip, body.username);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const user = await users.findByUsername(body.username);
      // Verifica hash mesmo se user não existe para uniformizar timing
      const fallbackHash =
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000';
      const passwordOk = user
        ? await password.verifyPassword(user.passwordHash, body.password)
        : await password.verifyPassword(fallbackHash, body.password).catch(() => false);

      if (!user || !passwordOk) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const familyId = uuidv7();
      const refreshToken = generateRefreshToken();
      await tokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      });
      await users.touchLastLogin(user.id);

      const accessToken = await jwt.signAccessToken({ sub: user.id, role: user.role });

      const response: LoginResponse = {
        user: { id: user.id, username: user.username, role: user.role },
        accessToken,
        refreshToken,
      };
      return reply.code(200).send(response);
    },
  );

  f.post<{ Body: typeof RefreshRequest }>(
    '/auth/refresh',
    { schema: { body: RefreshRequest } },
    async (request, reply) => {
      const oldHash = hashRefreshToken(request.body.refreshToken);
      const newToken = generateRefreshToken();
      const newHash = hashRefreshToken(newToken);
      const result = await tokens.rotate(
        oldHash,
        newHash,
        new Date(Date.now() + refreshTtlMs),
      );

      if (result.status === 'not_found') {
        return reply.code(401).send({ error: 'invalid_refresh' });
      }
      if (result.status === 'expired') {
        return reply.code(401).send({ error: 'refresh_expired' });
      }
      if (result.status === 'reuse_detected') {
        request.log.warn(
          { familyId: result.familyId, ip: request.ip },
          'refresh token reuse detected — family revoked',
        );
        return reply.code(401).send({ error: 'token_reuse' });
      }

      const user = await users.findById(result.userId);
      if (!user || user.deletedAt) {
        return reply.code(401).send({ error: 'invalid_refresh' });
      }

      const accessToken = await jwt.signAccessToken({ sub: user.id, role: user.role });

      const response: RefreshResponse = {
        accessToken,
        refreshToken: newToken,
      };
      return reply.code(200).send(response);
    },
  );

  f.post<{ Body: typeof LogoutRequest }>(
    '/auth/logout',
    { schema: { body: LogoutRequest } },
    async (request, reply) => {
      const hash = hashRefreshToken(request.body.refreshToken);
      const record = await tokens.findActiveByHash(hash);
      if (record) await tokens.revoke(record.id);
      return reply.code(200).send({ ok: true });
    },
  );

  const authPre = requireAuth(jwt);

  f.get(
    '/auth/me',
    { preHandler: authPre, schema: { response: { 200: MeResponse } } },
    async (request, reply) => {
      const user = await users.findById(request.user!.id);
      if (!user) return reply.code(401).send({ error: 'invalid_token' });
      const response: MeResponse = {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
        },
      };
      return reply.code(200).send(response);
    },
  );

  f.post<{ Body: typeof RecoverVerifyRequest }>(
    '/auth/recover/verify',
    { schema: { body: RecoverVerifyRequest } },
    async (request, reply) => {
      const body = request.body;
      const rl = await limiters.checkRecover(request.ip, body.username);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const user = await users.findByUsername(body.username);
      // Tempo uniforme: mesmo que o user não exista, validamos algo
      const dummyHash =
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000';

      let ok = false;
      if (user) {
        if (body.mode === 'code') {
          ok = user.recoveryCodeHash
            ? await recovery.verifyCode(user.recoveryCodeHash, body.code)
            : false;
        } else {
          const [a, b, c] = await Promise.all([
            password.verifyAnswer(user.securityQ1Hash, body.answer1),
            password.verifyAnswer(user.securityQ2Hash, body.answer2),
            password.verifyAnswer(user.securityQ3Hash, body.answer3),
          ]);
          ok = a && b && c;
        }
      } else {
        // Consistência de tempo
        await password.verifyPassword(dummyHash, 'noop').catch(() => {});
      }

      if (!ok || !user) {
        return reply.code(401).send({ error: 'invalid_recovery' });
      }

      const recoverySession = await jwt.signRecoverySession(user.id);
      const response: RecoverVerifyResponse = {
        recoverySession,
        expiresIn: 5 * 60,
      };
      return reply.code(200).send(response);
    },
  );

  f.post<{ Body: typeof RecoverResetRequest }>(
    '/auth/recover/reset',
    { schema: { body: RecoverResetRequest } },
    async (request, reply) => {
      let userId: string;
      try {
        const payload = await jwt.verifyRecoverySession(request.body.recoverySession);
        userId = payload.sub;
      } catch {
        return reply.code(401).send({ error: 'invalid_recovery_session' });
      }

      const user = await users.findById(userId);
      if (!user) return reply.code(401).send({ error: 'invalid_recovery_session' });

      const newPasswordHash = await password.hashPassword(request.body.newPassword);
      const newCode = recovery.generate();
      const newCodeHash = await recovery.hashCode(newCode.canonical);

      await users.updatePasswordHash(user.id, newPasswordHash);
      await users.updateRecoveryCodeHash(user.id, newCodeHash);
      await tokens.revokeAllForUser(user.id);

      const response: RecoverResetResponse = {
        recoveryCode: newCode.formatted,
        recoveryCodeWarning: RECOVERY_WARNING,
      };
      return reply.code(200).send(response);
    },
  );
}

export type { ErrorResponse };