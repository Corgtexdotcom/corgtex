import { beforeEach, describe, expect, it, vi } from "vitest";

const { delMock, evalMock } = vi.hoisted(() => ({
  delMock: vi.fn(),
  evalMock: vi.fn(),
}));

vi.mock("./redis", () => ({
  getRedisClient: vi.fn(async () => ({ del: delMock, eval: evalMock })),
  isRedisConfigured: vi.fn(() => true),
  redisKey: (key: string) => `test:${key}`,
}));

vi.mock("./env", () => ({
  env: {
    NODE_ENV: "production",
  },
}));

describe("redis rate limiter", () => {
  beforeEach(() => {
    delMock.mockReset();
    evalMock.mockReset();
  });

  it("uses Redis when configured", async () => {
    evalMock.mockResolvedValue([1, 4, Date.now() + 60_000]);

    const { checkRateLimit } = await import("./rate-limiter");
    const result = await checkRateLimit("redis:key", { windowMs: 60_000, limit: 5 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(evalMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      keys: ["test:rate-limit:redis:key"],
    }));
  });

  it("fails closed for security-sensitive limits when Redis errors in production", async () => {
    evalMock.mockRejectedValue(new Error("redis down"));

    const { checkRateLimit } = await import("./rate-limiter");
    const result = await checkRateLimit("redis:auth", { windowMs: 60_000, limit: 5, failClosed: true });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("clears Redis-backed rate limit buckets", async () => {
    delMock.mockResolvedValue(1);

    const { resetRateLimit } = await import("./rate-limiter");
    const result = await resetRateLimit("redis:key");

    expect(result).toEqual({
      key: "redis:key",
      memoryCleared: true,
      redisCleared: true,
    });
    expect(delMock).toHaveBeenCalledWith("test:rate-limit:redis:key");
  });
});
