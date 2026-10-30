import { Redis } from "ioredis";

export function createRedis(url: string | undefined): Redis | null {
  if (!url) return null;
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    lazyConnect: false,
    enableOfflineQueue: false,
  });
}

export function waitUntilReady(
  redis: Redis,
  timeoutMs = 3000,
): Promise<boolean> {
  if (redis.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      redis.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    redis.once("ready", onReady);
  });
}

export interface RedisLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Regista erros do Redis sem a mensagem (traz host/porta) e no máximo uma vez por intervalo:
 * com o Redis em baixo, o ioredis volta a tentar e emite um 'error' por tentativa.
 * Sem listener de 'error' o ioredis escreve a mensagem completa na consola.
 */
export function attachRedisErrorLogging(
  redis: Pick<Redis, "on">,
  log: RedisLogger,
  { intervalMs = 30_000, now = Date.now } = {},
): void {
  let last = Number.NEGATIVE_INFINITY;
  redis.on("error", (err: unknown) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    log.warn(
      {
        errorName: err instanceof Error ? err.name : typeof err,
        errorCode:
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          typeof (err as { code: unknown }).code === "string"
            ? (err as { code: string }).code
            : undefined,
      },
      "redis error",
    );
  });
}
