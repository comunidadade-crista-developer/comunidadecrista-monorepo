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

/**
 * Com enableOfflineQueue=false, qualquer comando enviado antes da ligação estar pronta falha
 * de imediato — e o rate limit falha em aberto. Esperar aqui evita essa janela no arranque
 * (cold start do Render). Devolve false se não ligar a tempo; o servidor arranca na mesma.
 */
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
