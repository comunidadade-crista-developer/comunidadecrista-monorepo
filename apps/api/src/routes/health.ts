import { DeepHealthResponse, HealthResponse } from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { Client as PgClient } from 'pg';
import type { Env } from '../env.js';

export interface HealthRoutesOptions {
  env: Env;
}

export async function healthRoutes(
  app: FastifyInstance,
  { env }: HealthRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/health',
    {
      schema: {
        response: { 200: HealthResponse },
        // leve: não tocar em DB nem Redis
      },
    },
    async () => ({
      status: 'ok' as const,
      version: env.APP_VERSION,
      timestamp: new Date().toISOString(),
    }),
  );

  f.get(
    '/health/deep',
    {
      schema: { response: { 200: DeepHealthResponse } },
    },
    async (_request, reply) => {
      const dbCheck = await checkDb(env.DATABASE_URL);
      const redisCheck = await checkRedis(env.REDIS_URL);
      const allOk = (dbCheck === 'ok' || dbCheck === 'not_configured') &&
        (redisCheck === 'ok' || redisCheck === 'not_configured');

      return reply.code(200).send({
        status: allOk ? 'ok' : 'degraded',
        version: env.APP_VERSION,
        timestamp: new Date().toISOString(),
        checks: { db: dbCheck, redis: redisCheck },
      });
    },
  );
}

type Check = 'ok' | 'fail' | 'not_configured';

async function checkDb(url: string | undefined): Promise<Check> {
  if (!url) return 'not_configured';
  const client = new PgClient({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRedis(url: string | undefined): Promise<Check> {
  if (!url) return 'not_configured';
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG' ? 'ok' : 'fail';
  } catch {
    return 'fail';
  } finally {
    redis.disconnect();
  }
}