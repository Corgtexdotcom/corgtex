import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const steps = candidate.jobs.candidate.steps;
  assert.ok(steps.findIndex((s) => s.run?.includes("hotfix-candidate-ci.mjs verify")) < steps.findIndex((s) => s.run === "npm ci"));
  assert.ok(steps.some((s) => s.run?.includes("WorkspaceSwitcher.browser.test.ts")));
  assert.equal(candidate.jobs.candidate["runs-on"], "ubuntu-24.04");
  const database = steps.find((s) => s.uses?.includes("ci-pgvector")).with.database;
  assert.equal(database, "corgtex_ci");
  assert.equal(new URL(candidate.jobs.candidate.env.DATABASE_URL).pathname, `/${database}`);
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
