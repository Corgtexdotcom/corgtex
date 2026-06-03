import { describe, expect, it } from "vitest";

import {
  expectedHealthGitSha,
  healthPayloadMismatch,
  healthReleaseMismatch,
  releaseMatchRetryConfig,
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

  it("reports mismatched or missing health release SHAs", () => {
    expect(healthReleaseMismatch({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("older-sha did not match expected current-sha");
    expect(healthReleaseMismatch({}, "current-sha")).toContain("missing did not match expected current-sha");
  });

  it("reports non-JSON health payloads as retryable mismatches", () => {
    expect(healthPayloadMismatch({ ok: true }, null, new Error("Unexpected token <"))).toContain("non-JSON payload");
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
});
