import { describe, expect, it } from "vitest";
import {
  formatReleaseNormalizationLog,
  normalizeRuntimeReleaseEnv,
  releaseVersionForGitSha,
  runtimeReleaseGitSha,
} from "./release-env.mjs";

const SHA = "5f97406961ceefaafff59c79be8fa8d9cc46ac1a";
const OLD_SHA = "ea3fc329fe1df04d739a0abf7cb37d9c21282697";

describe("runtime release environment normalization", () => {
  it("uses Railway git metadata as the startup release source", () => {
    expect(runtimeReleaseGitSha({
      CORGTEX_RELEASE_GIT_SHA: OLD_SHA,
      GITHUB_SHA: "github-sha",
      RAILWAY_GIT_COMMIT_SHA: SHA,
    })).toEqual({ gitSha: SHA, source: "railway" });
  });

  it("overwrites stale configured release variables from the runtime git SHA", () => {
    const env = {
      RAILWAY_GIT_COMMIT_SHA: SHA,
      CORGTEX_RELEASE_GIT_SHA: OLD_SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD_SHA}`,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(OLD_SHA),
    };

    const result = normalizeRuntimeReleaseEnv(env);

    expect(result).toMatchObject({
      normalized: true,
      source: "railway",
      gitSha: SHA,
      imageTag: `sha-${SHA}`,
      version: "main-5f97406961ce",
    });
    expect(result.changed).toEqual([
      "CORGTEX_RELEASE_GIT_SHA",
      "CORGTEX_RELEASE_IMAGE_TAG",
      "CORGTEX_RELEASE_VERSION",
    ]);
    expect(env.CORGTEX_RELEASE_GIT_SHA).toBe(SHA);
    expect(env.CORGTEX_RELEASE_IMAGE_TAG).toBe(`sha-${SHA}`);
    expect(env.CORGTEX_RELEASE_VERSION).toBe("main-5f97406961ce");
  });

  it("preserves intentional semantic release versions while aligning SHA fields", () => {
    const env = {
      RAILWAY_GIT_COMMIT_SHA: SHA,
      CORGTEX_RELEASE_GIT_SHA: OLD_SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD_SHA}`,
      CORGTEX_RELEASE_VERSION: "0.1.0",
    };

    const result = normalizeRuntimeReleaseEnv(env);

    expect(result.version).toBe("0.1.0");
    expect(result.changed).toEqual([
      "CORGTEX_RELEASE_GIT_SHA",
      "CORGTEX_RELEASE_IMAGE_TAG",
    ]);
    expect(env.CORGTEX_RELEASE_VERSION).toBe("0.1.0");
  });

  it("reports aligned metadata without rewriting unchanged values", () => {
    const env = {
      RAILWAY_GIT_COMMIT_SHA: SHA,
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(SHA),
    };

    const result = normalizeRuntimeReleaseEnv(env);

    expect(result.changed).toEqual([]);
    expect(formatReleaseNormalizationLog(result)).toContain("already aligned");
  });

  it("leaves configured metadata alone when no runtime git SHA is available", () => {
    const env = {
      CORGTEX_RELEASE_GIT_SHA: OLD_SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD_SHA}`,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(OLD_SHA),
    };

    expect(normalizeRuntimeReleaseEnv(env)).toEqual({
      normalized: false,
      source: "missing",
      gitSha: null,
      version: null,
      imageTag: null,
      changed: [],
    });
    expect(env.CORGTEX_RELEASE_GIT_SHA).toBe(OLD_SHA);
  });
});
