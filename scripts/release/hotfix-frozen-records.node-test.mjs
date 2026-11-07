import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateHotfixAdmission } from "./selfserve-hotfix-source.mjs";
import { discoverHotfixCi } from "./hotfix-candidate-ci.mjs";
import { runHotfixGate } from "./selfserve-hotfix-gate.mjs";
import { assertOpsHotfixRequest, readOpsHotfixProof } from "./ops-hotfix-fleet-proof.mjs";
const records = ["selfserve-switcher", "ops-release-authority"].map(id => JSON.parse(readFileSync(new URL(`../../.github/${id}-hotfix.json`, import.meta.url), "utf8")));
function observed(m) { return { ...m, repository: m.repository, sourceSha: m.candidateSha, sourceTree: m.candidateTree,
  parents: [m.baseSha], baseIsMainAncestor: true, recoveryIsMainAncestor: true,
  basePrismaTree: m.prismaTree, sourcePrismaTree: m.prismaTree, recoveryPrismaTree: m.prismaTree }; }
test("both real frozen records are discoverable and independently admit their source only", () => {
  assert.deepEqual(discoverHotfixCi().include.map(x => x.admissionId), ["selfserve-switcher", "ops-release-authority"]);
  assert.equal(records[0].candidateSha, "adbb1c463b97dfa41a015a3848ba4de94e7967e5");
  assert.equal(records[1].candidateSha, "e660f4e41229c2b8e419543de1fcfe6500cb3392");
  assert.equal(records[1].changedFiles.length, 15);
  for (const m of records) assert.equal(validateHotfixAdmission(m, observed(m)).sourceSha, m.candidateSha);
});
test("frozen records reject crossed lanes, sources, providers, targets and Prisma trees", () => {
  for (const [index, m] of records.entries()) {
    const other = records[1 - index];
    for (const change of [{ sourceSha: other.candidateSha }, { sourceTree: other.candidateTree },
      { sourcePrismaTree: other.prismaTree }, { targetId: other.targetId }, { origin: other.origin },
      { admissionId: index === 0 ? "ops-release-authority" : "selfserve-switcher" },
      { provider: index === 0 ? "railway" : "azure" }]) {
      assert.throws(() => validateHotfixAdmission(m, { ...observed(m), ...change }), /HOTFIX_/);
    }
  }
});
test("real Ops source admission does not grant operational promotion or accept a fabricated approval", async () => {
  await assert.rejects(runHotfixGate("ops-release", { HOTFIX_EVIDENCE: "{}", OPS_OPERATIONAL_APPROVAL: "approved" }), /HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED/);
  assert.throws(() => readOpsHotfixProof({ OPS_HOTFIX_PROOF_FILE: "/nonexistent/fabricated-proof.json" }), /HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED/);
  const env = { GITHUB_REPOSITORY: "Corgtexdotcom/corgtex", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/main",
    RELEASE_INPUT: records[1].candidateSha, TARGETS_INPUT: "ops", FLEET_RELEASE_TARGET_ID: "", HOTFIX_EVIDENCE: "{}" };
  assert.throws(() => assertOpsHotfixRequest(env), /HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED/);
  assert.throws(() => assertOpsHotfixRequest({ ...env, HOTFIX_EVIDENCE: "" }), /HOTFIX_FLEET_EVIDENCE_REQUIRED/);
});
