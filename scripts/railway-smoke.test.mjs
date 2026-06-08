import { describe, expect, it } from "vitest";

import {
  expectedHealthGitSha,
  healthPayloadMismatch,
  healthReleaseMismatch,
  releaseMatchRetryConfig,
  smokeFetchRetryConfig,
} from "./railway-smoke.mjs";

describe("railway smoke release validation", () => {
  it("prefers an explicit expected release SHA over the GitHub SHA", () => {
    expect(expectedHealthGitSha({
      CORGTEX_EXPECTED_RELEASE_GIT_SHA: " expected-sha ",
      GITHUB_SHA: "github-sha",
    })).toBe("expected-sha");
  });

  it("uses GITHUB_SHA when no explicit expected release SHA is set", () => {
    expect(expectedHealthGitSha({
      GITHUB_SHA: "github-sha",
    })).toBe("github-sha");
  });

  it("does not require release matching outside CI-like environments", () => {
    expect(expectedHealthGitSha({})).toBeNull();
    expect(healthReleaseMismatch({ release: { gitSha: "older-sha" } }, null)).toBeNull();
  });

  it("accepts matching health release SHAs", () => {
    expect(healthReleaseMismatch({
      release: {
        gitSha: "current-sha",
      },
    }, "current-sha")).toBeNull();
  });

  it("accepts matching health release image tags when runtime gitSha metadata lags", () => {
    expect(healthReleaseMismatch({
      release: {
        gitSha: "older-sha",
        imageTag: "current-sha",
      },
    }, "current-sha")).toBeNull();
  });

  it("reports mismatched or missing health release SHAs", () => {
    expect(healthReleaseMismatch({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("older-sha or release.imageTag missing did not match expected current-sha");
    expect(healthReleaseMismatch({}, "current-sha")).toContain("release.gitSha missing or release.imageTag missing did not match expected current-sha");
  });

  it("reports non-JSON health payloads as retryable mismatches", () => {
    expect(healthPayloadMismatch({ ok: true }, null, new Error("Unexpected token <"))).toContain("non-JSON payload");
  });

  it("reports health fetch failures as retryable mismatches", () => {
    expect(healthPayloadMismatch(null, null, null, new Error("connection reset"))).toContain("fetch failed");
  });

  it("uses safe release-match retry defaults and positive overrides", () => {
    expect(releaseMatchRetryConfig({})).toEqual({
      timeoutMs: 300_000,
      intervalMs: 10_000,
    });
    expect(releaseMatchRetryConfig({
      CORGTEX_RELEASE_MATCH_TIMEOUT_MS: "120000",
      CORGTEX_RELEASE_MATCH_INTERVAL_MS: "5000",
    })).toEqual({
      timeoutMs: 120_000,
      intervalMs: 5_000,
    });
    expect(releaseMatchRetryConfig({
      CORGTEX_RELEASE_MATCH_TIMEOUT_MS: "0",
      CORGTEX_RELEASE_MATCH_INTERVAL_MS: "not-a-number",
    })).toEqual({
      timeoutMs: 300_000,
      intervalMs: 10_000,
    });
  });

  it("uses safe smoke fetch retry defaults and positive overrides", () => {
    expect(smokeFetchRetryConfig({})).toEqual({
      attempts: 3,
      intervalMs: 2_000,
    });
    expect(smokeFetchRetryConfig({
      CORGTEX_SMOKE_FETCH_ATTEMPTS: "5",
      CORGTEX_SMOKE_FETCH_RETRY_INTERVAL_MS: "250",
    })).toEqual({
      attempts: 5,
      intervalMs: 250,
    });
    expect(smokeFetchRetryConfig({
      CORGTEX_SMOKE_FETCH_ATTEMPTS: "-1",
      CORGTEX_SMOKE_FETCH_RETRY_INTERVAL_MS: "nope",
    })).toEqual({
      attempts: 3,
      intervalMs: 2_000,
    });
  });
});
