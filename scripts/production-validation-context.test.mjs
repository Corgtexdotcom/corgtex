import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  changedFilesForEvent,
  formatGithubOutput,
  productionAppReleaseRelevantPath,
  requiresProductionAppRelease,
  resolveProductionValidationContext,
} from "./production-validation-context.mjs";

const MAIN_SHA = "70b27b03c37fc96c432d3f9d6d351622f3f42427";
const NEXT_SHA = "1111111111111111111111111111111111111111";

function workflowRunEvent(overrides = {}) {
  return {
    workflow_run: {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: MAIN_SHA,
      head_repository: { full_name: "Corgtexdotcom/corgtex" },
      head_commit: { message: "Merge pull request #725 from Corgtexdotcom/codex/recorder-readiness-validation" },
      pull_requests: [{ number: 725 }],
      ...overrides,
    },
  };
}

function resolve(overrides = {}) {
  return resolveProductionValidationContext({
    eventName: "workflow_run",
    event: workflowRunEvent(),
    githubRef: "refs/heads/main",
    githubSha: NEXT_SHA,
    githubRepository: "Corgtexdotcom/corgtex",
    baseUrlInput: "https://app.corgtex.com",
    expectedGitShaInput: "",
    prNumbersInput: "",
    baselinePrNumbers: "",
    recorderDeploymentsInput: "",
    smokeInputs: {},
    changedFiles: ["scripts/recorder-readiness-production-smoke.mjs"],
    ...overrides,
  });
}

async function writeCiReleaseContext(context) {
  const dir = await mkdtemp(join(tmpdir(), "production-validation-context-"));
  const path = join(dir, "release-context.json");
  await writeFile(path, `${JSON.stringify(context, null, 2)}\n`);
  return path;
}

describe("production validation context", () => {
  it("classifies production app release relevance by path", () => {
    expect(productionAppReleaseRelevantPath("scripts/foo.mjs")).toBe(true);
    expect(productionAppReleaseRelevantPath("packages/domain/src/foo.ts")).toBe(true);
    expect(productionAppReleaseRelevantPath(".github/workflows/production-validation.yml")).toBe(false);
    expect(productionAppReleaseRelevantPath("docs/releases.mdx")).toBe(false);
    expect(productionAppReleaseRelevantPath("apps/site/app/page.tsx")).toBe(false);
    expect(requiresProductionAppRelease(["docs/a.mdx", ".github/workflows/ci.yml"])).toBe(false);
    expect(requiresProductionAppRelease(["docs/a.mdx", "scripts/smoke.mjs"])).toBe(true);
  });

  it("enables the full matrix after a trusted main CI workflow run", () => {
    expect(resolve()).toMatchObject({
      enabled: "true",
      trusted_ref: "true",
      base_url: "https://app.corgtex.com",
      expected_git_sha: MAIN_SHA,
      pr_numbers: "725",
      crm_smoke: "true",
      telemetry_release_smoke: "true",
      client_readiness_smoke: "true",
      client_readiness_routes: "leads",
      source_intake_smoke: "true",
      work_item_parity_smoke: "true",
      briefing_fixture_smoke: "true",
      recorder_readiness_smoke: "true",
      recorder_readiness_deployments: "managed-recorder-validation",
    });
  });

  it("does not require a production release for docs-only workflow runs", () => {
    expect(resolve({ changedFiles: ["docs/a.mdx", ".github/workflows/ci.yml"] })).toMatchObject({
      enabled: "true",
      expected_git_sha: "",
      pr_numbers: "725",
    });
  });

  it("skips untrusted or failed workflow runs without producing write jobs", () => {
    expect(resolve({
      event: workflowRunEvent({ conclusion: "failure" }),
    })).toMatchObject({
      enabled: "false",
      crm_smoke: "false",
      telemetry_release_smoke: "false",
      client_readiness_smoke: "false",
      source_intake_smoke: "false",
      work_item_parity_smoke: "false",
      briefing_fixture_smoke: "false",
      recorder_readiness_smoke: "false",
    });
  });

  it("honors workflow dispatch smoke toggles and explicit inputs", () => {
    expect(resolve({
      eventName: "workflow_dispatch",
      event: { inputs: {} },
      githubRef: "refs/heads/main",
      githubSha: MAIN_SHA,
      expectedGitShaInput: NEXT_SHA,
      prNumbersInput: "725,726",
      baselinePrNumbers: "724",
      recorderDeploymentsInput: "managed-recorder-validation,example",
      clientReadinessRoutesInput: "leads,relationships",
      smokeInputs: {
        crm: "false",
        telemetryRelease: "false",
        clientReadiness: "true",
        sourceIntake: "true",
        workItemParity: "false",
        briefingFixture: "true",
        recorderReadiness: "false",
      },
      changedFiles: [],
    })).toMatchObject({
      enabled: "true",
      expected_git_sha: NEXT_SHA,
      pr_numbers: "724,725,726",
      crm_smoke: "false",
      telemetry_release_smoke: "false",
      client_readiness_smoke: "true",
      client_readiness_routes: "leads,relationships",
      source_intake_smoke: "true",
      work_item_parity_smoke: "false",
      briefing_fixture_smoke: "true",
      recorder_readiness_smoke: "false",
      recorder_readiness_deployments: "managed-recorder-validation,example",
    });
  });

  it("keeps scheduled runs release-agnostic unless an explicit SHA is supplied", () => {
    expect(resolve({
      eventName: "schedule",
      event: {},
      githubRef: "refs/heads/main",
      expectedGitShaInput: "",
      baselinePrNumbers: "725",
      changedFiles: ["scripts/smoke.mjs"],
    })).toMatchObject({
      enabled: "true",
      expected_git_sha: "",
      pr_numbers: "725",
    });
  });

  it("rejects multiline values before writing GitHub step outputs", () => {
    expect(() => formatGithubOutput({
      enabled: "true",
      trusted_ref: "false",
      recorder_readiness_deployments: "managed\ntrusted_ref=true",
    })).toThrow("recorder_readiness_deployments must be a single-line value");
  });

  it("uses the CI push-range release context for workflow-run relevance", async () => {
    const releaseContextPath = await writeCiReleaseContext({
      source: "ci-push-range",
      before: NEXT_SHA,
      after: MAIN_SHA,
      changedFiles: ["docs/a.mdx", ".github/workflows/ci.yml"],
      skipReleaseMatch: true,
      requiresProductionAppRelease: false,
    });

    const changedFiles = await changedFilesForEvent({
      eventName: "workflow_run",
      event: workflowRunEvent(),
      releaseContextPath,
    });

    expect(changedFiles).toEqual(["docs/a.mdx", ".github/workflows/ci.yml"]);
    expect(requiresProductionAppRelease(changedFiles)).toBe(false);
  });

  it("rejects stale CI release context artifacts", async () => {
    const releaseContextPath = await writeCiReleaseContext({
      source: "ci-push-range",
      before: MAIN_SHA,
      after: NEXT_SHA,
      changedFiles: ["docs/a.mdx"],
      skipReleaseMatch: true,
      requiresProductionAppRelease: false,
    });

    await expect(changedFilesForEvent({
      eventName: "workflow_run",
      event: workflowRunEvent(),
      releaseContextPath,
    })).rejects.toThrow("CI release context SHA does not match workflow_run.head_sha");
  });

  it("requires release proof when CI context has no changed-file details but says a release is required", async () => {
    const releaseContextPath = await writeCiReleaseContext({
      source: "ci-push-range",
      before: NEXT_SHA,
      after: MAIN_SHA,
      changedFiles: [],
      skipReleaseMatch: false,
      requiresProductionAppRelease: true,
    });

    const changedFiles = await changedFilesForEvent({
      eventName: "workflow_run",
      event: workflowRunEvent(),
      releaseContextPath,
    });

    expect(changedFiles).toEqual(["__unknown_production_app_release_required__"]);
    expect(requiresProductionAppRelease(changedFiles)).toBe(true);
  });

  it("fails closed when workflow-run CI release context is unavailable", async () => {
    const changedFiles = await changedFilesForEvent({
      eventName: "workflow_run",
      event: workflowRunEvent(),
      releaseContextPath: "",
    });

    expect(changedFiles).toEqual(["__unknown_production_app_release_required__"]);
    expect(requiresProductionAppRelease(changedFiles)).toBe(true);
  });
});
