import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedStateBackend, sharedStateKey } from "./shared-state";
import { checkRateLimit, resetRateLimit } from "./rate-limiter";
import { getCacheJson, getCacheVersion, incrementCacheVersion, setCacheJson } from "./cache";
import { postgresSharedState } from "./postgres-shared-state";

vi.mock("./redis", () => ({
  isRedisConfigured: () => true,
  getRedisClient: vi.fn(() => { throw new Error("Redis must not be contacted"); }),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("shared state routing", () => {
  it("defaults to Redis and rejects invalid backend names", () => {
    vi.stubEnv("SHARED_STATE_BACKEND", "");
    expect(getSharedStateBackend()).toBe("redis");
    vi.stubEnv("SHARED_STATE_BACKEND", "postgress");
    expect(() => getSharedStateBackend()).toThrow("Invalid SHARED_STATE_BACKEND");
  });
  it("hashes keys with distinct namespaces and kinds", () => {
    vi.stubEnv("REDIS_KEY_PREFIX", "one");
    const key = sharedStateKey("cache", "private@example.test");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(sharedStateKey("rate-limit", "private@example.test"));
    vi.stubEnv("REDIS_KEY_PREFIX", "two");
    expect(key).not.toBe(sharedStateKey("cache", "private@example.test"));
  });
  it("fails closed without falling back on PostgreSQL outages", async () => {
    vi.stubEnv("SHARED_STATE_BACKEND", "postgres");
    vi.spyOn(postgresSharedState, "check").mockRejectedValue(new Error("database down"));
    const opts = { limit: 3, windowMs: 1000 };
    expect((await checkRateLimit("auth", { ...opts, failClosed: true })).allowed).toBe(false);
    await expect(checkRateLimit("ordinary", opts)).rejects.toThrow("database down");
    vi.spyOn(postgresSharedState, "reset").mockRejectedValue(new Error("database down"));
    expect(await resetRateLimit("auth")).toMatchObject({ backend: "postgres", sharedStateCleared: false, redisCleared: false });
  });
  it("returns cache misses and propagates invalidation failures without local fallback", async () => {
    vi.stubEnv("SHARED_STATE_BACKEND", "postgres");
    vi.spyOn(postgresSharedState, "getJson").mockRejectedValue(new Error("database down"));
    vi.spyOn(postgresSharedState, "setJson").mockRejectedValue(new Error("database down"));
    vi.spyOn(postgresSharedState, "getVersion").mockRejectedValue(new Error("database down"));
    vi.spyOn(postgresSharedState, "incrementVersion").mockRejectedValue(new Error("database down"));
    await expect(getCacheJson("cache")).resolves.toBeNull();
    await expect(setCacheJson("cache", {}, 1000)).rejects.toThrow("database down");
    await expect(getCacheVersion("scope")).rejects.toThrow("database down");
    await expect(incrementCacheVersion("scope")).rejects.toThrow("database down");
  });
});
