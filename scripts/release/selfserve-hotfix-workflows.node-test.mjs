import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const workflow = (name) => YAML.parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const runs = (job) => job.steps.map((step) => step.run || "").join("\n");
test("required CI includes exact candidate checks with no production environment or secrets", () => {
  const ci = workflow("ci"), candidate = workflow("selfserve-hotfix-check");
  assert.ok(ci.jobs.check.needs.includes("hotfix-candidate"));
  assert.match(runs(ci.jobs["check-native"]), /node --test scripts\/release\/\*hotfix\*\.node-test\.mjs/);
  assert.match(runs(ci.jobs.check), /test "\$HOTFIX_RESULT" = success/);
  assert.equal(candidate.jobs.candidate.environment, undefined);
  assert.deepEqual(candidate.permissions, { contents: "read" });
  const text = JSON.stringify(candidate);
  assert.doesNotMatch(text, /secrets\.|id-token|packages.*write/);
  const admissions = candidate.jobs.admissions;
  const selector = admissions.steps.find((step) => step.id === "scope");
  assert.match(selector.run, /GITHUB_EVENT_NAME.*!= pull_request/);
  assert.match(selector.run, /git diff --quiet HEAD\^1 HEAD -- \.github scripts package\.json package-lock\.json \.npmrc/);
  assert.equal(candidate.jobs.candidate.if, "needs.admissions.outputs.run_matrix == 'true'");
  const steps = candidate.jobs.candidate.steps;
  assert.ok(steps.findIndex((s) => s.run?.includes("hotfix-candidate-ci.mjs verify")) < steps.findIndex((s) => s.run === "npm ci"));
  assert.ok(steps.some((s) => s.run?.includes("WorkspaceSwitcher.browser.test.ts")));
  assert.equal(candidate.jobs.candidate["runs-on"], "ubuntu-24.04");
  const database = steps.find((s) => s.uses?.includes("ci-pgvector")).with.database;
  assert.equal(database, "corgtex_test");
  assert.equal(new URL(candidate.jobs.candidate.env.DATABASE_URL).pathname, `/${database}`);
});
test("scope uses the tested merge parent when the event base is stale", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hotfix-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-m", "base");
  git("switch", "-c", "topic");
  writeFileSync(join(root, "feature.ts"), "export {};\n");
  git("add", "feature.ts");
  git("commit", "-m", "ordinary source change");
  git("switch", "main");
  git("commit", "--allow-empty", "-m", "main advanced");
  const output = join(root, "scope-output");
  const { run } = workflow("selfserve-hotfix-check").jobs.admissions.steps.find((step) => step.id === "scope");
  const scope = () => {
    const result = spawnSync("bash", ["-c", run], { cwd: root, encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "pull_request", BASE_SHA: "f".repeat(40) } });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(output, "utf8").trim().split("\n").at(-1);
  };
  assert.equal(scope(), "run_matrix=true");
  git("merge", "--no-ff", "topic", "-m", "synthetic merge");
  assert.equal(scope(), "run_matrix=false");
});

test("startup proof preserves schema ancestry and binds the exact candidate exception", () => {
  const job = workflow("release-images").jobs["startup-proof"];
  assert.match(runs(job), /git -C .candidate-schema merge-base --is-ancestor HEAD origin\/main/);
  assert.ok(job.steps.some((s) => s.if === "inputs.hotfix_evidence == ''" && s.run?.includes('"$IMAGE_PROOF_SOURCE_SHA" origin/main')));
  const guard = job.steps.findIndex((s) => s.run?.includes("selfserve-hotfix-gate.mjs proof"));
  const prepare = job.steps.findIndex((s) => s.run?.includes("image-startup-proof.mjs --prepare"));
  assert.ok(guard >= 0 && guard < prepare);
  assert.match(runs(job), /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.equal(job.environment, "fleet-release-production");
});
test("validation binds admitted image before isolation and keeps existing named-owner gates", () => {
  const jobs = workflow("production-validation").jobs;
  const steps = jobs["selfserve-isolated"].steps;
  assert.ok(steps.findIndex((s) => s.run?.includes("selfserve-hotfix-gate.mjs validation"))
    < steps.findIndex((s) => s.run?.includes("selfserve-validation-isolated.mjs --prepare")));
  assert.ok(jobs["selfserve-live"].needs.includes("selfserve-isolated"));
  assert.equal(jobs["selfserve-live"].environment, "fleet-release-production");
  assert.match(runs(jobs["selfserve-live"]), /selfserve-validation-smoke.mjs/);
  assert.match(runs(jobs["selfserve-live"]), /selfserve-validation-schema.mjs/);
});
test("both managed modes enforce provenance before any Azure login or transaction", () => {
  for (const [name, job] of Object.entries(workflow("managed-azure-release").jobs)) {
    assert.match(job.if, /github.ref == 'refs\/heads\/main'/, name);
    assert.equal(job.environment, "managed-azure-release-production");
    const gate = job.steps.findIndex((s) => s.run?.includes("selfserve-hotfix-gate.mjs release"));
    const azure = job.steps.findIndex((s) => s.uses?.startsWith("azure/login@"));
    const transaction = job.steps.findIndex((s) => s.run?.includes("managed-azure-release-transaction.mjs"));
    assert.ok(gate >= 0 && gate < azure && gate < transaction);
  }
});
