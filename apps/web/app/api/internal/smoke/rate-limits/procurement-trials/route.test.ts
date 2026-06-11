import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetRateLimitsMock, sharedEnv } = vi.hoisted(() => ({
  resetRateLimitsMock: vi.fn(),
  sharedEnv: {
    NODE_ENV: "production",
    REDIS_URL: "",
    REDIS_KEY_PREFIX: "test",
    SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
    SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS: "smoke.example,selfserve.corgtex.com",
  },
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    env: sharedEnv,
    isDatabaseUnavailableError: vi.fn(() => false),
    isRedisConfigured: vi.fn(() => Boolean(sharedEnv.REDIS_URL)),
    resetRateLimits: resetRateLimitsMock,
  };
});

function resetRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/internal/smoke/rate-limits/procurement-trials", {
    method: "POST",
    headers: {
      "authorization": "Bearer capture-secret",
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/internal/smoke/rate-limits/procurement-trials", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sharedEnv.REDIS_URL = "";
    sharedEnv.SMOKE_EMAIL_CAPTURE_SECRET = "capture-secret";
    sharedEnv.SMOKE_EMAIL_CAPTURE_ALLOWED_DOMAINS = "smoke.example,selfserve.corgtex.com";
    resetRateLimitsMock.mockImplementation(async (keys: string[]) => keys.map((key) => ({
      key,
      memoryCleared: true,
      redisCleared: false,
    })));
  });

  it("requires the smoke capture secret", async () => {
    const { POST } = await import("./route");
    const response = await POST(resetRequest({
      companyName: "Smoke Company",
      adminEmail: "agent@smoke.example",
    }, {
      authorization: "Bearer wrong-secret",
    }));

    expect(response.status).toBe(401);
    expect(resetRateLimitsMock).not.toHaveBeenCalled();
  });

  it("only resets allowlisted smoke capture domains", async () => {
    const { POST } = await import("./route");
    const response = await POST(resetRequest({
      companyName: "Real Company",
      adminEmail: "agent@real.example",
    }));

    expect(response.status).toBe(400);
    expect(resetRateLimitsMock).not.toHaveBeenCalled();
  });

  it("resets the trial-create buckets for the smoke identity", async () => {
    const { POST } = await import("./route");
    const response = await POST(resetRequest({
      companyName: "Smoke Company",
      adminEmail: "Agent@Smoke.Example",
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reset.keys).toEqual([
      "ip:203.0.113.10:procurement-trial",
      "email:agent-smoke.example:procurement-trial",
      "company:smoke-company:procurement-trial",
      "domain:smoke.example:procurement-trial",
    ]);
    expect(resetRateLimitsMock).toHaveBeenCalledWith(body.reset.keys);
  });

  it("fails when Redis-backed counters cannot be cleared in production", async () => {
    sharedEnv.REDIS_URL = "redis://example";
    const { POST } = await import("./route");
    const response = await POST(resetRequest({
      companyName: "Smoke Company",
      adminEmail: "agent@smoke.example",
    }));

    expect(response.status).toBe(503);
  });
});
