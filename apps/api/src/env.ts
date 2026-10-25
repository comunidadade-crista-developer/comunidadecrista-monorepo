import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  APP_VERSION: z.string().default('dev'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  JWT_PRIVATE_JWK: z.string().optional(),
  JWT_PUBLIC_JWK: z.string().optional(),
  JWT_ISSUER: z.string().default('comunidade-crista'),
  JWT_AUDIENCE: z.string().default('comunidade-crista-api'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RECOVERY_SESSION_TTL: z.string().default('5m'),

  ARGON2_MEMORY_KB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_S: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REGISTER_WINDOW_S: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_RECOVER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_RECOVER_WINDOW_S: z.coerce.number().int().positive().default(3600),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }
  return parsed.data;
}