import {
  ErrorResponse,
  LoginRequest,
  LogoutRequest,
  MeResponse,
  RefreshRequest,
  RecoverResetRequest,
  RecoverVerifyRequest,
  RegisterRequest,
} from "@comunidade/shared";
import type {
  LoginResponse,
  RecoverResetResponse,
  RecoverVerifyResponse,
  RefreshResponse,
  RegisterResponse,
} from "@comunidade/shared";
import { isUniqueViolation } from "../errors.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import type { JwtService } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import type { PasswordService } from "../auth/password.js";
import type { RateLimiters } from "../auth/rate-limit.js";
import { generateRefreshToken, hashRefreshToken } from "../auth/refresh.js";
import type { RecoveryService } from "../auth/recovery.js";
import type { Database } from "../db/client.js";
import type { Env } from "../env.js";
import { recoveryRepo } from "../repositories/recovery.js";
import { refreshTokensRepo, usersRepo } from "../repositories/users.js";

export interface AuthRoutesOptions {
  env: Env;
  db: Database;
  password: PasswordService;
  recovery: RecoveryService;
  jwt: JwtService;
  limiters: RateLimiters;
}

const RECOVERY_WARNING =
  "Guarda este código num lugar seguro. Não voltará a ser mostrado. Usa-o para recuperar a conta se esqueceres a palavra-passe.";

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { env, db, password, recovery, jwt, limiters } = opts;
  const users = usersRepo(db);
  const tokens = refreshTokensRepo(db);
  const resets = recoveryRepo(db);

  const refreshTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

  f.post(
    "/auth/register",
    { schema: { body: RegisterRequest } },
    async (request, reply) => {
      const rl = await limiters.checkRegister(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const body = request.body;
      const existing = await users.findByUsername(body.username);
      if (existing) {
        return reply.code(409).send({ error: "username_taken" });
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
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "username_taken" });
        }
        request.log.error({ err }, "register: unexpected insert error");
        throw err;
      }

      const familyId = uuidv7();
      const refreshToken = generateRefreshToken();
      await tokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      });

      const accessToken = await jwt.signAccessToken({
        sub: user.id,
        role: user.role,
      });

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

  f.post(
    "/auth/login",
    { schema: { body: LoginRequest } },
    async (request, reply) => {
      const body = request.body;
      const rl = await limiters.checkLogin(request.clientIp, body.username);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const user = await users.findByUsername(body.username);
      const sentinel = await password.getSentinelHash();
      const currentOk = await password.verifyPassword(
        user?.passwordHash ?? sentinel,
        body.password,
      );

      // Pedido de recuperação por perguntas pendente: a nova palavra-passe também é aceite,
      // mas só depois do prazo. Numa falha corre-se sempre uma 2.ª verificação (contra o hash
      // pendente ou a sentinela), para o tempo de resposta não revelar se há pedido pendente
      // nem se o utilizador existe.
      const pending = user ? await resets.getPending(user.id) : null;
      const pendingOk = currentOk
        ? false
        : await password.verifyPassword(
            pending?.passwordHash ?? sentinel,
            body.password,
          );

      if (!user || (!currentOk && !pendingOk)) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      let pendingRecoveryCancelled = false;
      let newRecoveryCode: string | null = null;

      if (currentOk) {
        // Quem sabe a palavra-passe actual não precisa de recuperar a conta: se havia um
        // pedido pendente, não foi o dono — cancela-se e avisa-se.
        if (pending)
          pendingRecoveryCancelled = await resets.cancelPending(user.id);
      } else {
        if (!pending || pending.effectiveAt > new Date()) {
          return reply.code(401).send({
            error: "recovery_pending",
            effectiveAt: pending?.effectiveAt.toISOString(),
          });
        }
        const code = recovery.generate();
        const applied = await resets.applyPendingIfDue({
          userId: user.id,
          recoveryCodeHash: await recovery.hashCode(code.canonical),
        });
        if (!applied) {
          return reply.code(401).send({ error: "invalid_credentials" });
        }
        newRecoveryCode = code.formatted;
      }

      await limiters.loginSucceeded(request.clientIp, body.username);

      const familyId = uuidv7();
      const refreshToken = generateRefreshToken();
      await tokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      });
      await users.touchLastLogin(user.id);

      const accessToken = await jwt.signAccessToken({
        sub: user.id,
        role: user.role,
      });

      const response: LoginResponse = {
        user: { id: user.id, username: user.username, role: user.role },
        accessToken,
        refreshToken,
        ...(pendingRecoveryCancelled ? { pendingRecoveryCancelled: true } : {}),
        ...(newRecoveryCode
          ? {
              recoveryCode: newRecoveryCode,
              recoveryCodeWarning: RECOVERY_WARNING,
            }
          : {}),
      };
      return reply.code(200).send(response);
    },
  );

  f.post(
    "/auth/refresh",
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

      if (result.status === "not_found") {
        return reply.code(401).send({ error: "invalid_refresh" });
      }
      if (result.status === "expired") {
        return reply.code(401).send({ error: "refresh_expired" });
      }
      if (result.status === "reuse_detected") {
        request.log.warn(
          { familyId: result.familyId },
          "refresh token reuse detected — family revoked",
        );
        return reply.code(401).send({ error: "token_reuse" });
      }

      const user = await users.findById(result.userId);
      if (!user || user.deletedAt) {
        return reply.code(401).send({ error: "invalid_refresh" });
      }

      const accessToken = await jwt.signAccessToken({
        sub: user.id,
        role: user.role,
      });

      const response: RefreshResponse = {
        accessToken,
        refreshToken: newToken,
      };
      return reply.code(200).send(response);
    },
  );

  f.post(
    "/auth/logout",
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
    "/auth/me",
    {
      preHandler: authPre,
      schema: { response: { 200: MeResponse, 401: ErrorResponse } },
    },
    async (request, reply) => {
      const user = await users.findById(request.user!.id);
      if (!user) return reply.code(401).send({ error: "invalid_token" });
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

  f.post(
    "/auth/recover/verify",
    { schema: { body: RecoverVerifyRequest } },
    async (request, reply) => {
      const body = request.body;
      const rl = await limiters.checkRecover(
        request.clientIp,
        body.username,
        body.mode,
      );
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const user = await users.findByUsername(body.username);
      const sentinel = await password.getSentinelHash();

      // Trabalho constante: com ou sem utilizador (ou sem código guardado) fazem-se sempre
      // as mesmas verificações argon2, contra a sentinela quando não há hash real.
      let ok: boolean;
      if (body.mode === "code") {
        ok = await recovery.verifyCode(
          user?.recoveryCodeHash ?? sentinel,
          body.code,
        );
      } else {
        const [a, b, c] = await Promise.all([
          password.verifyAnswer(user?.securityQ1Hash ?? sentinel, body.answer1),
          password.verifyAnswer(user?.securityQ2Hash ?? sentinel, body.answer2),
          password.verifyAnswer(user?.securityQ3Hash ?? sentinel, body.answer3),
        ]);
        ok = a && b && c;
      }

      if (!user || !ok) {
        return reply.code(401).send({ error: "invalid_recovery" });
      }

      await limiters.recoverSucceeded(
        request.clientIp,
        body.username,
        body.mode,
      );

      const recoverySession = await jwt.signRecoverySession(user.id, body.mode);
      const response: RecoverVerifyResponse = {
        recoverySession,
        expiresIn: 5 * 60,
      };
      return reply.code(200).send(response);
    },
  );

  f.post(
    "/auth/recover/reset",
    { schema: { body: RecoverResetRequest } },
    async (request, reply) => {
      let session: Awaited<ReturnType<JwtService["verifyRecoverySession"]>>;
      try {
        session = await jwt.verifyRecoverySession(request.body.recoverySession);
      } catch {
        return reply.code(401).send({ error: "invalid_recovery_session" });
      }

      const user = await users.findById(session.sub);
      if (!user)
        return reply.code(401).send({ error: "invalid_recovery_session" });

      const newPasswordHash = await password.hashPassword(
        request.body.newPassword,
      );
      const consumed = { jti: session.jti, expiresAt: session.expiresAt };

      if (session.method === "code") {
        // Prova forte (código de 80 bits): efeito imediato, uma só transacção.
        const newCode = recovery.generate();
        const outcome = await resets.completeResetWithCode({
          session: consumed,
          userId: user.id,
          passwordHash: newPasswordHash,
          recoveryCodeHash: await recovery.hashCode(newCode.canonical),
        });
        if (outcome === "replayed") {
          return reply.code(401).send({ error: "invalid_recovery_session" });
        }
        const response: RecoverResetResponse = {
          status: "completed",
          recoveryCode: newCode.formatted,
          recoveryCodeWarning: RECOVERY_WARNING,
        };
        return reply.code(200).send(response);
      }

      // Prova fraca (perguntas): nada muda já. A nova palavra-passe fica pendente durante
      // RECOVERY_QUESTIONS_DELAY_HOURS e não se emite código novo (senão o código dava a
      // volta ao atraso). Se o dono entrar entretanto com a palavra-passe actual, é cancelado.
      const effectiveAt = new Date(
        Date.now() + env.RECOVERY_QUESTIONS_DELAY_HOURS * 60 * 60 * 1000,
      );
      const outcome = await resets.requestDelayedReset({
        session: consumed,
        userId: user.id,
        passwordHash: newPasswordHash,
        effectiveAt,
      });
      if (outcome === "replayed") {
        return reply.code(401).send({ error: "invalid_recovery_session" });
      }
      const response: RecoverResetResponse = {
        status: "pending",
        effectiveAt: effectiveAt.toISOString(),
      };
      return reply.code(200).send(response);
    },
  );
}
