import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { TenantPurgeAuthorizeAndCapture } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedEntry } from "./tenant-purge-owned-collection-kernel";
import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import { invalidTenantPurgeValue } from "./tenant-purge-value-scalar-kernel";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/; const TOPOLOGY_LIMIT = 1_000;
const TRANSACTION_OPTIONS = Object.freeze({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 15_000 });
function invalid(): never { return invalidTenantPurgeValue(); }
function exactUuid(value: unknown): string { return typeof value === "string" && UUID.test(value) ? value : invalid(); } function optionalUuid(value: unknown): string | null { return value === null ? null : exactUuid(value); }
function boundedInteger(value: unknown, minimum: number, maximum: number): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid(); }
function vector<T>(values: readonly T[], maximum = values.length): TenantPurgeOwnedVector<T> {
  let result = createTenantPurgeOwnedVector<T>(maximum); for (let index = 0; index < values.length; index += 1) result = pushTenantPurgeOwnedVector(result, values[index]);
  return result;
}
function record(...fields: readonly (readonly [string, unknown])[]): TenantPurgeOwnedVector<unknown> {
  let result = createTenantPurgeOwnedVector<unknown>(fields.length); for (let index = 0; index < fields.length; index += 1) result = pushTenantPurgeOwnedVector(result, createTenantPurgeOwnedEntry(fields[index][0], fields[index][1]));
  return result;
}
function idVector(rows: unknown): { readonly ids: TenantPurgeOwnedVector<string>; readonly values: readonly string[] } {
  if (!Array.isArray(rows) || rows.length > TOPOLOGY_LIMIT) return invalid();
  const seen = new Set<string>(); const values: string[] = []; let ids = createTenantPurgeOwnedVector<string>(TOPOLOGY_LIMIT);
  for (let index = 0; index < rows.length; index += 1) {
    const id = exactUuid((rows[index] as { id?: unknown }).id);
    if (seen.has(id)) return invalid();
    seen.add(id); values.push(id); ids = pushTenantPurgeOwnedVector(ids, id);
  }
  return Object.freeze({ ids, values: Object.freeze(values) });
}
const DENIED = Object.freeze(async function denied(): Promise<false> { return false; });
export function createTenantPurgePrismaAuthorizeAndCapture(
  privateAuthority: unknown, targetMode: unknown, runId: unknown, redactionKeyBytes: unknown,
  pageSize: unknown, maxPagesPerModel: unknown, maxEvidenceItems: unknown, cacheMaxTtlSeconds: unknown,
): TenantPurgeAuthorizeAndCapture {
  if (privateAuthority !== true) return DENIED;
  const mode = targetMode === "ACCOUNT_WORKSPACE" || targetMode === "SELF_SERVE_TRIAL_WORKSPACE" ? targetMode : invalid();
  const copiedRunId = exactUuid(runId); const copiedKey = captureTenantPurgeOwnedVector<number>(redactionKeyBytes, 64);
  if (copiedKey.length < 32) return invalid();
  for (let index = 0; index < copiedKey.length; index += 1) boundedInteger(copiedKey[index], 0, 255);
  const key = vector(copiedKey, 64);
  const policies = record(
    ["pageSize", boundedInteger(pageSize, 1, 1_000)],
    ["maxPagesPerModel", boundedInteger(maxPagesPerModel, 1, 1_000)],
    ["maxEvidenceItems", boundedInteger(maxEvidenceItems, 1, 100_000)],
    ["cacheMaxTtlSeconds", boundedInteger(cacheMaxTtlSeconds, 0, 31_536_000)],
  );
  let used = false;
  return Object.freeze(async function authorizeAndCapture() {
    if (used) return invalid();
    used = true;
    return prisma.$transaction(async (tx) => {
      const run = await tx.tenantPurgeRun.findUnique({
        where: { id: copiedRunId },
        select: {
          mode: true, status: true, targetAccountId: true, targetDeploymentId: true,
          targetWorkspaceId: true, targetTrialId: true, canonicalTargetKey: true,
          activeTargetKey: true, capabilitySha: true,
        },
      });
      if (run === null || run.mode !== mode || run.status !== "PLANNED") return false;
      const accountId = optionalUuid(run.targetAccountId); const deploymentId = exactUuid(run.targetDeploymentId);
      const workspaceId = exactUuid(run.targetWorkspaceId); const trialId = optionalUuid(run.targetTrialId);
      const targetId = mode === "ACCOUNT_WORKSPACE" ? accountId : trialId;
      if (targetId === null || (mode === "ACCOUNT_WORKSPACE" ? trialId !== null : accountId !== null)) return false;
      const canonical = `${mode}:${targetId}:${deploymentId}:${workspaceId}`;
      if (run.canonicalTargetKey !== canonical || run.activeTargetKey !== canonical) return false;
      const capabilitySha = typeof run.capabilitySha === "string" && SHA.test(run.capabilitySha) ? run.capabilitySha : invalid();
      const capturedAt = Date.now(); if (!Number.isSafeInteger(capturedAt)) return invalid();
      const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
      const deployment = await tx.customerDeployment.findUnique({
        where: { id: deploymentId },
        select: {
          id: true, managedWorkspaceId: true, customerAccountId: true, releaseLeaseId: true,
          releaseLeaseTokenHash: true, releaseLeaseOwner: true, releaseLeaseExpectedImageTag: true,
          releaseLeaseIncomingImageTag: true, releaseLeaseIncomingVersion: true, releaseLeasePhase: true,
          releaseLeaseAcquiredAt: true, releaseLeaseHeartbeatAt: true, releaseLeaseExpiresAt: true,
          releaseLeaseRollbackRecord: true, releaseLeaseRecoveryEvidence: true, releaseLeaseError: true,
        },
      });
      const workspaceDeployments = idVector(await tx.customerDeployment.findMany({
        where: { managedWorkspaceId: workspaceId }, select: { id: true }, orderBy: { id: "asc" }, take: 1_001,
      }));
      const workspaceTrials = idVector(await tx.procurementTrial.findMany({
        where: { workspaceId }, select: { id: true }, orderBy: { id: "asc" }, take: 1_001,
      }));
      const accountLookupId = mode === "ACCOUNT_WORKSPACE" ? accountId : optionalUuid(deployment?.customerAccountId ?? null);
      const account = accountLookupId === null ? null : await tx.customerAccount.findUnique({
        where: { id: accountLookupId }, select: { id: true, primaryDeploymentId: true },
      });
      const accountDeployments = accountLookupId === null ? idVector([]) : idVector(
        await tx.customerDeployment.findMany({
          where: { customerAccountId: accountLookupId }, select: { id: true }, orderBy: { id: "asc" }, take: 1_001,
        }),
      );
      const primaryAccounts = idVector(await tx.customerAccount.findMany({
        where: { primaryDeploymentId: deploymentId }, select: { id: true }, orderBy: { id: "asc" }, take: 1_001,
      }));
      const trial = trialId === null ? null : await tx.procurementTrial.findUnique({
        where: { id: trialId }, select: { id: true, workspaceId: true, trialExpiresAt: true },
      });
      const related = accountId === null ? { OR: [{ sourceDeploymentId: deploymentId }, { destinationDeploymentId: deploymentId }] }
        : { OR: [{ customerAccountId: accountId }, { sourceDeploymentId: deploymentId }, { destinationDeploymentId: deploymentId }] };
      const cutover = await tx.providerCutover.findFirst({ where: related, select: { id: true }, orderBy: { id: "asc" } });
      const migration = await tx.clientMigrationRun.findFirst({ where: related, select: { id: true }, orderBy: { id: "asc" } });
      if (cutover !== null) exactUuid(cutover.id); if (migration !== null) exactUuid(migration.id);
      const managedWorkspaceId = optionalUuid(deployment?.managedWorkspaceId ?? null); const deploymentAccountId = optionalUuid(deployment?.customerAccountId ?? null);
      const trialTime = trial === null || trial.trialExpiresAt instanceof Date
        ? trial?.trialExpiresAt.getTime() ?? null
        : invalid();
      if (trialTime !== null && !Number.isFinite(trialTime)) return invalid();
      const lease = deployment === null ? false : [
        deployment.releaseLeaseId, deployment.releaseLeaseTokenHash, deployment.releaseLeaseOwner,
        deployment.releaseLeaseExpectedImageTag, deployment.releaseLeaseIncomingImageTag,
        deployment.releaseLeaseIncomingVersion, deployment.releaseLeasePhase, deployment.releaseLeaseAcquiredAt,
        deployment.releaseLeaseHeartbeatAt, deployment.releaseLeaseExpiresAt, deployment.releaseLeaseRollbackRecord,
        deployment.releaseLeaseRecoveryEvidence, deployment.releaseLeaseError,
      ].some((value) => value !== null);
      const outside = workspaceDeployments.values.some((id) => id !== deploymentId)
        || workspaceTrials.values.some((id) => id !== trialId)
        || accountDeployments.values.some((id) => id !== deploymentId)
        || primaryAccounts.values.some((id) => id !== accountId)
        || (managedWorkspaceId !== null && managedWorkspaceId !== workspaceId)
        || (deploymentAccountId !== null && deploymentAccountId !== accountId);
      const target = mode === "ACCOUNT_WORKSPACE"
        ? record(["mode", mode], ["accountId", accountId], ["deploymentId", deploymentId], ["workspaceId", workspaceId])
        : record(["mode", mode], ["trialId", trialId], ["deploymentId", deploymentId], ["workspaceId", workspaceId]);
      const topology = record(
        ["capturedAt", capturedAt],
        ["workspace", workspace === null ? null : record(["id", exactUuid(workspace.id)],
          ["managedDeploymentIds", workspaceDeployments.ids], ["trialIds", workspaceTrials.ids])],
        ["deployment", deployment === null ? null : record(["id", exactUuid(deployment.id)],
          ["managedWorkspaceId", managedWorkspaceId], ["accountId", deploymentAccountId],
          ["primaryAccountIds", primaryAccounts.ids], ["sharedResourceAmbiguous", outside],
          ["hasManagedReleaseLease", lease], ["hasProviderCutover", cutover !== null],
          ["hasClientMigration", migration !== null])],
        ["account", account === null ? null : record(["id", exactUuid(account.id)],
          ["deploymentIds", accountDeployments.ids], ["primaryDeploymentId", optionalUuid(account.primaryDeploymentId)])],
        ["trial", trial === null ? null : record(["id", exactUuid(trial.id)],
          ["workspaceId", optionalUuid(trial.workspaceId)],
          ["expired", trialTime! <= capturedAt])],
      );
      return record(["target", target], ["capabilitySha", capabilitySha], ["redactionKeyBytes", key],
        ["policies", policies], ["topology", topology], ["suppliedBlockers", vector([], 23)]);
    }, TRANSACTION_OPTIONS);
  });
}
