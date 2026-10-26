import type { preHandlerAsyncHookHandler } from "fastify";
import type { Database } from "../db/client.js";
import { usersRepo } from "../repositories/users.js";
import type { JwtService } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; role: "user" | "admin" };
  }
}

export function requireAuth(jwt: JwtService): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_token" });
    }
    const token = auth.slice(7).trim();
    try {
      const payload = await jwt.verifyAccessToken(token);
      request.user = { id: payload.sub, role: payload.role };
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
  };
}

export function requireAdmin(db: Database): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    // Revalida na DB: protege contra JWT antigo / utilizador despromovido
    const user = await usersRepo(db).findById(request.user.id);
    if (!user || user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
  };
}
