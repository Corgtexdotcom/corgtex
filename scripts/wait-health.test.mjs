import { describe, expect, it, vi } from "vitest";

import {
  healthPayloadMismatch,
  healthWaitConfig,
  waitForHealth,
} from "./wait-health.mjs";

const healthyPayload = {
  status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", auth: "password-session",
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("wait-health", () => {
  it("accepts the canonical Corgtex health payload", () => {
    expect(healthPayloadMismatch(healthyPayload)).toBeNull();
    expect(healthPayloadMismatch({ ...healthyPayload, schema: "stale" })).toContain("schema");
  });

  it("uses safe retry defaults and positive overrides", () => {
    expect(healthWaitConfig({})).toEqual({ attempts: 30, intervalMs: 10_000, timeoutMs: 10_000 });
    expect(healthWaitConfig({
      CORGTEX_HEALTH_WAIT_ATTEMPTS: "2",
      CORGTEX_HEALTH_WAIT_INTERVAL_MS: "50",
      CORGTEX_HEALTH_WAIT_TIMEOUT_MS: "100",
    })).toEqual({ attempts: 2, intervalMs: 50, timeoutMs: 100 });
    expect(healthWaitConfig({
      CORGTEX_HEALTH_WAIT_ATTEMPTS: "0",
      CORGTEX_HEALTH_WAIT_INTERVAL_MS: "nope",
      CORGTEX_HEALTH_WAIT_TIMEOUT_MS: "-1",
    })).toEqual({ attempts: 30, intervalMs: 10_000, timeoutMs: 10_000 });
  });

  it("retries 502s and succeeds on a later healthy response", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(502, { status: "error" }))
      .mockResolvedValueOnce(response(200, healthyPayload));
    const sleep = vi.fn();

    await expect(waitForHealth("https://app.test/api/health", {
      label: "app",
      fetchImpl,
      sleep,
      config: { attempts: 2, intervalMs: 1, timeoutMs: 10 },
    })).resolves.toMatchObject({ status: "ok" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails with the last observed status and body context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503, { status: "degraded", schema: "stale" }));

    await expect(waitForHealth("https://app.test/api/health", {
      label: "app",
      fetchImpl,
      sleep: vi.fn(),
      config: { attempts: 1, intervalMs: 1, timeoutMs: 10 },
    })).rejects.toThrow("schema");
  });
});
