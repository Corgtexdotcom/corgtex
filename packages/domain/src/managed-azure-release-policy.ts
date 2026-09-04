const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Deployment = {
  id: string;
  customerAccountId: string | null;
  deploymentKind: string;
  cloudProvider: string;
  environment: string;
  deploymentStatus: string;
  provisioningStatus: string;
};

// This configuration belongs to Ops, never to a workflow input or deployment row.
export function selectedManagedAzurePrimaryIds() {
  const raw = process.env.MANAGED_RELEASE_PRIMARY_DEPLOYMENT_IDS;
  if (!raw || raw.length > 3_700) return [];
  const ids = raw.split(",").map((id) => id.trim());
  return ids.length <= 100 && ids.every((id) => UUID.test(id)) && new Set(ids).size === ids.length ? ids : [];
}

export function activeManagedAzureDeployment(row: Deployment) {
  return Boolean(row.customerAccountId && row.cloudProvider === "AZURE" && row.environment === "production"
    && row.deploymentStatus === "ACTIVE" && row.provisioningStatus === "active");
}

export function managedAzureReleaseEligible(row: Deployment, workloadClass = "ACTIVE_CLIENT_PRIMARY") {
  if (!activeManagedAzureDeployment(row)) return false;
  if (workloadClass === "ACTIVE_CLIENT_PRIMARY") {
    return row.deploymentKind === "REMOTE_MANAGED"
      || (row.deploymentKind === "HOSTED_DEDICATED" && selectedManagedAzurePrimaryIds().includes(row.id));
  }
  const canary = process.env.MANAGED_RELEASE_CANARY_PREFLIGHT_DEPLOYMENT_ID?.trim();
  return workloadClass === "ACTIVE_CLIENT_CANARY" && row.deploymentKind === "HOSTED_DEDICATED"
    && Boolean(canary && UUID.test(canary) && row.id === canary);
}

export function managedAzureReleaseDeployment(row: Deployment, workloadClass: string) {
  return {
    deploymentId: row.id,
    deploymentKind: row.deploymentKind,
    cloudProvider: row.cloudProvider,
    environment: row.environment,
    deploymentStatus: row.deploymentStatus,
    provisioningStatus: row.provisioningStatus,
    releaseEligible: workloadClass === "ACTIVE_CLIENT_PRIMARY" && managedAzureReleaseEligible(row, workloadClass),
    provider: "azure",
    group: row.deploymentKind === "REMOTE_MANAGED" ? "managed-customers" : "hosted-dedicated",
    workload: workloadClass === "ACTIVE_CLIENT_CANARY" ? "active-client-canary"
      : row.deploymentKind === "REMOTE_MANAGED" ? "managed-customers" : "hosted-dedicated",
    workloadClass,
  };
}
