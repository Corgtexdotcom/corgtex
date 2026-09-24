import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { validatePostgresRuntimeAccessPolicy } from "./ops-core-postgres-runtime-access.mjs";

const need = (value, code) => { if (!value) throw new Error(code); };
export const requiresSharedPostgresRuntimeAccess = target => Object.hasOwn(target?.postgres ?? {}, "resourceGroupName");

export function validateRuntimeAccessActivationBinding(activation) {
  const policy = activation.runtimeAccess;
  need(policy !== undefined || !requiresSharedPostgresRuntimeAccess(activation.target), "RUNTIME_ACCESS_POLICY_REQUIRED");
  if (policy === undefined) return null; // Historical dedicated-server plans remain readable.
  validatePostgresRuntimeAccessPolicy(policy, { domain: activation.target.domain, runtimeVaultUri: activation.runtimeVaultUri });
  need(activation.target.sharedStateBackend === "postgres" && activation.schemaVersion === 2
    && activation.workerDemand, "RUNTIME_ACCESS_DEMAND_REQUIRED");
  for (const role of ["web", "worker"]) {
    const r = activation.roles[role];
    const env = r?.env?.filter(e => e.name === "DATABASE_URL");
    const secret = r?.secrets?.filter(s => s.name === env?.[0]?.secretRef);
    need(env?.length === 1 && secret?.length === 1
      && secret[0].keyVaultUrl === policy.runtimeDatabaseSecrets[role], "RUNTIME_ACCESS_CREDENTIAL_BINDING_MISMATCH");
  }
  need(activation.workerDemand.scalerConnectionSecret?.keyVaultUrl === policy.scaler.connectionSecretVersion,
    "RUNTIME_ACCESS_SCALER_BINDING_MISMATCH");
  return policy;
}

export function validateTransferRuntimeAccessBinding(plan) {
  const policy = plan.transfer.postgres.runtimeAccess;
  need(policy !== undefined || !requiresSharedPostgresRuntimeAccess(plan.azure), "RUNTIME_ACCESS_POLICY_REQUIRED");
  if (policy === undefined) {
    need(plan.activation?.runtimeAccess === undefined, "RUNTIME_ACCESS_POLICY_MISMATCH");
    return null;
  }
  need(plan.schemaVersion === 2 && plan.activation && plan.activation.target?.domain === plan.domain,
    "RUNTIME_ACCESS_PLAN_INVALID");
  const activation = validateRuntimeAccessActivationBinding(plan.activation);
  need(activation && archiveEvidenceHash(policy) === archiveEvidenceHash(activation), "RUNTIME_ACCESS_POLICY_MISMATCH");
  return policy;
}
