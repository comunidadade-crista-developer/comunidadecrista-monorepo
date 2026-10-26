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
