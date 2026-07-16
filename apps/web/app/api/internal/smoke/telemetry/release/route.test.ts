import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureTelemetryEventMock, sharedEnv } = vi.hoisted(() => ({
  captureTelemetryEventMock: vi.fn(),
  sharedEnv: {
    SMOKE_EMAIL_CAPTURE_SECRET: "capture-secret",
  },
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    captureTelemetryEvent: captureTelemetryEventMock,
    env: sharedEnv,
  };
});

function smokeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/internal/smoke/telemetry/release", {
    method: "POST",
    headers: {
      "authorization": "Bearer capture-secret",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/internal/smoke/telemetry/release", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sharedEnv.SMOKE_EMAIL_CAPTURE_SECRET = "capture-secret";
    process.env.CORGTEX_RELEASE_GIT_SHA = "older-sha";
    process.env.CORGTEX_RELEASE_IMAGE_TAG = "sha-older-sha";
    process.env.CORGTEX_RELEASE_VERSION = "main-older";
    process.env.RAILWAY_GIT_COMMIT_SHA = "current-sha";
    captureTelemetryEventMock.mockResolvedValue({ azure: "disabled", posthog: "sent" });
  });

  afterEach(() => {
    delete process.env.CORGTEX_RELEASE_GIT_SHA;
    delete process.env.CORGTEX_RELEASE_IMAGE_TAG;
    delete process.env.CORGTEX_RELEASE_VERSION;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it("requires the smoke secret", async () => {
    const { POST } = await import("./route");
    const response = await POST(smokeRequest({
      runId: "run-1",
    }, {
      authorization: "Bearer wrong-secret",
    }));

    expect(response.status).toBe(401);
    expect(captureTelemetryEventMock).not.toHaveBeenCalled();
  });

  it("rejects an unexpected live release SHA before emitting telemetry", async () => {
    const { POST } = await import("./route");
    const response = await POST(smokeRequest({
      expectedGitSha: "other-sha",
      runId: "run-1",
    }));

    expect(response.status).toBe(409);
    expect(captureTelemetryEventMock).not.toHaveBeenCalled();
  });

  it("emits a sanitized release telemetry event for the live runtime release", async () => {
    const { POST } = await import("./route");
    const response = await POST(smokeRequest({
      expectedGitSha: "current-sha",
      runId: "run-1",
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.release).toMatchObject({
      gitSha: "current-sha",
      configured: {
        gitSha: "older-sha",
      },
      drift: {
        gitSha: true,
      },
    });
    expect(body.telemetry).toEqual({ azure: "disabled", posthog: "sent" });
    expect(captureTelemetryEventMock).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: "smoke:run-1",
      event: "corgtex_release_telemetry_smoke",
      properties: expect.objectContaining({
        release_git_sha: "current-sha",
        release_git_sha_source: "railway",
        run_id: "run-1",
        smoke_kind: "release_telemetry",
      }),
      sampleRate: 1,
    }));
  });
});
