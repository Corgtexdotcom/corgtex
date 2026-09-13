import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  changedFilesForEvent,
  formatGithubOutput,
  productionAppReleaseRelevantPath,
  productionAppChangedFilesFromGit,
  requiresProductionAppRelease,
  resolveProductionValidationContext,
} from "./production-validation-context.mjs";

const MAIN_SHA = "70b27b03c37fc96c432d3f9d6d351622f3f42427";
const NEXT_SHA = "1111111111111111111111111111111111111111";
// Actual first-parent changes of merge f5246925 (PR #1096).
const SITE_RELEASE_FILES = [".github/workflows/ci.yml", "infra/azure/hosting/README.md",
  "scripts/azure-site-image-release.mjs", "scripts/azure-site-image-release.node-test.mjs"];
// Actual first-parent changes of merge 6e137c8c (PR #1093).
const HOSTING_FILES = [".github/workflows/hosting-images.yml", "deploy/Dockerfile.site", "infra/azure/hosting/README.md",
  "infra/azure/hosting/monitor.bicep", "infra/azure/hosting/monitor.parameters.example.json", "infra/azure/hosting/registry-pull.bicep",
  "infra/azure/hosting/site-identity.bicep", "infra/azure/hosting/site.bicep", "infra/azure/hosting/site.parameters.example.json",
  "scripts/migration/hosting-image-receipt.mjs", "scripts/migration/hosting-image-receipt.test.mjs",
  "scripts/migration/site-candidate-smoke.mjs", "scripts/migration/site-candidate-smoke.test.mjs"];
const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "production-release-boundary-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function gitFixture() {
  const cwd = await temporaryDirectory();
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Boundary Test", GIT_AUTHOR_EMAIL: "boundary@example.test",
      GIT_COMMITTER_NAME: "Boundary Test", GIT_COMMITTER_EMAIL: "boundary@example.test" } }).trim();
  git("init", "--quiet");
  let parent;
  return { cwd, git, write: async (path, text = "fixture\n") => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }, commit: () => {
    git("add", "--all");
    // Fixture objects only; no task branch or repository history is changed.
    parent = git("commit-tree", git("write-tree"), ...(parent ? ["-p", parent] : []), "-m", "fixture");
    return parent;
  } };
}

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
    recorderTempMeetingsInput: "",
    smokeInputs: {},
    changedFiles: ["scripts/recorder-readiness-production-smoke.mjs"],
    ...overrides,
  });
}

async function writeCiReleaseContext(context) {
  const dir = await temporaryDirectory();
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

  it.each([SITE_RELEASE_FILES, HOSTING_FILES].map((files) => [files]))("does not require an unrelated app release for the verified hosting change set", (changedFiles) => {
    expect(requiresProductionAppRelease(changedFiles)).toBe(false);
    expect(resolve({ changedFiles })).toMatchObject({ expected_git_sha: "", enabled: "true", crm_smoke: "true", client_readiness_smoke: "true" });
  });

  it.each(["apps/web/app/page.tsx", "apps/worker/src/main.ts", "packages/shared/src/env.ts", "packages/domain/src/main.ts",
    "deploy/Dockerfile.web", "deploy/Dockerfile.worker", "deploy/entrypoint.sh", "prisma/schema.prisma", "prisma/migrations/new/migration.sql",
    "scripts/start-web.mjs", "scripts/start-worker.mjs", "scripts/write-release-build.mjs", "scripts/railway-smoke.mjs",
    "scripts/release-fleet.mjs", "package.json", "package-lock.json", "infra/azure/selfserve/main.bicep",
    "infra/azure/hosting/new-runtime.bicep", "scripts/azure-site-image-release-helper.mjs", "scripts/new.test.mjs", "unknown.file",
    "docs/../apps/web/runtime.ts", "docs/a\nscripts/start-web.mjs", null])("retains exact release requirement for standalone or mixed runtime/unknown path %s", (path) => {
    expect(productionAppReleaseRelevantPath(path)).toBe(true);
    expect(requiresProductionAppRelease([...SITE_RELEASE_FILES, path])).toBe(true);
    expect(resolve({ changedFiles: [...HOSTING_FILES, path] }).expected_git_sha).toBe(MAIN_SHA);
  });

  it("dispositions this operational classifier and its tests without exempting arbitrary scripts", () => {
    const files = [".github/workflows/ci.yml", ".github/workflows/auto-revert.yml", "scripts/production-validation-context.mjs",
      "scripts/production-validation-context.test.mjs", "scripts/ci-production-boundary.test.mjs"];
    expect(requiresProductionAppRelease(files)).toBe(false);
    expect(requiresProductionAppRelease([...files, "scripts/start-web.mjs"])).toBe(true);
    expect(requiresProductionAppRelease(undefined)).toBe(true);
  });

  it("classifies the full Git range, including a runtime change before a site-only final commit", async () => {
    const fixture = await gitFixture();
    await fixture.write("README.md");
    const before = fixture.commit();
    await fixture.write("scripts/start-web.mjs");
    const middle = fixture.commit();
    await fixture.write("infra/azure/hosting/site.bicep");
    const after = fixture.commit();
    expect(requiresProductionAppRelease(productionAppChangedFilesFromGit({ ...fixture, before: middle, after }))).toBe(false);
    const changedFiles = productionAppChangedFilesFromGit({ ...fixture, before, after });
    expect(changedFiles).toEqual(["infra/azure/hosting/site.bicep", "scripts/start-web.mjs"]);
    expect(requiresProductionAppRelease(changedFiles)).toBe(true);
    const releaseContextPath = await writeCiReleaseContext({ source: "ci-push-range", before, after, changedFiles,
      skipReleaseMatch: true, requiresProductionAppRelease: false });
    const recovered = await changedFilesForEvent({ eventName: "workflow_run", event: workflowRunEvent({ head_sha: after }), releaseContextPath });
    expect(requiresProductionAppRelease(recovered)).toBe(true);
  });

  it.each([["apps/web/route.ts", "apps/site/route.ts"], ["scripts/start-web.mjs", "scripts/azure-site-image-release.mjs"],
    ["infra/azure/hosting/site.bicep", "infra/azure/shared-runtime.bicep"], ["docs/worker.md", "apps/worker/new.ts"]])(
    "retains both sides of boundary rename %s -> %s", async (source, destination) => {
      const fixture = await gitFixture();
      await fixture.write(source);
      const before = fixture.commit();
      await mkdir(dirname(join(fixture.cwd, destination)), { recursive: true });
      await rename(join(fixture.cwd, source), join(fixture.cwd, destination));
      const after = fixture.commit();
      const changedFiles = productionAppChangedFilesFromGit({ ...fixture, before, after });
      expect(changedFiles.sort()).toEqual([source, destination].sort());
      expect(requiresProductionAppRelease(changedFiles)).toBe(true);
    });

  it("keeps site-only renames exempt and preserves unusual filenames without line parsing", async () => {
    const fixture = await gitFixture();
    await fixture.write("apps/site/old.ts");
    const before = fixture.commit();
    await rename(join(fixture.cwd, "apps/site/old.ts"), join(fixture.cwd, "apps/site/new.ts"));
    const siteAfter = fixture.commit();
    expect(requiresProductionAppRelease(productionAppChangedFilesFromGit({ ...fixture, before, after: siteAfter }))).toBe(false);
    await fixture.write("scripts/runtime\nname.mjs");
    const after = fixture.commit();
    const paths = productionAppChangedFilesFromGit({ ...fixture, before: siteAfter, after });
    expect(paths).toEqual(["scripts/runtime\nname.mjs"]);
    expect(requiresProductionAppRelease(paths)).toBe(true);
  });

  it("fails closed on missing, zero, unavailable, reversed and identical Git ranges", async () => {
    const fixture = await gitFixture();
    await fixture.write("README.md");
    const before = fixture.commit();
    await fixture.write("docs/a.md");
    const after = fixture.commit();
    for (const range of [{ after }, { before: "0".repeat(40), after }, { before: MAIN_SHA, after }, { before: after, after: before },
      { before, after: before }, { before: "--help", after }]) {
      expect(productionAppChangedFilesFromGit({ ...fixture, ...range })).toEqual(["__unknown_production_app_release_required__"]);
    }
  });

  it("runs the same CLI for CI and recovery with fail-closed outputs and a reusable range artifact", async () => {
    const fixture = await gitFixture();
    await fixture.write("README.md");
    const before = fixture.commit();
    for (const file of SITE_RELEASE_FILES) await fixture.write(file);
    const after = fixture.commit();
    const output = join(fixture.cwd, "outputs.txt");
    const artifact = join(fixture.cwd, "release-context.json");
    const script = fileURLToPath(new URL("./production-validation-context.mjs", import.meta.url));
    const run = (env) => JSON.parse(execFileSync(process.execPath, [script, "--classify-app-release", `--output=${output}`],
      { cwd: fixture.cwd, encoding: "utf8", env: { ...process.env, PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: "",
        RELEASE_CONTEXT_PATH: "", RELEASE_CONTEXT_BEFORE: "", RELEASE_CONTEXT_AFTER: after, ...env } }));
    expect(run({ RELEASE_CONTEXT_BEFORE: before, RELEASE_CONTEXT_PATH: artifact }).requiresProductionAppRelease).toBe(false);
    expect(JSON.parse(await readFile(artifact, "utf8")).changedFiles).toEqual([...SITE_RELEASE_FILES].sort());
    expect(run({ PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: artifact }).requiresProductionAppRelease).toBe(false);
    expect(await readFile(output, "utf8")).toContain("skip_release_match=true\nrequires_app_release=false\n");
    expect(run({ PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: `${artifact}.missing` }).requiresProductionAppRelease).toBe(true);
    expect(run({ RELEASE_CONTEXT_BEFORE: "0".repeat(40) }).requiresProductionAppRelease).toBe(true);
    await writeFile(artifact, "invalid JSON");
    expect(run({ PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: artifact }).requiresProductionAppRelease).toBe(true);
    await writeFile(artifact, JSON.stringify({ source: "ci-push-range", before, after: MAIN_SHA, changedFiles: SITE_RELEASE_FILES,
      skipReleaseMatch: true, requiresProductionAppRelease: false }));
    expect(run({ PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH: artifact }).requiresProductionAppRelease).toBe(true);
    expect((await readFile(output, "utf8")).trim().endsWith("skip_release_match=false\nrequires_app_release=true")).toBe(true);
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
      recorder_readiness_deployments: "",
      recorder_readiness_temp_meetings: "false",
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
      recorderTempMeetingsInput: "true",
      clientReadinessRoutesInput: "leads,governance,finance-clients",
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
      client_readiness_routes: "leads,governance,finance-clients",
      source_intake_smoke: "true",
      work_item_parity_smoke: "false",
      briefing_fixture_smoke: "true",
      recorder_readiness_smoke: "false",
      recorder_readiness_deployments: "managed-recorder-validation,example",
      recorder_readiness_temp_meetings: "true",
    });
  });

  it("rejects unknown client-readiness route names", () => {
    expect(() => resolve({
      eventName: "workflow_dispatch",
      event: { inputs: {} },
      githubRef: "refs/heads/main",
      clientReadinessRoutesInput: "relationships,cycles",
      changedFiles: [],
    })).toThrow("client_readiness_routes contains unsupported route name(s): relationships, cycles");
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

  it.each([{ before: "" }, { before: "0".repeat(40) }, { after: "" }, { source: "unknown" },
    { changedFiles: undefined }, { changedFiles: [null] }])("does not trust a skip flag without known range/path evidence: %j", async (override) => {
    const releaseContextPath = await writeCiReleaseContext({ source: "ci-push-range", before: NEXT_SHA, after: MAIN_SHA,
      changedFiles: SITE_RELEASE_FILES, requiresProductionAppRelease: false, skipReleaseMatch: true, ...override });
    expect(await changedFilesForEvent({ eventName: "workflow_run", event: workflowRunEvent(), releaseContextPath }))
      .toEqual(["__unknown_production_app_release_required__"]);
  });
});
