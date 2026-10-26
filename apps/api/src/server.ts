import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createJwtService } from "./auth/jwt.js";
import { createPasswordService } from "./auth/password.js";
import { createRateLimiters } from "./auth/rate-limit.js";
import { createRecoveryService } from "./auth/recovery.js";
import { createDb } from "./db/client.js";
import type { Env } from "./env.js";
import { createEdgeGuard } from "./net/edge.js";
import { createRedis, waitUntilReady } from "./redis.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildServerOptions {
  env: Env;
  /** Destino alternativo dos logs (testes). */
  logStream?: NodeJS.WritableStream;
}

// Privacidade: os logs nunca levam IP, cabeçalhos nem query string. O Fastify, por omissão,
// regista remoteAddress/remotePort em cada pedido — aqui o serializer `req` substitui-o.
const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-origin-auth"]',
  'req.headers["x-forwarded-for"]',
  'req.headers["cf-connecting-ip"]',
  'req.headers["true-client-ip"]',
  "req.remoteAddress",
  "req.remotePort",
];

function pathOnly(url: string | undefined): string | undefined {
  if (!url) return url;
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

export async function buildServer({ env, logStream }: BuildServerOptions) {
  const trustProxy =
    env.EDGE_MODE === "none" && env.TRUST_PROXY
      ? (_addr: string, hop: number) => hop < env.TRUST_PROXY_HOPS
      : false;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: LOG_REDACT_PATHS, remove: true },
      serializers: {
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          url: pathOnly(req.url),
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      ...(logStream
        ? { stream: logStream }
        : env.NODE_ENV === "development"
          ? {
              transport: {
                target: "pino-pretty",
                options: { translateTime: "SYS:standard" },
              },
            }
          : {}),
    },
    trustProxy,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Tem de correr antes do rate limit global, que usa request.clientIp.
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", createEdgeGuard(env).onRequest);

  // Respostas da API nunca devem ser guardadas em cache (Cloudflare, browsers, proxies).
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.clientIp,
  });

  const redis = createRedis(env.REDIS_URL);
  if (redis && !(await waitUntilReady(redis))) {
    app.log.warn(
      "Redis indisponível no arranque — rate limit pode falhar em aberto.",
    );
  }
  if (redis) {
    app.addHook("onClose", async () => {
      await redis.quit().catch(() => {});
    });
  }

  const dbBundle = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;
  if (dbBundle) {
    app.addHook("onClose", async () => {
      await dbBundle.pool.end().catch(() => {});
    });
  }

  const password = createPasswordService(env);
  const recovery = createRecoveryService(password);
  const jwt = await createJwtService(env);
  const limiters = createRateLimiters(redis, env, app.log);

  await app.register(healthRoutes, { env, redis });

  if (dbBundle) {
    await app.register(authRoutes, {
      env,
      db: dbBundle.db,
      password,
      recovery,
      jwt,
      limiters,
    });
  } else {
    app.log.warn("DATABASE_URL não configurado — rotas de auth desactivadas.");
  }

  return app;
}
