import { describe, expect, it } from "vitest";
import { releaseVersionForGitSha, resolveReleaseMetadata } from "./release-metadata";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function testEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...overrides,
  };
}

describe("release metadata", () => {
  it("resolves development metadata when no release environment is configured", () => {
    expect(resolveReleaseMetadata(testEnv({}))).toMatchObject({
      version: "development",
      imageTag: null,
      gitSha: null,
      environment: "test",
      provider: "local",
      source: {
        version: "development",
        imageTag: "missing",
        gitSha: "missing",
        environment: "configured",
      },
      configured: {
        version: null,
        imageTag: null,
        gitSha: null,
      },
      drift: {
        version: false,
        imageTag: false,
        gitSha: false,
        details: [],
      },
    });
  });

  it("prefers runtime git SHA over stale configured release metadata and reports drift", () => {
    expect(resolveReleaseMetadata(testEnv({
      CORGTEX_RELEASE_GIT_SHA: OLD_SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD_SHA}`,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(OLD_SHA),
      RAILWAY_GIT_COMMIT_SHA: SHA,
      RAILWAY_SERVICE_ID: "railway-service",
      RAILWAY_SERVICE_NAME: "web",
    }))).toMatchObject({
      version: releaseVersionForGitSha(OLD_SHA),
      imageTag: `sha-${OLD_SHA}`,
      gitSha: SHA,
      provider: "railway",
      service: "web",
      source: {
        version: "configured",
        imageTag: "configured",
        gitSha: "railway",
        service: "railway",
      },
      runtime: {
        gitSha: SHA,
        source: "railway",
      },
      configured: {
        gitSha: OLD_SHA,
        imageTag: `sha-${OLD_SHA}`,
      },
      drift: {
        version: true,
        imageTag: true,
        gitSha: true,
      },
    });
  });

  it("accepts configured image tags that use either raw SHA or sha-prefixed SHA", () => {
    expect(resolveReleaseMetadata(testEnv({
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_RELEASE_IMAGE_TAG: SHA,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(SHA),
      RAILWAY_GIT_COMMIT_SHA: SHA,
    })).drift).toEqual({
      version: false,
      imageTag: false,
      gitSha: false,
      details: [],
    });

    expect(resolveReleaseMetadata(testEnv({
      CORGTEX_RELEASE_GIT_SHA: SHA,
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
      CORGTEX_RELEASE_VERSION: releaseVersionForGitSha(SHA),
      RAILWAY_GIT_COMMIT_SHA: SHA,
    })).drift).toEqual({
      version: false,
      imageTag: false,
      gitSha: false,
      details: [],
    });
  });

  it("derives git SHA from a configured image tag only when no runtime or configured SHA exists", () => {
    expect(resolveReleaseMetadata(testEnv({
      CORGTEX_RELEASE_IMAGE_TAG: `sha-${SHA}`,
    }))).toMatchObject({
      gitSha: SHA,
      source: {
        gitSha: "image_tag",
      },
      runtime: {
        gitSha: null,
        source: "missing",
      },
    });
  });
});
