import { describe, expect, it } from "vitest";

import {
  expectedReleaseGitSha,
  telemetrySent,
} from "./telemetry-release-smoke.mjs";

describe("telemetry release smoke", () => {
  it("prefers an explicit expected release SHA over the GitHub SHA", () => {
    expect(expectedReleaseGitSha({
      CORGTEX_EXPECTED_RELEASE_GIT_SHA: " expected-sha ",
      GITHUB_SHA: "github-sha",
    })).toBe("expected-sha");
  });

  it("uses GITHUB_SHA when no explicit expected release SHA is set", () => {
    expect(expectedReleaseGitSha({
      GITHUB_SHA: "github-sha",
    })).toBe("github-sha");
  });

  it("requires at least one telemetry sink to send", () => {
    expect(telemetrySent({ posthog: "sent", azure: "disabled" })).toBe(true);
    expect(telemetrySent({ posthog: "disabled", azure: "sent" })).toBe(true);
    expect(telemetrySent({ posthog: "disabled", azure: "disabled" })).toBe(false);
    expect(telemetrySent({ posthog: "failed", azure: "disabled" })).toBe(false);
    expect(telemetrySent(null)).toBe(false);
  });
});
