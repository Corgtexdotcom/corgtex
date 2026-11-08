// Called on raw selected targets before Fleet normalization. This deliberately
// does not treat a null deployment ID as a target selector.
export function assertOpsHotfixFleetBoundary({ admission, context, selector, targetId, targets }) {
  const requireBoundary = (condition, code) => { if (!condition) throw new Error(code); };
  requireBoundary(context?.repository === "Corgtexdotcom/corgtex"
    && context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main"
    && context.workflowRef === "Corgtexdotcom/corgtex/.github/workflows/fleet-release.yml@refs/heads/main",
  "HOTFIX_FLEET_TOOLING_UNTRUSTED");
  requireBoundary(admission?.admissionId === "ops-release-authority" && admission.provider === "railway"
    && admission.origin === "https://ops.corgtex.com" && typeof admission.targetId === "string"
    && admission.targetId.length > 0 && Object.hasOwn(admission, "deploymentId") && admission.deploymentId === null,
  "HOTFIX_FLEET_ADMISSION_INVALID");
  requireBoundary(selector === "ops" && targetId === "" && Array.isArray(targets) && targets.length === 1,
    "HOTFIX_FLEET_SELECTION_INVALID");
  const target = targets[0];
  requireBoundary(target?.id === admission.targetId && target.url === admission.origin
    && target.provider === "railway" && target.group === "ops"
    && Object.hasOwn(target, "deploymentId") && target.deploymentId === null,
  "HOTFIX_FLEET_TARGET_MISMATCH");
  const fields = ["projectId", "environmentId", "webServiceId", "workerServiceId"];
  requireBoundary(admission.railway && Object.keys(admission.railway).length === fields.length
    && fields.every((key) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(admission.railway[key] ?? "")
      && target.railway?.[key] === admission.railway[key]), "HOTFIX_FLEET_RESOURCE_MISMATCH");
  return target;
}

// Source admission authorizes checks and builds only. The observed Ops schema
// discrepancy and recovery cut-point/compatibility have no approved operational
// receipt yet. Replace this hold only with the reviewed supported receipt gate;
// there is intentionally no environment variable or manifest toggle bypass.
export function requireOpsOperationalApproval() {
  throw new Error("HOTFIX_OPS_OPERATIONAL_APPROVAL_REQUIRED");
}
