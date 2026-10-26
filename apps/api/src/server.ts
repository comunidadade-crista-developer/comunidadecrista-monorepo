import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createJwtService } from './auth/jwt.js';
import { createPasswordService } from './auth/password.js';
import { createRateLimiters } from './auth/rate-limit.js';
import { createRecoveryService } from './auth/recovery.js';
import { createDb } from './db/client.js';
import type { Env } from './env.js';
import { createRedis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildServerOptions {
  env: Env;
}

export async function buildServer({ env }: BuildServerOptions) {
  const isOnRender = process.env.RENDER === 'true';
 const trustProxyValue: boolean | ((addr: string, hop: number) => boolean) =
  env.TRUST_PROXY || isOnRender
    ? (addr: string, hop: number) => {
        const trusted = hop < 1;
        console.log('[trustProxy]', { addr, hop, trusted });
        return trusted;
      }
    : false;

   const app = Fastify({
     logger:
       env.NODE_ENV === 'development'
         ? {
             level: env.LOG_LEVEL,
             transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
           }
         : { level: env.LOG_LEVEL },
    trustProxy: trustProxyValue,
   }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const redis = createRedis(env.REDIS_URL);
  if (redis) {
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => {});
    });
  }

  const dbBundle = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;
  if (dbBundle) {
    app.addHook('onClose', async () => {
      await dbBundle.pool.end().catch(() => {});
    });
  }

  const password = createPasswordService(env);
  const recovery = createRecoveryService(password);
  const jwt = await createJwtService(env);
  const limiters = createRateLimiters(redis, env);

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
    app.log.warn('DATABASE_URL não configurado — rotas de auth desactivadas.');
  }

  return app;
}