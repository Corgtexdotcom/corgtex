import { createClient } from "redis";
import { env } from "./env";
import { logger } from "./logger";

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let disabledUntilMs = 0;

const REDIS_RETRY_DELAY_MS = 30_000;

export function isRedisConfigured() {
  return Boolean(env.REDIS_URL);
}

export function redisKey(key: string) {
  return `${env.REDIS_KEY_PREFIX}:${key}`;
}

export async function getRedisClient() {
  if (!env.REDIS_URL) {
    return null;
  }

  if (Date.now() < disabledUntilMs) {
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (connectPromise) {
    return connectPromise;
  }

  redisClient = createClient({ url: env.REDIS_URL });
  redisClient.on("error", (error) => {
    disabledUntilMs = Date.now() + REDIS_RETRY_DELAY_MS;
    logger.warn("Redis client error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  connectPromise = redisClient.connect()
    .then(() => redisClient)
    .catch((error) => {
      disabledUntilMs = Date.now() + REDIS_RETRY_DELAY_MS;
      logger.warn("Redis connection unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      redisClient = null;
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export async function closeRedisClient() {
  const client = redisClient;
  redisClient = null;
  connectPromise = null;
  disabledUntilMs = 0;

  if (client?.isOpen) {
    await client.quit();
  }
}
