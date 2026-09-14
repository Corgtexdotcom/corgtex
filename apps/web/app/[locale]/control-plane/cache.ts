import type { AppActor } from "@corgtex/shared";

const CONTROL_PLANE_READ_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  cachedAt: Date;
  expiresAt: number;
  value: unknown;
};

type ControlPlaneCacheStore = {
  __corgtexControlPlaneReadCache?: Map<string, CacheEntry>;
  __corgtexControlPlanePendingReads?: Map<string, Promise<CacheEntry>>;
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

function pendingStore() {
  const globalStore = globalThis as ControlPlaneCacheStore;
  globalStore.__corgtexControlPlanePendingReads ??= new Map();
  return globalStore.__corgtexControlPlanePendingReads;
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

  const pending = pendingStore();
  let request = refresh ? undefined : pending.get(key);
  if (!request) {
    const next = Promise.resolve().then(async () => {
      const value = await load();
      const cachedAt = new Date();
      const entry = {
        cachedAt,
        expiresAt: cachedAt.getTime() + CONTROL_PLANE_READ_CACHE_TTL_MS,
        value,
      };
      // A refresh or invalidation supersedes this read, even if it finishes last.
      if (pending.get(key) === next) store.set(key, entry);
      return entry;
    });
    pending.set(key, next);
    request = next;
  }
  let entry: CacheEntry;
  try {
    entry = await request;
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
  return {
    data: entry.value as T,
    cachedAt: entry.cachedAt,
    cacheStatus: refresh ? "refresh" : "miss",
  };
}

export function invalidateControlPlaneReadCache(match?: string) {
  const store = cacheStore();
  const pending = pendingStore();
  if (!match) {
    store.clear();
    pending.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.includes(match)) store.delete(key);
  }
  for (const key of pending.keys()) {
    if (key.includes(match)) pending.delete(key);
  }
}

export function shouldRefreshControlPlaneCache(value?: string | null) {
  return value === "1" || value === "true";
}
