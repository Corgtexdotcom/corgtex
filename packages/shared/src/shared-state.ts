import { env } from "./env";
import { isRedisConfigured } from "./redis";
import { sha256 } from "./crypto";

export function getSharedStateBackend(): "redis" | "postgres" {
  return env.SHARED_STATE_BACKEND ?? "redis";
}

export function isSharedStateConfigured() {
  return getSharedStateBackend() === "postgres" ? Boolean(env.DATABASE_URL) : isRedisConfigured();
}

export function sharedStateKey(kind: string, key: string) {
  return sha256(JSON.stringify([env.REDIS_KEY_PREFIX, kind, key]));
}
