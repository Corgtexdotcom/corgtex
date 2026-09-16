import { beforeEach, expect, it, vi } from "vitest";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFileSync: (path, ...args) => path === "/app/release-build.json" ? read(path, ...args) : actual.readFileSync(path, ...args) };
});
import { formatRuntimeReleaseLog, normalizeRuntimeReleaseEnv } from "./release-env.mjs";
import { resolveReleaseMetadata } from "../../packages/shared/src/release-metadata.ts";
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
beforeEach(() => { read.mockReset(); });
it.each(["web", "worker"])("reports baked %s identity without overwriting configuration/drift", role => {
  read.mockReturnValue(JSON.stringify({ schemaVersion: 1, role, gitSha: SHA }));
  const env = { GITHUB_SHA: OLD, CORGTEX_RELEASE_GIT_SHA: OLD, CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD}`, CORGTEX_RELEASE_VERSION: `main-${OLD.slice(0, 12)}` };
  const before = { ...env };
  const result = JSON.parse(formatRuntimeReleaseLog(role, env).slice("[release-env] ".length));
  expect(result).toMatchObject({ runtime: { gitSha: SHA, source: "baked", evidence: "baked" }, configured: { gitSha: OLD }, drift: { gitSha: true, version: true, imageTag: true } });
  expect(env).toEqual(before);
});
it("labels absent/unreadable file fallback as legacy provider, never baked", () => {
  read.mockImplementation(() => { throw new Error("missing"); });
  expect(formatRuntimeReleaseLog("web", { GITHUB_SHA: SHA })).toContain('"evidence":"legacy_provider"');
  expect(formatRuntimeReleaseLog("web", {})).toContain('"evidence":"unavailable"');
});

it.each(["main-old", "1.2.3"])("preserves effective legacy provider labels for version %s without erasing drift", version => {
  read.mockReturnValue("null");
  const env = { RAILWAY_GIT_COMMIT_SHA: SHA, VERCEL_GIT_COMMIT_SHA: OLD, GITHUB_SHA: OLD,
    CORGTEX_RELEASE_GIT_SHA: OLD, CORGTEX_RELEASE_IMAGE_TAG: `sha-${OLD}`, CORGTEX_RELEASE_VERSION: version };
  const legacy = { ...env };
  normalizeRuntimeReleaseEnv(legacy);
  const expected = resolveReleaseMetadata(legacy);
  const before = { ...env };
  const startup = JSON.parse(formatRuntimeReleaseLog("web", env).slice("[release-env] ".length));
  const current = resolveReleaseMetadata(env);
  expect({ gitSha: current.gitSha, version: current.version, imageTag: current.imageTag })
    .toEqual({ gitSha: expected.gitSha, version: expected.version, imageTag: expected.imageTag });
  expect(startup.runtime).toEqual({ gitSha: SHA, source: "railway", evidence: "legacy_provider" });
  expect(startup.drift.gitSha).toBe(true);
  expect(current.drift.gitSha).toBe(true);
  expect(env).toEqual(before);
});
