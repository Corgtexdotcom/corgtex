import test from "node:test";
import assert from "node:assert/strict";
import { assertOpsHotfixFleetBoundary } from "./ops-hotfix-fleet-boundary.mjs";
const uuid = (n) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;
function fixture() {
  const railway = { projectId: uuid("1"), environmentId: uuid("2"), webServiceId: uuid("3"), workerServiceId: uuid("4") };
  return { admission: { admissionId: "ops-release-authority", provider: "railway", targetId: "synthetic-ops", origin: "https://ops.corgtex.com", deploymentId: null, railway },
    context: { repository: "Corgtexdotcom/corgtex", eventName: "workflow_dispatch", ref: "refs/heads/main", workflowRef: "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/main" },
    selector: "ops", targetId: "", targets: [{ id: "synthetic-ops", url: "https://ops.corgtex.com", group: "ops", provider: "railway", deploymentId: null, railway: { ...railway } }] };
}
test("Ops admission requires one explicitly null-deployment target with exact resources", () => {
  const input = fixture(); assert.equal(assertOpsHotfixFleetBoundary(input), input.targets[0]);
});
for (const selector of ["all", "default", "backup-app", "selfserve", "ops,selfserve", "", " ops "]) test(`rejects selector ${JSON.stringify(selector)}`, () => {
  assert.throws(() => assertOpsHotfixFleetBoundary({ ...fixture(), selector }), /SELECTION_INVALID/);
});
test("rejects omitted/null request IDs, multiple targets and omitted/non-null deployment IDs", () => {
  for (const targetId of [undefined, null, "synthetic-ops"]) assert.throws(() => assertOpsHotfixFleetBoundary({ ...fixture(), targetId }), /SELECTION_INVALID/);
  const multiple = fixture(); multiple.targets.push(structuredClone(multiple.targets[0]));
  assert.throws(() => assertOpsHotfixFleetBoundary(multiple), /SELECTION_INVALID/);
  for (const field of ["admission", "target"]) for (const value of [undefined, "synthetic-ops"]) {
    const input = fixture(), object = field === "admission" ? input.admission : input.targets[0];
    if (value === undefined) delete object.deploymentId; else object.deploymentId = value;
    assert.throws(() => assertOpsHotfixFleetBoundary(input), /ADMISSION_INVALID|TARGET_MISMATCH/);
  }
});
test("rejects cross-provider, cross-origin and every changed Railway resource", () => {
  for (const [key, value] of [["provider", "azure"], ["url", "https://selfserve.corgtex.com"], ["id", "another-ops"], ["group", "backup-app"]]) {
    const input = fixture(); input.targets[0][key] = value;
    assert.throws(() => assertOpsHotfixFleetBoundary(input), /TARGET_MISMATCH/);
  }
  for (const key of Object.keys(fixture().admission.railway)) {
    const input = fixture(); input.targets[0].railway[key] = uuid("5");
    assert.throws(() => assertOpsHotfixFleetBoundary(input), /RESOURCE_MISMATCH/);
  }
  const selfserve = fixture(); selfserve.admission.admissionId = "selfserve-switcher";
  assert.throws(() => assertOpsHotfixFleetBoundary(selfserve), /ADMISSION_INVALID/);
});
test("rejects untrusted workflow repository/event/ref/path", () => {
  for (const [key, value] of [["repository", "fork/corgtex"], ["eventName", "pull_request"], ["ref", "refs/heads/hotfix"], ["workflowRef", "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/hotfix"]]) {
    const input = fixture(); input.context[key] = value;
    assert.throws(() => assertOpsHotfixFleetBoundary(input), /TOOLING_UNTRUSTED/);
  }
});
