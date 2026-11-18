import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function createRedis(url: string): RedisClient {
  // Fail fast instead of queueing commands forever while Redis is unreachable.
  return new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
}
