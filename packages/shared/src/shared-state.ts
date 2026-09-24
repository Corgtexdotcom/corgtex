import { env } from "./env";
import { isRedisConfigured } from "./redis";
import { isSecretEncryptionConfigured, sha256 } from "./crypto";

export function getSharedStateBackend(): "redis" | "postgres" {
  return env.SHARED_STATE_BACKEND ?? "redis";
}

export function isSharedStateConfigured() {
  if (getSharedStateBackend() !== "postgres") return isRedisConfigured();
  try {
    return Boolean(env.DATABASE_URL) && isSecretEncryptionConfigured();
  } catch {
    return false;
  }
}

export function sharedStateKey(kind: string, key: string) {
  return sha256(JSON.stringify([env.REDIS_KEY_PREFIX, kind, key]));
}
