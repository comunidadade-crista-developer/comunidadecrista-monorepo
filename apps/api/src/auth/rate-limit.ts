import { createHmac, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from "rate-limiter-flexible";
import type { Env } from "../env.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export type RecoverMode = "code" | "questions";

export interface RateLimiters {
  /** Consome 1 ponto em 3 baldes: IP, IP+utilizador e conta (só o utilizador). */
  checkLogin(ip: string, username: string): Promise<RateLimitResult>;
  /** Login válido: repõe o balde IP+utilizador e devolve o ponto da conta. */
  loginSucceeded(ip: string, username: string): Promise<void>;
  checkRegister(ip: string): Promise<RateLimitResult>;
  /** Consome em 3 baldes: IP, IP+utilizador e conta (balde próprio por modo). */
  checkRecover(
    ip: string,
    username: string,
    mode: RecoverMode,
  ): Promise<RateLimitResult>;
  /** Recuperação validada: repõe IP+utilizador e devolve o ponto da conta. */
  recoverSucceeded(
    ip: string,
    username: string,
    mode: RecoverMode,
  ): Promise<void>;
}

/** Subconjunto do logger do Fastify: nunca recebe IP, username nem o erro completo. */
export interface RateLimitLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Falha inesperada do próprio limitador: recusa em vez de deixar passar. */
const FAIL_CLOSED_RETRY_S = 30;

export function createRateLimiters(
  redis: Redis | null,
  env: Env,
  log?: RateLimitLogger,
): RateLimiters {
  // IP e username nunca vão em claro para o Redis (Upstash): só um HMAC truncado, que
  // permite contar tentativas mas não recuperar o IP. Sem IP_HASH_SECRET (só dev/test) o
  // segredo é efémero por processo.
  const secret = env.IP_HASH_SECRET ?? randomBytes(32).toString("hex");
  const anon = (...parts: string[]): string =>
    createHmac("sha256", secret)
      .update(parts.join("\u0000"))
      .digest("hex")
      .slice(0, 32);

  // Sem Redis, ou com o Redis em baixo, o limite continua a aplicar-se em memória
  // (insuranceLimiter) — nunca falha em aberto.
  const make = (
    keyPrefix: string,
    points: number,
    duration: number,
  ): RateLimiterAbstract => {
    const memory = new RateLimiterMemory({
      keyPrefix,
      points,
      duration,
      blockDuration: duration,
    });
    if (!redis) return memory;
    return new RateLimiterRedis({
      storeClient: redis,
      keyPrefix,
      points,
      duration,
      blockDuration: duration,
      insuranceLimiter: memory,
    });
  };

  const loginIp = make(
    "rl:login:ip",
    env.RATE_LIMIT_LOGIN_IP_MAX,
    env.RATE_LIMIT_LOGIN_IP_WINDOW_S,
  );
  const loginIpUser = make(
    "rl:login",
    env.RATE_LIMIT_LOGIN_MAX,
    env.RATE_LIMIT_LOGIN_WINDOW_S,
  );
  const loginAccount = make(
    "rl:login:acct",
    env.RATE_LIMIT_LOGIN_ACCOUNT_MAX,
    env.RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_S,
  );
  const register = make(
    "rl:register",
    env.RATE_LIMIT_REGISTER_MAX,
    env.RATE_LIMIT_REGISTER_WINDOW_S,
  );
  const recoverIp = make(
    "rl:recover:ip",
    env.RATE_LIMIT_RECOVER_IP_MAX,
    env.RATE_LIMIT_RECOVER_IP_WINDOW_S,
  );
  const recoverIpUser = make(
    "rl:recover",
    env.RATE_LIMIT_RECOVER_MAX,
    env.RATE_LIMIT_RECOVER_WINDOW_S,
  );
  const recoverAccount: Record<RecoverMode, RateLimiterAbstract> = {
    questions: make(
      "rl:recover:acct:questions",
      env.RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_MAX,
      env.RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_WINDOW_S,
    ),
    code: make(
      "rl:recover:acct:code",
      env.RATE_LIMIT_RECOVER_ACCOUNT_CODE_MAX,
      env.RATE_LIMIT_RECOVER_ACCOUNT_CODE_WINDOW_S,
    ),
  };

  const consume = async (
    limiter: RateLimiterAbstract,
    key: string,
  ): Promise<RateLimitResult> => {
    try {
      await limiter.consume(key);
      return { allowed: true };
    } catch (err) {
      // Balde esgotado: o limitador rejeita com um RateLimiterRes.
      if (err && typeof err === "object" && "msBeforeNext" in err) {
        const ms = (err as { msBeforeNext: number }).msBeforeNext;
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil(ms / 1000)),
        };
      }
      // Falha do próprio limitador (Redis e memória): recusar, sem registar dados do pedido.
      log?.warn(
        { errorName: err instanceof Error ? err.name : typeof err },
        "rate limiter failure — failing closed",
      );
      return { allowed: false, retryAfter: FAIL_CLOSED_RETRY_S };
    }
  };

  // Consome por ordem e pára no primeiro balde esgotado (os seguintes não gastam pontos).
  const consumeAll = async (
    steps: ReadonlyArray<readonly [RateLimiterAbstract, string]>,
  ): Promise<RateLimitResult> => {
    for (const [limiter, key] of steps) {
      const result = await consume(limiter, key);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  };

  // Repor/devolver pontos é só uma conveniência: um erro aqui nunca deve partir o pedido.
  const settle = async (
    ops: ReadonlyArray<() => Promise<unknown>>,
  ): Promise<void> => {
    for (const op of ops) {
      try {
        await op();
      } catch {
        log?.warn({}, "rate limiter refund failed");
      }
    }
  };

  return {
    checkLogin: (ip, username) => {
      const user = username.toLowerCase();
      return consumeAll([
        [loginIp, anon(ip)],
        [loginIpUser, anon(ip, user)],
        [loginAccount, anon(user)],
      ]);
    },
    loginSucceeded: (ip, username) => {
      const user = username.toLowerCase();
      return settle([
        () => loginIpUser.delete(anon(ip, user)),
        () => loginAccount.reward(anon(user), 1),
      ]);
    },
    checkRegister: (ip) => consumeAll([[register, anon(ip)]]),
    checkRecover: (ip, username, mode) => {
      const user = username.toLowerCase();
      return consumeAll([
        [recoverIp, anon(ip)],
        [recoverIpUser, anon(ip, user)],
        [recoverAccount[mode], anon(user)],
      ]);
    },
    recoverSucceeded: (ip, username, mode) => {
      const user = username.toLowerCase();
      return settle([
        () => recoverIpUser.delete(anon(ip, user)),
        () => recoverAccount[mode].reward(anon(user), 1),
      ]);
    },
  };
}
