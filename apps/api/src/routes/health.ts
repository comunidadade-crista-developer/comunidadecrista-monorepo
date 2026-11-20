import { DeepHealthResponse, HealthResponse } from "@comunidade/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { Env } from "../env.js";

export interface HealthRoutesOptions {
  env: Env;
  redis: Redis | null;
  /** Pool da aplicação: o `/health/deep` reutiliza-o em vez de abrir uma ligação por pedido. */
  pool: Pool | null;
}

/** Limite próprio do `/health/deep` (público, toca na BD e no Redis), por IP. */
const DEEP_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
const CHECK_TIMEOUT_MS = 2000;

export async function healthRoutes(
  app: FastifyInstance,
  { env, redis, pool }: HealthRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    "/health",
    { schema: { response: { 200: HealthResponse } } },
    async () => ({
      status: "ok" as const,
      version: env.APP_VERSION,
      timestamp: new Date().toISOString(),
    }),
  );

  f.get(
    "/health/deep",
    {
      config: { rateLimit: DEEP_RATE_LIMIT },
      schema: { response: { 200: DeepHealthResponse } },
    },
    async (_req, reply) => {
      const [db, rd] = await Promise.all([checkDb(pool), checkRedis(redis)]);
      const allOk =
        (db === "ok" || db === "not_configured") &&
        (rd === "ok" || rd === "not_configured");
      return reply.code(200).send({
        status: allOk ? "ok" : "degraded",
        version: env.APP_VERSION,
        timestamp: new Date().toISOString(),
        checks: { db, redis: rd },
      });
    },
  );
}

type Check = "ok" | "fail" | "not_configured";

/** Rejeita se a operação não terminar a tempo (o timer não mantém o processo vivo). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDb(pool: Pool | null): Promise<Check> {
  if (!pool) return "not_configured";
  try {
    await withTimeout(pool.query("SELECT 1"), CHECK_TIMEOUT_MS);
    return "ok";
  } catch {
    return "fail";
  }
}

async function checkRedis(redis: Redis | null): Promise<Check> {
  if (!redis) return "not_configured";
  try {
    const pong = await withTimeout(redis.ping(), CHECK_TIMEOUT_MS);
    return pong === "PONG" ? "ok" : "fail";
  } catch {
    return "fail";
  }
}
