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
import { createCardsCache } from "./cache/cards-cache.js";
import { createFeedCache } from "./cache/feed-cache.js";
import { createDb } from "./db/client.js";
import type { Env } from "./env.js";
import { errorHandler, notFoundHandler } from "./http-errors.js";
import { startMaintenance } from "./maintenance.js";
import { createEdgeGuard } from "./net/edge.js";
import {
  attachRedisErrorLogging,
  createRedis,
  waitUntilReady,
} from "./redis.js";
import { cardsRepo } from "./repositories/cards.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { cardsRoutes } from "./routes/cards.js";
import { healthRoutes } from "./routes/health.js";
import { postsRoutes } from "./routes/posts.js";
import { syncRoutes } from "./routes/sync.js";
import { startOutboxWorker } from "./workers/outbox-worker.js";

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildServerOptions {
  env: Env;
  logStream?: NodeJS.WritableStream;
  disableWorker?: boolean;
}

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

export async function buildServer({
  env,
  logStream,
  disableWorker,
}: BuildServerOptions) {
  const workersDisabled = disableWorker ?? env.NODE_ENV === "test";
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
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Formato de erro único; nunca devolve detalhes internos em erros 5xx.
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Tem de correr antes do rate limit global, que usa request.clientIp.
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", createEdgeGuard(env).onRequest);

  app.addHook("onSend", async (_request, reply, payload) => {
    const declared = reply.getHeader("Cache-Control");
    const publicOk =
      (reply.statusCode === 200 || reply.statusCode === 304) &&
      typeof declared === "string" &&
      declared.startsWith("public");
    if (!publicOk) reply.header("Cache-Control", "no-store");
    return payload;
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    // Sem `credentials`: a autenticação é por Authorization: Bearer, não por cookies.
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: env.RATE_LIMIT_GLOBAL_WINDOW_S * 1000,
    keyGenerator: (request) => request.clientIp,
    // Um Error é lançado e passa pelo errorHandler (formato único `{ error: "rate_limited" }`).
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error("rate limit exceeded"), {
        statusCode: context.statusCode,
      }),
  });

  if (
    env.NODE_ENV === "production" &&
    env.EDGE_MODE === "none" &&
    !env.TRUST_PROXY
  ) {
    // Atrás de um proxy sem TRUST_PROXY todos os utilizadores partilham o IP do proxy e os
    // limites por IP (registo, login) bloqueiam toda a gente de uma vez.
    app.log.warn(
      "Produção com EDGE_MODE=none e TRUST_PROXY=false: se a API está atrás de um proxy, todos os clientes partilham o mesmo IP.",
    );
  }

  const redis = createRedis(env.REDIS_URL);
  if (redis) attachRedisErrorLogging(redis, app.log);
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

  const dbBundle = env.DATABASE_URL
    ? createDb(env.DATABASE_URL, {
        poolMax: env.DB_POOL_MAX,
        queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
        applicationName: "comunidade-api",
        log: app.log,
      })
    : null;
  if (dbBundle) {
    app.addHook("onClose", async () => {
      await dbBundle.pool.end().catch(() => {});
    });
  }

  const password = createPasswordService(env);
  const recovery = createRecoveryService(password);
  const jwt = await createJwtService(env);
  const limiters = createRateLimiters(redis, env, app.log);

  await app.register(healthRoutes, {
    env,
    redis,
    pool: dbBundle?.pool ?? null,
  });

  if (dbBundle) {
    await app.register(authRoutes, {
      env,
      db: dbBundle.db,
      password,
      recovery,
      jwt,
      limiters,
    });
    await app.register(accountRoutes, {
      env,
      db: dbBundle.db,
      password,
      jwt,
      limiters,
    });
    const cardsCache = createCardsCache({
      redis,
      cards: cardsRepo(dbBundle.db),
      logger: app.log,
    });
    const feedCache = createFeedCache({
      redis,
      db: dbBundle.db,
      logger: app.log,
      ttlSeconds: env.FEED_CACHE_TTL_S,
    });
    await app.register(cardsRoutes, { cache: cardsCache, limiters });
    await app.register(postsRoutes, {
      db: dbBundle.db,
      jwt,
      limiters,
      feedCache,
    });
    await app.register(syncRoutes, {
      env,
      db: dbBundle.db,
      jwt,
      limiters,
      feedCache,
      cardsCache,
    });
    await app.register(adminRoutes, {
      db: dbBundle.db,
      jwt,
      limiters,
      feedCache,
    });
    if (!workersDisabled) {
      const db = dbBundle.db;
      let stopMaintenance: (() => Promise<void> | void) | null = null;
      let stopOutbox: (() => Promise<void>) | null = null;
      app.addHook("onReady", async () => {
        stopMaintenance = startMaintenance({ db, env, log: app.log });
        stopOutbox = startOutboxWorker({
          db,
          log: app.log,
          intervalMs: env.OUTBOX_WORKER_INTERVAL_MS,
          batchSize: env.OUTBOX_WORKER_BATCH_SIZE,
        });
      });
      app.addHook("onClose", async () => {
        await stopOutbox?.();
        await stopMaintenance?.();
      });
    }
  } else {
    app.log.warn(
      "DATABASE_URL não configurado — rotas de auth, conta, cards, posts e sync desactivadas.",
    );
  }

  return app;
}
