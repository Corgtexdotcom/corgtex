import { createHash } from "node:crypto";
import type { CustomerAccount, CustomerDeployment, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { z } from "zod";
import { invariant } from "./errors";

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const group = z.string().min(1).max(90).regex(/^[A-Za-z0-9][A-Za-z0-9_.()-]*$/);
const app = z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/).refine((value) => !value.includes("--"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const origin = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && url.origin === value;
});
export const managedAzureTargetSchema = z.object({
  deploymentId: uuid, customerAccountId: uuid, deploymentKind: z.enum(["HOSTED_DEDICATED", "REMOTE_MANAGED"]),
  origin, subscriptionId: uuid, resourceGroup: group, webAppName: app, workerAppName: app,
  acrName: z.string().min(5).max(50).regex(/^[a-z0-9]+$/), acrServer: z.string(), acrResourceGroup: group,
  evidenceSha256: digest, activationPolicy: z.enum(["STANDARD", "EXCLUSIVE"]),
  releaseApproval: z.object({ gitSha, schemaApprovalDigest: digest }).strict(),
  recovery: z.object({ gitSha, releaseVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/), schemaCompatibilityApprovalDigest: digest }).strict(),
}).strict().refine((target) => target.acrServer === `${target.acrName}.azurecr.io` && target.webAppName !== target.workerAppName);
export type ManagedAzureTarget = z.infer<typeof managedAzureTargetSchema>;

export function managedAzureTargets(raw = process.env.MANAGED_RELEASE_TARGETS_JSON) {
  if (!raw) return [];
  invariant(raw.length <= 65536, 409, "MANAGED_RELEASE_TARGET_CONFIG_INVALID", "Protected target configuration is invalid.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  const parsed = z.object({ schemaVersion: z.literal(1), targets: z.array(managedAzureTargetSchema).min(1).max(100) }).strict().safeParse(value);
  invariant(parsed.success, 409, "MANAGED_RELEASE_TARGET_CONFIG_INVALID", "Protected target configuration is invalid.");
  const targets = parsed.data.targets;
  const apps = targets.flatMap((target) => [target.webAppName, target.workerAppName]
    .map((name) => `${target.subscriptionId.toLowerCase()}/${target.resourceGroup.toLowerCase()}/${name}`));
  invariant(new Set(targets.map((target) => target.deploymentId)).size === targets.length && new Set(apps).size === apps.length,
    409, "MANAGED_RELEASE_TARGET_CONFIG_INVALID", "Protected targets overlap.");
  return targets;
}

export function managedAzureTargetDigest(target: ManagedAzureTarget) {
  return createHash("sha256").update(JSON.stringify(managedAzureTargetSchema.parse(target))).digest("hex");
}

export function managedAzureRecoveryAuthorityDigest(target: ManagedAzureTarget) {
  const parsed = managedAzureTargetSchema.parse(target);
  return createHash("sha256").update(JSON.stringify({
    deploymentId: parsed.deploymentId, customerAccountId: parsed.customerAccountId,
    deploymentKind: parsed.deploymentKind, origin: parsed.origin, subscriptionId: parsed.subscriptionId,
    resourceGroup: parsed.resourceGroup, webAppName: parsed.webAppName, workerAppName: parsed.workerAppName,
    acrName: parsed.acrName, acrServer: parsed.acrServer, acrResourceGroup: parsed.acrResourceGroup,
    evidenceSha256: parsed.evidenceSha256, activationPolicy: parsed.activationPolicy, recovery: parsed.recovery,
  })).digest("hex");
}
function appName(value: string | null, target: ManagedAzureTarget) {
  if (!value?.startsWith("/")) return value;
  const prefix = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/`;
  return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length) : null;
}
function canonicalHttpsOrigin(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port
      && parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : null;
  } catch { return null; }
}
function azureContainerAppResourceId(value: string | null) {
  const matched = typeof value === "string"
    ? /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([^/]+)$/i.exec(value)
    : null;
  return matched ? { subscriptionId: matched[1]!.toLowerCase(), resourceGroup: matched[2]!.toLowerCase(), appName: matched[3]!.toLowerCase() } : null;
}
function deploymentAliasesTarget(
  row: Pick<CustomerDeployment, "url" | "providerSubscriptionId" | "providerResourceGroup" | "providerWebServiceId" | "providerWorkerServiceId">,
  target: ManagedAzureTarget,
) {
  if (canonicalHttpsOrigin(row.url) === target.origin) return true;
  const targetApps = new Set([target.webAppName.toLowerCase(), target.workerAppName.toLowerCase()]);
  const targetSubscription = target.subscriptionId.toLowerCase();
  const targetResourceGroup = target.resourceGroup.toLowerCase();
  return [row.providerWebServiceId, row.providerWorkerServiceId].some((value) => {
    const resource = azureContainerAppResourceId(value);
    if (resource) return resource.subscriptionId === targetSubscription
      && resource.resourceGroup === targetResourceGroup && targetApps.has(resource.appName);
    return row.providerSubscriptionId?.toLowerCase() === targetSubscription
      && row.providerResourceGroup?.toLowerCase() === targetResourceGroup
      && targetApps.has(value?.toLowerCase() ?? "");
  });
}
type ManagedAzureBindingRow = Pick<CustomerDeployment, "id" | "customerAccountId" | "deploymentKind" | "cloudProvider" | "environment" | "url"
  | "providerSubscriptionId" | "providerResourceGroup" | "providerWebServiceId" | "providerWorkerServiceId">;
export function assertManagedAzureTargetBinding(row: ManagedAzureBindingRow, acr?: { acrName: string; acrServer: string }, required = row.deploymentKind === "HOSTED_DEDICATED") {
  const target = managedAzureTargets().find((item) => item.deploymentId === row.id);
  invariant(target || !required, 409, "MANAGED_RELEASE_TARGET_CONFIG_REQUIRED", "An authoritative protected target is required.");
  if (!target) return null; // Preserve unmapped historical REMOTE_MANAGED behavior.
  invariant(row.customerAccountId === target.customerAccountId && row.deploymentKind === target.deploymentKind
    && row.cloudProvider === "AZURE" && row.environment === "production" && row.url.replace(/\/$/, "") === target.origin
    && row.providerSubscriptionId?.toLowerCase() === target.subscriptionId.toLowerCase()
    && row.providerResourceGroup?.toLowerCase() === target.resourceGroup.toLowerCase()
    && appName(row.providerWebServiceId, target) === target.webAppName && appName(row.providerWorkerServiceId, target) === target.workerAppName
    && (!acr || (acr.acrName === target.acrName && acr.acrServer === target.acrServer)),
    409, "MANAGED_RELEASE_TARGET_CONFIG_CONFLICT", "Deployment or registry differs from the protected target.");
  return target;
}

export async function requireManagedAzureAccountAuthority(tx: Prisma.TransactionClient,
  row: Pick<CustomerDeployment, "id" | "customerAccountId" | "deploymentKind">) {
  const accounts = await tx.$queryRaw<Pick<CustomerAccount, "id" | "status" | "managementAuthority" | "primaryDeploymentId">[]>`
    SELECT id, status, "managementAuthority", "primaryDeploymentId" FROM "CustomerAccount" WHERE id = ${row.customerAccountId} FOR SHARE`;
  const account = accounts[0];
  invariant(account && account.managementAuthority === "CORGTEX"
    && !["SUSPENDED", "CHURNED"].includes(account.status),
    409, "MANAGED_RELEASE_ACCOUNT_AUTHORITY_REQUIRED", "Current account management authority is required.");
  invariant(account.primaryDeploymentId === row.id,
    409, "MANAGED_RELEASE_ACCOUNT_AUTHORITY_REQUIRED", "The hosted deployment must remain the account's current primary target.");
}

type MetadataAccount = Pick<CustomerAccount, "id" | "status" | "managementAuthority" | "primaryDeploymentId" | "updatedAt">;
export function managedAzureMetadataDigest(row: CustomerDeployment, account: MetadataAccount) {
  return createHash("sha256").update(JSON.stringify({
    id: row.id, customerAccountId: row.customerAccountId, kind: row.deploymentKind, provider: row.cloudProvider,
    environment: row.environment, status: row.deploymentStatus, provisioningStatus: row.provisioningStatus, url: row.url,
    subscriptionId: row.providerSubscriptionId, resourceGroup: row.providerResourceGroup,
    web: row.providerWebServiceId, worker: row.providerWorkerServiceId,
    managedWorkspaceId: row.managedWorkspaceId, remoteWorkspaceId: row.remoteWorkspaceId, remoteWorkspaceSlug: row.remoteWorkspaceSlug,
    leaseId: row.releaseLeaseId, fence: row.releaseLeaseFence, updatedAt: row.updatedAt.toISOString(),
    account: { id: account.id, status: account.status, managementAuthority: account.managementAuthority,
      primaryDeploymentId: account.primaryDeploymentId, updatedAt: account.updatedAt.toISOString() },
  })).digest("hex");
}

export const reconcileManagedAzureTargetSchema = z.object({
  deploymentId: uuid, execute: z.boolean(), expectedMetadataDigest: digest.optional(), expectedTargetDigest: digest.optional(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

// Called only behind control-plane release-write and deployment-write checks.
export async function reconcileManagedAzureTarget(input: z.infer<typeof reconcileManagedAzureTargetSchema>) {
  const request = reconcileManagedAzureTargetSchema.parse(input);
  const target = managedAzureTargets().find((item) => item.deploymentId === request.deploymentId);
  invariant(target, 409, "MANAGED_RELEASE_TARGET_CONFIG_REQUIRED", "An authoritative protected target is required.");
  const targetDigest = managedAzureTargetDigest(target);
  return prisma.$transaction(async (tx) => {
    // Serialize metadata reconciliation and reject aliasing with another stable ID.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('managed_azure_target_reconciliation', 0))`;
    const [row] = await tx.$queryRaw<CustomerDeployment[]>`SELECT * FROM "CustomerDeployment" WHERE id = ${request.deploymentId} FOR UPDATE`;
    invariant(row, 404, "NOT_FOUND", "Deployment not found.");
    const [account] = await tx.$queryRaw<MetadataAccount[]>`SELECT id, status, "managementAuthority", "primaryDeploymentId", "updatedAt" FROM "CustomerAccount" WHERE id = ${row.customerAccountId} FOR SHARE`;
    const protectedHosted = target.deploymentKind === "HOSTED_DEDICATED";
    invariant(account?.id === target.customerAccountId && account.managementAuthority === "CORGTEX"
      && (protectedHosted ? !["SUSPENDED", "CHURNED"].includes(account.status) : account.status === "ACTIVE")
      && (!protectedHosted || account.primaryDeploymentId === row.id)
      && row.deploymentKind === target.deploymentKind && row.environment === "production"
      && !["SUSPENDED", "RETIRED"].includes(row.deploymentStatus), 409, "MANAGED_RELEASE_ACCOUNT_AUTHORITY_REQUIRED", "Current deployment/account authority is required.");
    invariant(!row.releaseLeaseId && !row.releaseLeasePhase && !row.releaseLeaseRollbackRecord,
      409, "MANAGED_RELEASE_RECOVERY_REQUIRED", "Reconcile the retained operation before changing target metadata.");
    // Canonical HTTPS identity includes default-port and trailing-slash aliases that
    // cannot be represented by a finite exact-string candidate list, so inspect every
    // other stable deployment while holding the reconciliation advisory lock.
    const aliases = await tx.customerDeployment.findMany({ where: { id: { not: row.id } }, select: { url: true, providerSubscriptionId: true, providerResourceGroup: true,
      providerWebServiceId: true, providerWorkerServiceId: true } });
    invariant(!aliases.some((other) => deploymentAliasesTarget(other, target)),
      409, "MANAGED_RELEASE_TARGET_OVERLAP", "Target belongs to another deployment.");
    const beforeDigest = managedAzureMetadataDigest(row, account);
    if (!request.execute) return { deploymentId: row.id, status: "RECONCILIATION_READY", effects: 0, metadataDigest: beforeDigest, targetDigest, target };
    invariant(request.expectedMetadataDigest === beforeDigest && request.expectedTargetDigest === targetDigest,
      409, "MANAGED_RELEASE_TARGET_CONFIG_CONFLICT", "Metadata or protected evidence changed; refresh reconciliation.");
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: {
      url: target.origin, cloudProvider: "AZURE", providerSubscriptionId: target.subscriptionId,
      providerResourceGroup: target.resourceGroup, providerWebServiceId: target.webAppName, providerWorkerServiceId: target.workerAppName,
    } });
    const afterDigest = managedAzureMetadataDigest(updated, account);
    await tx.customerDeploymentEvent.create({ data: { deploymentId: row.id, action: "control_plane.managed_azure.target_reconciled",
      meta: { beforeDigest, afterDigest, targetDigest, evidenceSha256: target.evidenceSha256, reason: request.reason } } });
    return { deploymentId: row.id, status: "RECONCILED", metadataDigest: afterDigest, targetDigest };
  });
}
