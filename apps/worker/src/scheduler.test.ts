import { describe, expect, it, vi } from "vitest";
import { createSchedulerLock, withSchedulerLock, type SchedulerLock } from "./scheduler";

const { construct, query, disconnect } = vi.hoisted(() => ({ construct: vi.fn(), query: vi.fn(), disconnect: vi.fn() }));
vi.mock("@prisma/client", () => ({ PrismaClient: class {
  constructor(options: unknown) { construct(options); }
  $queryRaw = query;
  $disconnect = disconnect;
} }));

function fixture(acquired = true) {
  return { acquire: vi.fn(async () => acquired), release: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined) } satisfies SchedulerLock;
}

describe("one-shot scheduler lease", () => {
  it("pins advisory acquire and release to one dedicated connection", async () => {
    query.mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{ released: true }]);
    const lock = createSchedulerLock("postgresql://localhost/synthetic?connection_limit=12&sslmode=require");
    expect(construct).toHaveBeenLastCalledWith({ datasources: { db: { url: "postgresql://localhost/synthetic?connection_limit=1&sslmode=require" } }, log: [] });
    const execute = vi.fn(async () => "done");
    expect(await withSchedulerLock(lock, execute)).toEqual({ skipped: false, result: "done" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalled();
  });
  it("skips overlapping executions successfully and disconnects without unlocking another owner's lock", async () => {
    const lock = fixture(false);
    const execute = vi.fn();
    expect(await withSchedulerLock(lock, execute)).toEqual({ skipped: true });
    expect(execute).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    expect(lock.disconnect).toHaveBeenCalledOnce();
  });
  it("holds the lock until all in-flight scheduling completes", async () => {
    const lock = fixture();
    let finish!: () => void;
    const pending = withSchedulerLock(lock, () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(lock.release).not.toHaveBeenCalled();
    expect(lock.disconnect).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(lock.release).toHaveBeenCalledOnce();
    expect(lock.disconnect).toHaveBeenCalledOnce();
  });
  it("releases and disconnects after execution failure without swallowing it", async () => {
    const lock = fixture();
    await expect(withSchedulerLock(lock, async () => { throw new Error("cycle failed"); })).rejects.toThrow("cycle failed");
    expect(lock.release).toHaveBeenCalledOnce();
    expect(lock.disconnect).toHaveBeenCalledOnce();
  });
  it("disconnects after acquire or release failures", async () => {
    const acquire = fixture();
    acquire.acquire.mockRejectedValue(new Error("acquire failed"));
    await expect(withSchedulerLock(acquire, vi.fn())).rejects.toThrow("acquire failed");
    expect(acquire.release).not.toHaveBeenCalled();
    expect(acquire.disconnect).toHaveBeenCalledOnce();
    const release = fixture();
    release.release.mockRejectedValue(new Error("release failed"));
    await expect(withSchedulerLock(release, vi.fn())).rejects.toThrow("release failed");
    expect(release.disconnect).toHaveBeenCalledOnce();
  });
});
