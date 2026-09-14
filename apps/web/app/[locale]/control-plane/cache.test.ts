import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateControlPlaneReadCache, readControlPlaneCached } from "./cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  invalidateControlPlaneReadCache();
  vi.useRealTimers();
});

describe("control plane cached reads", () => {
  it("coalesces simultaneous reads with equivalent keys", async () => {
    const result = deferred<string>();
    const load = vi.fn(() => result.promise);
    const first = readControlPlaneCached(["user:a", { b: 2, a: 1 }], false, load);
    const second = readControlPlaneCached(["user:a", { a: 1, b: 2 }], false, load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    result.resolve("roster");
    const values = await Promise.all([first, second]);
    expect(values[0]).toEqual(values[1]);
    expect(values[0].cacheStatus).toBe("miss");
    expect((await readControlPlaneCached(["user:a", { a: 1, b: 2 }], false, load)).cacheStatus).toBe("hit");
  });

  it("keeps actors and filters isolated", async () => {
    const load = vi.fn(async () => "value");
    await Promise.all([
      readControlPlaneCached(["user:a", "local"], false, load),
      readControlPlaneCached(["user:b", "local"], false, load),
      readControlPlaneCached(["user:a", "remote"], false, load),
    ]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("retries a failed coalesced read", async () => {
    const result = deferred<string>();
    const load = vi.fn(() => result.promise);
    const reads = [readControlPlaneCached(["a"], false, load), readControlPlaneCached(["a"], false, load)];
    const settled = Promise.allSettled(reads);
    result.reject(new Error("database unavailable"));
    expect((await settled).map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await readControlPlaneCached(["a"], false, async () => "retry")).data).toBe("retry");
  });

  it("lets refresh supersede an older in-flight read", async () => {
    const old = deferred<string>();
    const first = readControlPlaneCached(["a"], false, () => old.promise);
    const fresh = await readControlPlaneCached(["a"], true, async () => "fresh");
    expect(fresh.cacheStatus).toBe("refresh");
    old.resolve("old");
    expect((await first).data).toBe("old");
    expect((await readControlPlaneCached(["a"], false, async () => "unexpected")).data).toBe("fresh");
  });

  it.each([undefined, "target"])("does not refill invalidated entries (%s)", async (match) => {
    const old = deferred<string>();
    const first = readControlPlaneCached(["target"], false, () => old.promise);
    invalidateControlPlaneReadCache(match);
    old.resolve("old");
    await first;
    const load = vi.fn(async () => "fresh");
    expect((await readControlPlaneCached(["target"], false, load)).data).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated pending reads when invalidating a match", async () => {
    const result = deferred<string>();
    const load = vi.fn(() => result.promise);
    const first = readControlPlaneCached(["other"], false, load);
    invalidateControlPlaneReadCache("target");
    const second = readControlPlaneCached(["other"], false, load);
    result.resolve("retained");
    await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts the TTL at completion and reloads expired entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const result = deferred<string>();
    const first = readControlPlaneCached(["a"], false, () => result.promise);
    vi.setSystemTime(30_000);
    result.resolve("first");
    await first;
    const load = vi.fn(async () => "second");
    vi.setSystemTime(89_999);
    expect((await readControlPlaneCached(["a"], false, load)).cacheStatus).toBe("hit");
    vi.setSystemTime(90_000);
    expect((await readControlPlaneCached(["a"], false, load)).data).toBe("second");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
