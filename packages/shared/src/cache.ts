import { getRedisClient, redisKey } from "./redis";

type CacheEntry = {
  expiresAt: number;
  value: string;
};

const memoryCache = new Map<string, CacheEntry>();
const memoryVersions = new Map<string, number>();

const VERSION_TTL_MS = 24 * 60 * 60 * 1000;

function getMemoryValue(key: string) {
  const hit = memoryCache.get(key);
  if (!hit) {
    return null;
  }

  if (hit.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  return hit.value;
}

function setMemoryValue(key: string, value: string, ttlMs: number) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export async function getCacheJson<T>(key: string): Promise<T | null> {
  const namespacedKey = `cache:${key}`;
  const client = await getRedisClient();

  if (client) {
    try {
      const raw = await client.get(redisKey(namespacedKey));
      return raw ? JSON.parse(raw) as T : null;
    } catch {
      return null;
    }
  }

  const raw = getMemoryValue(namespacedKey);
  return raw ? JSON.parse(raw) as T : null;
}

export async function setCacheJson(key: string, value: unknown, ttlMs: number) {
  const namespacedKey = `cache:${key}`;
  const raw = JSON.stringify(value);
  const client = await getRedisClient();

  if (client) {
    try {
      await client.set(redisKey(namespacedKey), raw, { PX: ttlMs });
      return;
    } catch {
      // Fall back to local memory below.
    }
  }

  setMemoryValue(namespacedKey, raw, ttlMs);
}

export async function getCacheVersion(scope: string) {
  const key = `cache-version:${scope}`;
  const client = await getRedisClient();

  if (client) {
    try {
      const raw = await client.get(redisKey(key));
      return raw ? Number.parseInt(raw, 10) || 0 : 0;
    } catch {
      return memoryVersions.get(key) ?? 0;
    }
  }

  return memoryVersions.get(key) ?? 0;
}

export async function incrementCacheVersion(scope: string) {
  const key = `cache-version:${scope}`;
  const client = await getRedisClient();

  if (client) {
    try {
      const next = await client.incr(redisKey(key));
      await client.pExpire(redisKey(key), VERSION_TTL_MS);
      return next;
    } catch {
      // Fall back to local memory below.
    }
  }

  const next = (memoryVersions.get(key) ?? 0) + 1;
  memoryVersions.set(key, next);
  return next;
}

export function resetLocalCacheStore() {
  memoryCache.clear();
  memoryVersions.clear();
}
