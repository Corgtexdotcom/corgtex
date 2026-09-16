import { beforeEach, describe, expect, it, vi } from "vitest";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: read }));
import { readReleaseBuildIdentity } from "./release-build-node.mjs";
import { resolveNodeReleaseMetadata } from "./release-metadata-node";
import { resolveReleaseMetadata } from "./release-metadata";
import { buildErrorTelemetryEvent, telemetryRuntimeContext } from "./telemetry-node";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const identity = (role = "web") => ({ schemaVersion: 1, role, gitSha: SHA });
beforeEach(() => { read.mockReset(); });

describe("baked Node release identity", () => {
  it.each(["web", "worker"] as const)("reads strict %s identity, preferring it over provider/configuration and preserving drift", role => {
    read.mockReturnValue(JSON.stringify(identity(role)));
    const env = { NODE_ENV: "test" as const, CONTAINER_APP_NAME: "synthetic", GITHUB_SHA: OLD,
      CORGTEX_RELEASE_GIT_SHA: OLD, CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD}`, CORGTEX_RELEASE_VERSION: `main-${OLD.slice(0, 12)}` };
    const before = { ...env };
    expect(resolveNodeReleaseMetadata(role, env)).toMatchObject({
      gitSha: SHA, service: role, provider: "azure", source: { gitSha: "baked" },
      runtime: { gitSha: SHA, source: "baked", evidence: "baked" },
      configured: { gitSha: OLD }, drift: { gitSha: true, version: true, imageTag: true },
    });
    expect(env).toEqual(before);
    expect(read).toHaveBeenCalledWith("/app/release-build.json", "utf8");
  });

  it.each([null, [], {}, { ...identity(), schemaVersion: 2 }, { ...identity(), role: "worker" },
    { ...identity(), gitSha: "a".repeat(39) }, { ...identity(), gitSha: "A".repeat(40) },
    { ...identity(), gitSha: ` ${SHA}` }, { ...identity(), extra: true }])("rejects malformed/wrong-role identity %j", value => {
    read.mockReturnValue(JSON.stringify(value));
    expect(readReleaseBuildIdentity("web")).toBeNull();
    expect(resolveNodeReleaseMetadata("web", { NODE_ENV: "test", CORGTEX_RELEASE_GIT_SHA: OLD })).toMatchObject({
      gitSha: OLD, source: { gitSha: "configured" }, runtime: { gitSha: null, source: "missing", evidence: "unavailable" },
    });
  });

  it.each(["ENOENT", "EACCES", "EISDIR"])("does not crash on %s; provider fallback is explicitly legacy", code => {
    read.mockImplementation(() => { throw Object.assign(new Error("unreadable"), { code }); });
    expect(resolveNodeReleaseMetadata("web", { NODE_ENV: "test", RAILWAY_GIT_COMMIT_SHA: OLD })).toMatchObject({
      runtime: { gitSha: OLD, source: "railway", evidence: "legacy_provider" },
    });
  });

  it("rejects invalid JSON without manufacturing baked proof from env", () => {
    read.mockReturnValue("{");
    expect(resolveNodeReleaseMetadata("web", { NODE_ENV: "test", CORGTEX_RELEASE_GIT_SHA: SHA }).runtime.evidence).toBe("unavailable");
  });

  it("keeps pure resolver filesystem-free and validates explicitly supplied identity", () => {
    expect(resolveReleaseMetadata({ NODE_ENV: "test" }, { service: "web", bakedIdentity: identity() }).runtime.evidence).toBe("baked");
    expect(resolveReleaseMetadata({ NODE_ENV: "test" }, { service: "worker", bakedIdentity: identity() }).runtime.evidence).toBe("unavailable");
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the same baked identity in Node route and worker telemetry", () => {
    read.mockReturnValue(JSON.stringify(identity()));
    expect(telemetryRuntimeContext({ NODE_ENV: "test", CORGTEX_RELEASE_GIT_SHA: OLD })).toMatchObject({
      release_git_sha: SHA, release_git_sha_source: "baked", release_runtime_evidence: "baked", release_drift_git_sha: true,
    });
    read.mockReturnValue(JSON.stringify(identity("worker")));
    expect(buildErrorTelemetryEvent({ surface: "worker", error: new Error("synthetic") }, { NODE_ENV: "test", POSTHOG_INSTANCE_ID: "synthetic-tenant-worker" }).properties).toMatchObject({
      release_runtime_git_sha: SHA, release_runtime_evidence: "baked", instance_id: "synthetic-tenant-worker",
    });
  });

  it("keeps telemetry instance identity independent of the expected web build role", () => {
    read.mockReturnValue(JSON.stringify(identity("web")));
    const env = { NODE_ENV: "test" as const, POSTHOG_INSTANCE_ID: "unique-tenant-web", WORKSPACE_SLUG: "other-fallback" };
    expect(telemetryRuntimeContext(env)).toMatchObject({ instance_id: "unique-tenant-web", release_runtime_evidence: "baked" });
    expect(resolveNodeReleaseMetadata("web", env).service).toBe("web");
  });
});
