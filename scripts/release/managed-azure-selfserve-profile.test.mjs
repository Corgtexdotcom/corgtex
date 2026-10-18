import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSelfserveReleaseHost, SELFSERVE_RELEASE_HOST_ID, SELFSERVE_RELEASE_ORIGIN, SELFSERVE_RELEASE_PROFILE } from "./managed-azure-selfserve-profile.mjs";

describe("selfserve release entry points", () => {
  it("pins the same host capability in server and runner without treating unrelated remote hosts as selfserve", () => {
    const source = readFileSync(new URL("../../packages/domain/src/managed-azure-targets.ts", import.meta.url), "utf8");
    for (const value of [SELFSERVE_RELEASE_HOST_ID, SELFSERVE_RELEASE_ORIGIN, SELFSERVE_RELEASE_PROFILE]) expect(source).toContain(`"${value}"`);
    expect(isSelfserveReleaseHost(SELFSERVE_RELEASE_HOST_ID, "https://changed.example.test")).toBe(true);
    expect(isSelfserveReleaseHost("other", `${SELFSERVE_RELEASE_ORIGIN}/`)).toBe(true);
    expect(isSelfserveReleaseHost("other", "https://ordinary.example.test")).toBe(false);
  });
  it.each([{ extra: [] }, { extra: ["--app-url", "https://renamed.example.test"] }, { extra: ["--app-url", "https://renamed.example.test", "--skip-build", "--skip-health-smoke", "--web-app-name", "CA-CORGTEX-SS-PROD-WEB", "--worker-app-name", "CA-CORGTEX-SS-PROD-WORKER"] }])("rejects standalone live promotion before commands even with an overridden origin (%j)", ({ extra }) => {
    const result = spawnSync(process.execPath, ["scripts/azure-selfserve-production-release.mjs", "--sha", "a".repeat(40), ...extra], { encoding: "utf8", env: { PATH: "/nonexistent-qa-no-provider" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("protected managed Azure EXCLUSIVE workflow");
    expect(result.stdout).toBe("");
  });
  it("keeps standalone dry run inert", () => {
    const output = execFileSync(process.execPath, ["scripts/azure-selfserve-production-release.mjs", "--sha", "a".repeat(40), "--dry-run", "--skip-build"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(output).toContain('"dryRun": true');
  });
});
