import {
  DeleteAccountRequest,
  DeleteAccountResponse,
  ErrorResponse,
} from "@comunidade/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { JwtService } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import type { PasswordService } from "../auth/password.js";
import type { RateLimiters } from "../auth/rate-limit.js";
import type { Database } from "../db/client.js";
import type { Env } from "../env.js";
import { accountDeletionRepo } from "../repositories/account-deletion.js";
import { usersRepo } from "../repositories/users.js";

export interface AccountRoutesOptions {
  env: Env;
  db: Database;
  password: PasswordService;
  jwt: JwtService;
  limiters: RateLimiters;
}

export async function accountRoutes(
  app: FastifyInstance,
  { env, db, password, jwt, limiters }: AccountRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const users = usersRepo(db);
  const deletion = accountDeletionRepo(db);

  // Pede o apagamento da conta: fica pendente ACCOUNT_DELETION_GRACE_DAYS dias e um login
  // com a palavra-passe correcta reactiva-a. POST (e não DELETE) porque leva corpo.
  f.post(
    "/users/me/deletion",
    {
      preHandler: requireAuth(jwt),
      schema: {
        body: DeleteAccountRequest,
        response: {
          200: DeleteAccountResponse,
          401: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = await users.findById(request.user!.id);
      if (!user) return reply.code(401).send({ error: "invalid_token" });

      // Mesmo limite do login: um access token roubado não pode servir para adivinhar a
      // palavra-passe aqui.
      const rl = await limiters.checkLogin(request.clientIp, user.username);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }
      const ok = await password.verifyPassword(
        user.passwordHash,
        request.body.password,
      );
      if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
      await limiters.loginSucceeded(request.clientIp, user.username);

      const result = await deletion.request({
        userId: user.id,
        postsMode: request.body.postsMode,
        graceDays: env.ACCOUNT_DELETION_GRACE_DAYS,
      });
      if (result.outcome === "not_found") {
        return reply.code(401).send({ error: "invalid_token" });
      }
      if (result.outcome === "last_admin") {
        return reply.code(409).send({ error: "last_admin" });
      }
      return reply.code(200).send({
        status: "pending_deletion" as const,
        purgeAt: result.purgeAt.toISOString(),
      });
    },
  );
}
