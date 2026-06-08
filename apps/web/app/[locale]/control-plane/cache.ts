import type { AppActor } from "@corgtex/shared";

const CONTROL_PLANE_READ_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  cachedAt: Date;
  expiresAt: number;
  value: unknown;
};

type ControlPlaneCacheStore = {
  __corgtexControlPlaneReadCache?: Map<string, CacheEntry>;
};

export type ControlPlaneCachedRead<T> = {
  data: T;
  cachedAt: Date;
  cacheStatus: "hit" | "miss" | "refresh";
};

function cacheStore() {
  const globalStore = globalThis as ControlPlaneCacheStore;
  globalStore.__corgtexControlPlaneReadCache ??= new Map();
  return globalStore.__corgtexControlPlaneReadCache;
}

function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableString(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function controlPlaneActorCacheKey(actor: AppActor) {
  if (actor.kind === "user") return `user:${actor.user.id}`;
  return `agent:${actor.label}:${(actor.scopes ?? []).slice().sort().join(",")}`;
}

export async function readControlPlaneCached<T>(
  keyParts: unknown[],
  refresh: boolean,
  load: () => Promise<T>,
): Promise<ControlPlaneCachedRead<T>> {
  const key = stableString(keyParts);
  const now = Date.now();
  const store = cacheStore();
  const existing = store.get(key);
  if (!refresh && existing && existing.expiresAt > now) {
    return {
      data: existing.value as T,
      cachedAt: existing.cachedAt,
      cacheStatus: "hit",
    };
  }

  const value = await load();
  const cachedAt = new Date();
  store.set(key, {
    cachedAt,
    expiresAt: cachedAt.getTime() + CONTROL_PLANE_READ_CACHE_TTL_MS,
    value,
  });
  return {
    data: value,
    cachedAt,
    cacheStatus: refresh ? "refresh" : "miss",
  };
}

export function invalidateControlPlaneReadCache(match?: string) {
  const store = cacheStore();
  if (!match) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.includes(match)) store.delete(key);
  }
}

export function shouldRefreshControlPlaneCache(value?: string | null) {
  return value === "1" || value === "true";
}
