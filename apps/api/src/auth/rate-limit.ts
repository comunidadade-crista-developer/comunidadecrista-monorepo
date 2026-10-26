import { createHmac, randomBytes } from 'node:crypto';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { Redis } from 'ioredis';
import type { Env } from '../env.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export interface RateLimiters {
  checkLogin(ip: string, username: string): Promise<RateLimitResult>;
  checkRegister(ip: string): Promise<RateLimitResult>;
  checkRecover(ip: string, username: string): Promise<RateLimitResult>;
}

export function createRateLimiters(redis: Redis | null, env: Env): RateLimiters {
  if (!redis) {
    const allow = async (): Promise<RateLimitResult> => ({ allowed: true });
    return { checkLogin: allow, checkRegister: allow, checkRecover: allow };
  }

  // IP e username nunca vão em claro para o Redis (Upstash): só um HMAC truncado, que
  // permite contar tentativas mas não recuperar o IP. Sem IP_HASH_SECRET (só dev/test) o
  // segredo é efémero por processo.
  const secret = env.IP_HASH_SECRET ?? randomBytes(32).toString('hex');
  const anon = (...parts: string[]): string =>
    createHmac('sha256', secret).update(parts.join('\u0000')).digest('hex').slice(0, 32);

  const login = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:login',
    points: env.RATE_LIMIT_LOGIN_MAX,
    duration: env.RATE_LIMIT_LOGIN_WINDOW_S,
    blockDuration: env.RATE_LIMIT_LOGIN_WINDOW_S,
  });
  const register = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:register',
    points: env.RATE_LIMIT_REGISTER_MAX,
    duration: env.RATE_LIMIT_REGISTER_WINDOW_S,
    blockDuration: env.RATE_LIMIT_REGISTER_WINDOW_S,
  });
  const recover = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:recover',
    points: env.RATE_LIMIT_RECOVER_MAX,
    duration: env.RATE_LIMIT_RECOVER_WINDOW_S,
    blockDuration: env.RATE_LIMIT_RECOVER_WINDOW_S,
  });

  const wrap = async (limiter: RateLimiterRedis, key: string): Promise<RateLimitResult> => {
    try {
      await limiter.consume(key);
      return { allowed: true };
    } catch (err) {
      // RateLimiterRes ou erro de Redis
      if (err && typeof err === 'object' && 'msBeforeNext' in err) {
        const ms = (err as { msBeforeNext: number }).msBeforeNext;
        return { allowed: false, retryAfter: Math.ceil(ms / 1000) };
      }
      // Redis falhou: fail-open com aviso
      return { allowed: true };
    }
  };

  return {
    checkLogin: (ip, username) => wrap(login, anon(ip, username.toLowerCase())),
    checkRegister: (ip) => wrap(register, anon(ip)),
    checkRecover: (ip, username) => wrap(recover, anon(ip, username.toLowerCase())),
  };
}