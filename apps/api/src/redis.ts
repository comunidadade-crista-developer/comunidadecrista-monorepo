import { Redis } from 'ioredis';

export function createRedis(url: string | undefined): Redis | null {
  if (!url) return null;
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    lazyConnect: false,
    enableOfflineQueue: false,
  });
}