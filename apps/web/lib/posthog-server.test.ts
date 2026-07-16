import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePostHogEvent } from "./posthog-server";

describe("capturePostHogEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.POSTHOG_ENABLED;
    delete process.env.POSTHOG_PROJECT_TOKEN;
    delete process.env.POSTHOG_API_HOST;
    delete process.env.POSTHOG_INSTANCE_ID;
    delete process.env.CORGTEX_RELEASE_GIT_SHA;
    delete process.env.CORGTEX_RELEASE_IMAGE_TAG;
    delete process.env.CORGTEX_RELEASE_VERSION;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it("adds canonical release metadata to server-side PostHog events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    process.env.POSTHOG_ENABLED = "true";
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
    process.env.POSTHOG_API_HOST = "https://us.i.posthog.com";
    process.env.POSTHOG_INSTANCE_ID = "web-production";
    process.env.CORGTEX_RELEASE_GIT_SHA = "older-sha";
    process.env.CORGTEX_RELEASE_IMAGE_TAG = "sha-older-sha";
    process.env.CORGTEX_RELEASE_VERSION = "main-older";
    process.env.RAILWAY_GIT_COMMIT_SHA = "current-sha";

    await expect(capturePostHogEvent({
      distinctId: "user-1",
      event: "corgtex_test",
      properties: {
        route: "/login",
      },
    })).resolves.toEqual({ status: "sent", statusCode: 200 });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.properties).toMatchObject({
      route: "/login",
      corgtex_environment: "test",
      corgtex_instance_id: "web-production",
      corgtex_provider: "railway",
      corgtex_release_git_sha: "current-sha",
      corgtex_release_git_sha_source: "railway",
      corgtex_release_image_tag: "sha-current-sha",
      corgtex_release_version: "main-current-sha",
      corgtex_release_drift_git_sha: true,
      corgtex_release_drift_image_tag: true,
    });
  });
});
