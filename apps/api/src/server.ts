import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import { healthRoutes } from './routes/health.js';

export interface BuildServerOptions {
  env: Env;
}

export async function buildServer({ env }: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? {
            level: env.LOG_LEVEL,
            transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
          }
        : { level: env.LOG_LEVEL },
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'test',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false, // API JSON apenas; CSP será configurado quando houver serving de HTML
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    // Nota: no E2 passará a usar Upstash (via store distribuído).
  });

  await app.register(healthRoutes, { env });

  return app;
}