import { DeepHealthResponse, HealthResponse } from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { Client as PgClient } from 'pg';
import type { Env } from '../env.js';

export interface HealthRoutesOptions {
  env: Env;
  redis: Redis | null;
}

export async function healthRoutes(
  app: FastifyInstance,
  { env, redis }: HealthRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/health',
    { schema: { response: { 200: HealthResponse } } },
    async () => ({
      status: 'ok' as const,
      version: env.APP_VERSION,
      timestamp: new Date().toISOString(),
    }),
  );

  f.get(
    '/health/deep',
    { schema: { response: { 200: DeepHealthResponse } } },
    async (_req, reply) => {
      const db = await checkDb(env.DATABASE_URL);
      const rd = await checkRedis(redis);
      const allOk =
        (db === 'ok' || db === 'not_configured') &&
        (rd === 'ok' || rd === 'not_configured');
      return reply.code(200).send({
        status: allOk ? 'ok' : 'degraded',
        version: env.APP_VERSION,
        timestamp: new Date().toISOString(),
        checks: { db, redis: rd },
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

async function checkRedis(redis: Redis | null): Promise<Check> {
  if (!redis) return 'not_configured';
  try {
    const pong = await redis.ping();
    return pong === 'PONG' ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}