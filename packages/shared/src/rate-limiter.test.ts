import { describe, expect, it, beforeEach } from "vitest";
import { checkRateLimit, resetAllRateLimits, RATE_LIMITS } from "./rate-limiter";

describe("rate-limiter", () => {
  beforeEach(() => {
    resetAllRateLimits();
  });

  it("allows requests within the limit", () => {
    const opts = { windowMs: 60_000, limit: 3 };
    const r1 = checkRateLimit("test:1", opts);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = checkRateLimit("test:1", opts);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = checkRateLimit("test:1", opts);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests exceeding the limit", () => {
    const opts = { windowMs: 60_000, limit: 2 };
    checkRateLimit("test:2", opts);
    checkRateLimit("test:2", opts);

    const r3 = checkRateLimit("test:2", opts);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("isolates different keys", () => {
    const opts = { windowMs: 60_000, limit: 1 };
    const r1 = checkRateLimit("key-a", opts);
    expect(r1.allowed).toBe(true);

    const r2 = checkRateLimit("key-b", opts);
    expect(r2.allowed).toBe(true);

    const r3 = checkRateLimit("key-a", opts);
    expect(r3.allowed).toBe(false);
  });

  it("returns a future resetAtMs", () => {
    const opts = { windowMs: 60_000, limit: 5 };
    const result = checkRateLimit("test:reset", opts);
    expect(result.resetAtMs).toBeGreaterThan(Date.now());
  });

  it("exports pre-defined rate limit tiers", () => {
    expect(RATE_LIMITS.API_PER_WORKSPACE.limit).toBe(120);
    expect(RATE_LIMITS.AGENT_PER_WORKSPACE.limit).toBe(10);
    expect(RATE_LIMITS.WEBHOOK_INGEST_PER_WORKSPACE.limit).toBe(30);
    expect(RATE_LIMITS.AUTH_PER_IP.limit).toBe(20);
  });
});
