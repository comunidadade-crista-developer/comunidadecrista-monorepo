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
  checkLogin(ip: string, username: string): Promise<RateLimitResult>;
  loginSucceeded(ip: string, username: string): Promise<void>;
  checkRegister(ip: string): Promise<RateLimitResult>;
  checkRecover(
    ip: string,
    username: string,
    mode: RecoverMode,
  ): Promise<RateLimitResult>;
  recoverSucceeded(
    ip: string,
    username: string,
    mode: RecoverMode,
  ): Promise<void>;
  checkCardsPublic(ip: string): Promise<RateLimitResult>;
  checkReadFeed(ip: string): Promise<RateLimitResult>;
  checkPostsCreate(userId: string): Promise<RateLimitResult>;
  checkPostsDelete(userId: string): Promise<RateLimitResult>;
  checkLikes(userId: string): Promise<RateLimitResult>;
  checkReports(userId: string): Promise<RateLimitResult>;
}

export interface RateLimitLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const FAIL_CLOSED_RETRY_S = 30;

export function createRateLimiters(
  redis: Redis | null,
  env: Env,
  log?: RateLimitLogger,
): RateLimiters {
  const secret = env.IP_HASH_SECRET ?? randomBytes(32).toString("hex");
  const anon = (...parts: string[]): string =>
    createHmac("sha256", secret)
      .update(parts.join("\u0000"))
      .digest("hex")
      .slice(0, 32);

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

  const cardsPublic = make("rl:cards", 30, 60);

  const readFeed = make("rl:feed:read", 60, 60);        
  const postsCreate = make("rl:posts:create", 10, 3600); 
  const postsDelete = make("rl:posts:delete", 30, 3600); 
  const likes = make("rl:likes", 120, 3600);            
  const reports = make("rl:reports", 10, 3600);         

  const consume = async (
    limiter: RateLimiterAbstract,
    key: string,
  ): Promise<RateLimitResult> => {
    try {
      await limiter.consume(key);
      return { allowed: true };
    } catch (err) {
      if (err && typeof err === "object" && "msBeforeNext" in err) {
        const ms = (err as { msBeforeNext: number }).msBeforeNext;
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil(ms / 1000)),
        };
      }
      log?.warn(
        { errorName: err instanceof Error ? err.name : typeof err },
        "rate limiter failure — failing closed",
      );
      return { allowed: false, retryAfter: FAIL_CLOSED_RETRY_S };
    }
  };

  const consumeAll = async (
    steps: ReadonlyArray<readonly [RateLimiterAbstract, string]>,
  ): Promise<RateLimitResult> => {
    for (const [limiter, key] of steps) {
      const result = await consume(limiter, key);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  };

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
    checkCardsPublic: (ip) => consumeAll([[cardsPublic, anon(ip)]]),
    checkReadFeed: (ip) => consumeAll([[readFeed, anon(ip)]]),
    checkPostsCreate: (userId) => consumeAll([[postsCreate, anon(userId)]]),
    checkPostsDelete: (userId) => consumeAll([[postsDelete, anon(userId)]]),
    checkLikes: (userId) => consumeAll([[likes, anon(userId)]]),
    checkReports: (userId) => consumeAll([[reports, anon(userId)]]),
  };
}   