import { beforeEach, describe, expect, it } from "vitest";
import { getCacheJson, getCacheVersion, incrementCacheVersion, resetLocalCacheStore, setCacheJson } from "./cache";

describe("cache", () => {
  beforeEach(() => {
    resetLocalCacheStore();
  });

  it("stores JSON values in the local fallback cache", async () => {
    await setCacheJson("test:key", { ok: true }, 60_000);

    await expect(getCacheJson("test:key")).resolves.toEqual({ ok: true });
  });

  it("increments local cache versions", async () => {
    await expect(getCacheVersion("knowledge:ws-1")).resolves.toBe(0);
    await incrementCacheVersion("knowledge:ws-1");

    await expect(getCacheVersion("knowledge:ws-1")).resolves.toBe(1);
  });
});
