import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { candidateBuildContext, candidateImageReceipt, selectCandidateBuild, verifyCandidateBuild } from "./hotfix-candidate-build.mjs";
import { createHash } from "node:crypto";
import { validateHotfixTarget, canonicalHotfixDiff, hotfixChangedFiles } from "./selfserve-hotfix-source.mjs";

const toolingSha = "a".repeat(40), candidateSha = "b".repeat(40), recoverySha = "c".repeat(40);
const env = { CANDIDATE_ADMISSION: "selfserve-switcher", CANDIDATE_SOURCE_ROLE: "candidate", RELEASE_IMAGE_MODE: "build",
  GITHUB_REPOSITORY: "Corgtexdotcom/corgtex", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/release-images.yml@refs/heads/main",
  GITHUB_SHA: toolingSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", PINNED_SOURCE_SHA: candidateSha };
const source = { schemaVersion: 1, repository: "Corgtexdotcom/corgtex", toolingSha, sourceSha: candidateSha,
  sourceTree: "d".repeat(40), prismaTree: "e".repeat(40), schemaSha256: "f".repeat(64), admission: "hotfix",
  admissionId: "selfserve-switcher", provider: "azure", targetId: "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16",
  origin: "https://selfserve.corgtex.com", recoverySha, manifestSha256: "1".repeat(64) };
source.targetDigest = validateHotfixTarget(source, source).targetDigest;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const workflow = parse(await readFile(new URL("../../.github/workflows/release-images.yml", import.meta.url), "utf8"));

test("only closed dispatch/main/canonical workflow context selects candidate publishing", () => {
  assert.deepEqual(candidateBuildContext(env), { candidateMode: true, admissionId: "selfserve-switcher", sourceRole: "candidate" });
  for (const override of [{ GITHUB_REPOSITORY: "fork/corgtex" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/branch" }, { GITHUB_REF: "refs/tags/main" },
    { GITHUB_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/other.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/release-images.yml@refs/heads/branch" },
    { RELEASE_IMAGE_MODE: "proof" }, { CANDIDATE_SOURCE_ROLE: "any-sha" }, { CANDIDATE_ADMISSION: "any-branch" }]) {
    assert.throws(() => candidateBuildContext({ ...env, ...override }), /HOTFIX_/);
  }
});
test("ordinary source selection remains the exact event SHA without requiring main or admission", () => {
  for (const override of [{ GITHUB_REF: "refs/tags/v1", GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/ordinary" }]) {
    assert.deepEqual(candidateBuildContext({ ...env, ...override, CANDIDATE_ADMISSION: "" }), {
      candidateMode: false, sourceSha: toolingSha, candidateSha: "", sourceRole: "", admissionId: "",
    });
  }
});
test("fixed trusted manifest selects only candidate or recovery; absent Ops record fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-build-select-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".github"));
  await writeFile(join(root, ".github/selfserve-switcher-hotfix.json"), JSON.stringify({ ...source, candidateSha, recoverySha }));
  assert.equal((await selectCandidateBuild({ env, toolingRoot: root })).sourceSha, candidateSha);
  assert.equal((await selectCandidateBuild({ env: { ...env, CANDIDATE_SOURCE_ROLE: "recovery" }, toolingRoot: root })).sourceSha, recoverySha);
  await assert.rejects(selectCandidateBuild({ env: { ...env, CANDIDATE_ADMISSION: "ops-release-authority" }, toolingRoot: root }), { code: "ENOENT" });
});
test("candidate build receipt separates producing tooling SHA from admitted source and binds exact digests", () => {
  const receipt = candidateImageReceipt({ env, source, webDigest: digest("2"), workerDigest: digest("3") });
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.mode, "candidate-build");
  assert.equal(receipt.sourceSha, candidateSha);
  assert.equal(receipt.toolingSha, toolingSha);
  assert.equal(receipt.sourceRole, "candidate");
  assert.deepEqual(receipt.source, source);
  assert.equal(receipt.runId, 123);
  assert.equal(receipt.runAttempt, 1);
  assert.equal(receipt.images.web.digest, digest("2"));
  const recovery = candidateImageReceipt({ env: { ...env, CANDIDATE_SOURCE_ROLE: "recovery", PINNED_SOURCE_SHA: recoverySha },
    source, webDigest: digest("2"), workerDigest: digest("3") });
  assert.equal(recovery.sourceSha, recoverySha);
  assert.equal(recovery.source.sourceSha, candidateSha);
  assert.equal(recovery.sourceRole, "recovery");
  for (const input of [
    { env: { ...env, PINNED_SOURCE_SHA: toolingSha }, source },
    { env, source: { ...source, toolingSha: candidateSha } },
    { env, source: { ...source, admissionId: "ops-release-authority" } },
    { env: { ...env, GITHUB_RUN_ATTEMPT: "0" }, source },
  ]) assert.throws(() => candidateImageReceipt({ ...input, webDigest: digest("2"), workerDigest: digest("3") }), /HOTFIX_/);
  assert.throws(() => candidateImageReceipt({ env, source, webDigest: "latest", workerDigest: digest("3") }), /HOTFIX_BUILD_IMAGES_INVALID/);
});
test("every publisher is gated by secret-free admission and rechecks selected checkout before credentials", () => {
  const admission = workflow.jobs.admission, publish = workflow.jobs.publish;
  assert.equal(admission.if, "inputs.mode != 'proof'");
  assert.deepEqual(admission.permissions, { contents: "read" });
  assert.equal(admission.environment, undefined);
  assert(!JSON.stringify(admission).includes("secrets."));
  assert(!JSON.stringify(admission).includes("packages: write"));
  assert.equal(publish.needs, "admission");
  assert.equal(publish.environment, "fleet-release-production");
  const verifyIndex = publish.steps.findIndex((step) => step.run === "node scripts/release/hotfix-candidate-build.mjs verify");
  const loginIndex = publish.steps.findIndex((step) => step.uses === "docker/login-action@v3");
  const buildIndex = publish.steps.findIndex((step) => step.uses === "docker/build-push-action@v6");
  assert(verifyIndex >= 0 && verifyIndex < loginIndex && loginIndex < buildIndex);
  const checkout = publish.steps.find((step) => step.with?.path === ".candidate-source");
  assert.equal(checkout.with.ref, "${{ needs.admission.outputs.source_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  for (const step of publish.steps.filter((step) => step.uses === "docker/build-push-action@v6")) {
    assert(step.with.context.includes("'.candidate-source'"));
    assert(step.with["build-args"].includes("CORGTEX_RELEASE_GIT_SHA=${{ needs.admission.outputs.source_sha }}"));
    assert(!step.with["build-args"].includes("${{ github.sha }}"));
  }
});
test("candidate tag computation emits only exact SHA tags; ordinary branch tags preserved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-build-tags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const step = workflow.jobs.publish.steps.find((step) => step.id === "image");
  for (const mode of ["true", "false"]) {
    const output = join(root, mode);
    const result = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", env: {
      PATH: process.env.PATH, CANDIDATE_MODE: mode, PINNED_SOURCE_SHA: candidateSha,
      GITHUB_REPOSITORY: "Corgtexdotcom/corgtex", GITHUB_REF_NAME: "main", GITHUB_OUTPUT: output,
    } });
    assert.equal(result.status, 0, result.stderr);
    const values = await readFile(output, "utf8");
    assert(values.includes(`/web:sha-${candidateSha}`) && values.includes(`/worker:sha-${candidateSha}`));
    assert.equal(values.includes("/web:main"), mode === "false");
    assert.equal(values.includes("web_version="), mode === "false");
  }
});
test("proof remains separate and preserves schema ancestry while using closed selected lane", () => {
  const proof = workflow.jobs["startup-proof"];
  assert.equal(proof.if, "github.event_name == 'workflow_dispatch' && inputs.mode == 'proof'");
  assert.equal(proof.needs, undefined);
  assert(proof.steps.some((step) => step.run?.includes('git -C .candidate-schema merge-base --is-ancestor HEAD origin/main')));
  assert.equal(proof.env.HOTFIX_ADMISSION_ID, "${{ inputs.candidate_admission || 'selfserve-switcher' }}");
  assert(proof.steps.some((step) => step.id === "hotfix" && step.run.includes("hotfixAdmissionProfile(process.env.HOTFIX_ADMISSION_ID)")));
  assert(!JSON.stringify(proof).includes("build-push-action"));
});

test("Git-backed publisher rechecks candidate and recovery checkouts and rejects changed predecessor receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-build-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate"), toolingRoot = join(root, "tooling"), build = join(root, "build");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Synthetic",
      GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" } }).trim();
  await mkdir(candidate); git(candidate, "init", "-b", "main");
  await mkdir(join(candidate, "prisma"));
  await writeFile(join(candidate, "prisma/schema.prisma"), "synthetic schema");
  await writeFile(join(candidate, "app.ts"), "base");
  git(candidate, "add", "."); git(candidate, "commit", "-m", "base");
  const baseSha = git(candidate, "rev-parse", "HEAD");
  git(candidate, "switch", "-c", "candidate");
  await writeFile(join(candidate, "app.ts"), "switcher");
  git(candidate, "commit", "-am", "candidate");
  const selectedSha = git(candidate, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", candidate, toolingRoot);
  git(toolingRoot, "checkout", "--detach", baseSha);
  git(toolingRoot, "update-ref", "refs/remotes/origin/main", baseSha);
  git(root, "clone", "--quiet", candidate, build);
  const manifest = { schemaVersion: 1, repository: source.repository, targetId: source.targetId, origin: source.origin,
    baseSha, candidateSha: selectedSha, candidateTree: git(candidate, "rev-parse", "HEAD^{tree}"),
    diffSha256: createHash("sha256").update(canonicalHotfixDiff(candidate, baseSha, selectedSha)).digest("hex"),
    prismaTree: git(candidate, "rev-parse", "HEAD:prisma"), recoverySha: baseSha,
    changedFiles: hotfixChangedFiles(candidate, baseSha, selectedSha) };
  await mkdir(join(toolingRoot, ".github"));
  await writeFile(join(toolingRoot, ".github/selfserve-switcher-hotfix.json"), JSON.stringify(manifest));
  const local = { ...env, GITHUB_SHA: baseSha, PINNED_SOURCE_SHA: selectedSha, PINNED_CANDIDATE_SHA: selectedSha,
    CANDIDATE_SOURCE_ROOT: candidate, BUILD_SOURCE_ROOT: build };
  const verified = await verifyCandidateBuild({ env: local, toolingRoot });
  assert.equal(verified.sourceSha, selectedSha);
  await assert.rejects(verifyCandidateBuild({ env: { ...local, ADMISSION_RECEIPT: JSON.stringify({ ...verified, sourceTree: toolingSha }) }, toolingRoot }), /HOTFIX_BUILD_ADMISSION_CHANGED/);
  git(build, "checkout", "--detach", baseSha);
  const recovery = await verifyCandidateBuild({ env: { ...local, CANDIDATE_SOURCE_ROLE: "recovery", PINNED_SOURCE_SHA: baseSha,
    ADMISSION_RECEIPT: JSON.stringify(verified) }, toolingRoot });
  assert.deepEqual(recovery, verified);
  await writeFile(join(build, "app.ts"), "unreviewed");
  await assert.rejects(verifyCandidateBuild({ env: { ...local, CANDIDATE_SOURCE_ROLE: "recovery", PINNED_SOURCE_SHA: baseSha }, toolingRoot }), /HOTFIX_CHECKOUT_DIRTY/);
});
