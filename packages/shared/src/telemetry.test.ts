import { afterEach, describe, expect, it, vi } from "vitest";
import { buildErrorTelemetryEvent, captureTelemetryEvent, sanitizeProperties, telemetryRuntimeContext } from "./telemetry";

function testEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...overrides,
  };
}

describe("telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds release, environment, provider, and instance fields to error events", () => {
    const event = buildErrorTelemetryEvent({
      action: "uploadMeetingTranscriptStateAction",
      code: "INTERNAL_ERROR",
      digest: "245988471",
      error: new TypeError("raw text must stay out"),
      status: 500,
      surface: "server_action",
      workspaceId: "workspace-1",
    }, testEnv({
      CORGTEX_RELEASE_GIT_SHA: "sha-1",
      CORGTEX_RELEASE_IMAGE_TAG: "sha-sha-1",
      CORGTEX_RELEASE_VERSION: "main-sha-1",
      NODE_ENV: "production",
      POSTHOG_INSTANCE_ID: "client-example-production",
      RAILWAY_SERVICE_ID: "railway-service",
    }));

    expect(event).toEqual(expect.objectContaining({
      distinctId: "workspace:workspace-1",
      event: "corgtex_server_action_error",
    }));
    expect(event.properties).toEqual(expect.objectContaining({
      action: "uploadMeetingTranscriptStateAction",
      code: "INTERNAL_ERROR",
      digest: "245988471",
      environment: "production",
      error_class: "TypeError",
      instance_id: "client-example-production",
      provider: "railway",
      release_git_sha: "sha-1",
      release_image_tag: "sha-sha-1",
      release_version: "main-sha-1",
      status: 500,
      surface: "server_action",
      workspace_id: "workspace-1",
    }));
    expect(JSON.stringify(event)).not.toContain("raw text must stay out");
  });

  it("sanitizes secrets and transcript content from nested properties", () => {
    const sanitized = sanitizeProperties({
      authorization: "Bearer secret",
      details: {
        safe: "value",
        transcript: "Jan: private transcript",
      },
      error_message: "raw error body",
      route: "/workspaces/:workspaceId/meetings",
      token: "secret-token",
    });

    expect(sanitized).toEqual({
      details: {
        safe: "value",
      },
      route: "/workspaces/:workspaceId/meetings",
    });
    expect(JSON.stringify(sanitized)).not.toContain("private transcript");
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect(JSON.stringify(sanitized)).not.toContain("raw error body");
  });

  it("derives release git SHA from image tag when explicit SHA is missing", () => {
    expect(telemetryRuntimeContext(testEnv({
      CORGTEX_RELEASE_IMAGE_TAG: "sha-abc123",
      WORKSPACE_SLUG: "example",
    }))).toEqual(expect.objectContaining({
      instance_id: "example",
      provider: "local",
      release_git_sha: "abc123",
      release_image_tag: "sha-abc123",
    }));
  });

  it("uses the same runtime-over-configured release SHA precedence as health", () => {
    expect(telemetryRuntimeContext(testEnv({
      CORGTEX_RELEASE_GIT_SHA: "older-sha",
      CORGTEX_RELEASE_IMAGE_TAG: "sha-older-sha",
      CORGTEX_RELEASE_VERSION: "main-older",
      RAILWAY_GIT_COMMIT_SHA: "current-sha",
    }))).toEqual(expect.objectContaining({
      provider: "railway",
      release_configured_git_sha: "older-sha",
      release_drift_git_sha: true,
      release_drift_image_tag: true,
      release_git_sha: "current-sha",
      release_git_sha_source: "railway",
      release_image_tag: "sha-current-sha",
      release_runtime_git_sha: "current-sha",
      release_version: "main-current-sha",
    }));
  });

  it("sends sanitized events to PostHog and Application Insights when configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await captureTelemetryEvent({
      distinctId: "workspace:one",
      event: "corgtex_test_event",
      properties: {
        route: "/safe",
        transcript: "private transcript",
      },
    }, testEnv({
      APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=ikey;IngestionEndpoint=https://example.monitor.azure.com/",
      POSTHOG_API_HOST: "https://us.i.posthog.com",
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: "phc_test",
    }));

    expect(result).toEqual({ azure: "sent", posthog: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postHogBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const azureBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(postHogBody.properties.route).toBe("/safe");
    expect(JSON.stringify(postHogBody)).not.toContain("private transcript");
    expect(azureBody[0].iKey).toBe("ikey");
    expect(azureBody[0].data.baseData.name).toBe("corgtex_test_event");
    expect(JSON.stringify(azureBody)).not.toContain("private transcript");
  });

  it("honors explicit event sample-rate overrides for smoke events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(captureTelemetryEvent({
      distinctId: "smoke:release",
      event: "corgtex_release_telemetry_smoke",
      sampleRate: 1,
    }, testEnv({
      POSTHOG_ENABLED: "true",
      POSTHOG_EVENT_SAMPLE_RATE: "0",
      POSTHOG_PROJECT_TOKEN: "phc_test",
    }))).resolves.toEqual({ azure: "disabled", posthog: "sent" });

    const postHogBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postHogBody.properties.corgtex_sample_rate).toBe(1);
  });
});
