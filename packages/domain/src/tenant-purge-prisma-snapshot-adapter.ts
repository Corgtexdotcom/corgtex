import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { TenantPurgeAuthorizeAndCapture } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedEntry } from "./tenant-purge-owned-collection-kernel";
import { captureTenantPurgePrismaClockMilliseconds, captureTenantPurgePrismaDateMilliseconds, captureTenantPurgePrismaOrderedUuidVector, captureTenantPurgePrismaRowValues } from "./tenant-purge-prisma-snapshot-value-kernel";
import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import { compileTenantPurgeScalarSpec, copyTenantPurgeScalar, invalidTenantPurgeValue } from "./tenant-purge-value-scalar-kernel";
const FREEZE = Object.freeze; const IS_INTEGER = Number.isInteger; const APPLY = Reflect.apply;
const UUID = compileTenantPurgeScalarSpec({ kind: "uuid" }); const SHA = compileTenantPurgeScalarSpec({ kind: "sha" });
const KEY = compileTenantPurgeScalarSpec({ kind: "string", maximumLength: 160 });
const PAGE = compileTenantPurgeScalarSpec({ kind: "integer", minimum: 1, maximum: 1_000 });
const EVIDENCE = compileTenantPurgeScalarSpec({ kind: "integer", minimum: 1, maximum: 100_000 });
const TTL = compileTenantPurgeScalarSpec({ kind: "integer", minimum: 0, maximum: 31_536_000 });
const STATUSES = FREEZE(["PLANNED", "DRY_RUN_COMPLETE", "BACKUP_COMPLETE", "RESTORE_VERIFIED", "APPROVED",
  "EXECUTING", "CLEANUP_PENDING", "VERIFYING", "COMPLETED", "RESTORING", "RESTORED", "CANCELLED", "FAILED"]);
function vector<T>(items: readonly T[], maximum = items.length): TenantPurgeOwnedVector<T> {
  let result = createTenantPurgeOwnedVector<T>(maximum);
  for (let index = 0; index < items.length; index += 1) result = pushTenantPurgeOwnedVector(result, items[index]);
  return result;
}
function fields(...names: string[]): TenantPurgeOwnedVector<string> { return vector(names); }
const RUN_FIELDS = fields("id", "mode", "status", "targetAccountId", "targetDeploymentId", "targetWorkspaceId", "targetTrialId", "canonicalTargetKey", "activeTargetKey", "capabilitySha", "terminalAt");
const ID_FIELDS = fields("id");
const DEPLOYMENT_FIELDS = fields("id", "managedWorkspaceId", "customerAccountId", "releaseLeaseId", "releaseLeaseTokenHash", "releaseLeaseOwner", "releaseLeaseExpectedImageTag", "releaseLeaseIncomingImageTag",
  "releaseLeaseIncomingVersion", "releaseLeasePhase", "releaseLeaseAcquiredAt", "releaseLeaseHeartbeatAt", "releaseLeaseExpiresAt", "releaseLeaseRollbackRecord", "releaseLeaseRecoveryEvidence", "releaseLeaseError");
const ACCOUNT_FIELDS = fields("id", "primaryDeploymentId");
const TRIAL_FIELDS = fields("id", "workspaceId", "trialExpiresAt");
function invalid(): never { return invalidTenantPurgeValue(); }
function uuid(value: unknown): string { return copyTenantPurgeScalar(value, UUID) as string; }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function row(value: unknown, spec: TenantPurgeOwnedVector<string>, length: number): readonly unknown[] {
  return captureTenantPurgeOwnedVector(captureTenantPurgePrismaRowValues(value, spec), length);
}
function optionalRow(value: unknown, spec: TenantPurgeOwnedVector<string>, length: number): readonly unknown[] | null { return value === null ? null : row(value, spec, length); }
function status(value: unknown): string {
  if (typeof value !== "string") return invalid();
  for (let index = 0; index < STATUSES.length; index += 1) if (value === STATUSES[index]) return value;
  return invalid();
}
function runValues(value: unknown) {
  if (value === null) return null;
  const source = row(value, RUN_FIELDS, 11);
  const mode = source[1] === "ACCOUNT_WORKSPACE" || source[1] === "SELF_SERVE_TRIAL_WORKSPACE"
    ? source[1] : invalid();
  return FREEZE({ id: uuid(source[0]), mode, status: status(source[2]), accountId: nullableUuid(source[3]), deploymentId: uuid(source[4]), workspaceId: uuid(source[5]), trialId: nullableUuid(source[6]),
    canonicalKey: copyTenantPurgeScalar(source[7], KEY) as string,
    activeKey: source[8] === null ? null : copyTenantPurgeScalar(source[8], KEY) as string,
    capabilitySha: copyTenantPurgeScalar(source[9], SHA) as string,
    terminalAt: source[10] === null ? null : captureTenantPurgePrismaDateMilliseconds(source[10]) });
}
function deploymentValues(value: unknown) {
  const source = optionalRow(value, DEPLOYMENT_FIELDS, 16);
  if (source === null) return null;
  let lease = false;
  for (let index = 3; index < source.length; index += 1) if (source[index] !== null) lease = true;
  return FREEZE({ id: uuid(source[0]), workspaceId: nullableUuid(source[1]), accountId: nullableUuid(source[2]), lease });
}
function accountValues(value: unknown) {
  const source = optionalRow(value, ACCOUNT_FIELDS, 2);
  return source === null ? null : FREEZE({ id: uuid(source[0]), primaryDeploymentId: nullableUuid(source[1]) });
}
function trialValues(value: unknown) {
  const source = optionalRow(value, TRIAL_FIELDS, 3);
  return source === null ? null : FREEZE({ id: uuid(source[0]), workspaceId: nullableUuid(source[1]),
    expiresAt: captureTenantPurgePrismaDateMilliseconds(source[2]) });
}
function exists(value: unknown): boolean {
  if (value === null) return false; uuid(row(value, ID_FIELDS, 1)[0]); return true;
}
function record(entries: readonly (readonly [string, unknown])[]): TenantPurgeOwnedVector<unknown> {
  let result = createTenantPurgeOwnedVector<unknown>(entries.length);
  for (let index = 0; index < entries.length; index += 1)
    result = pushTenantPurgeOwnedVector(result, createTenantPurgeOwnedEntry(entries[index][0], entries[index][1]));
  return result;
}
const DENIED = FREEZE(async function (): Promise<false> { return false; });
export function createTenantPurgePrismaAuthorizeAndCapture(
  privateAuthority: unknown, targetMode: unknown, runId: unknown, redactionKeyBytes: unknown,
  pageSize: unknown, maxPagesPerModel: unknown, maxEvidenceItems: unknown, cacheMaxTtlSeconds: unknown,
): TenantPurgeAuthorizeAndCapture {
  if (privateAuthority !== true) return DENIED;
  const requestedMode = targetMode === "ACCOUNT_WORKSPACE" || targetMode === "SELF_SERVE_TRIAL_WORKSPACE"
    ? targetMode : invalid();
  const id = uuid(runId); const inputBytes = captureTenantPurgeOwnedVector<unknown>(redactionKeyBytes, 64);
  if (inputBytes.length < 32) return invalid();
  let bytes = createTenantPurgeOwnedVector<number>(64);
  for (let index = 0; index < inputBytes.length; index += 1) {
    const byte = inputBytes[index];
    if (typeof byte !== "number" || !APPLY(IS_INTEGER, Number, [byte]) || byte < 0 || byte > 255) return invalid();
    bytes = pushTenantPurgeOwnedVector(bytes, byte);
  }
  const policies = FREEZE([copyTenantPurgeScalar(pageSize, PAGE), copyTenantPurgeScalar(maxPagesPerModel, PAGE),
    copyTenantPurgeScalar(maxEvidenceItems, EVIDENCE), copyTenantPurgeScalar(cacheMaxTtlSeconds, TTL)]);
  let used = false;
  return FREEZE(async function (): Promise<false | TenantPurgeOwnedVector<unknown>> {
    if (used) return invalid(); used = true;
    try {
      return await prisma.$transaction(async (tx) => {
        const authority = runValues(await tx.tenantPurgeRun.findUnique({ where: { id }, select: { id: true, mode: true, status: true, targetAccountId: true, targetDeploymentId: true, targetWorkspaceId: true,
          targetTrialId: true, canonicalTargetKey: true, activeTargetKey: true, capabilitySha: true, terminalAt: true } }));
        if (authority === null) return false;
        const targetId = authority.mode === "ACCOUNT_WORKSPACE" ? authority.accountId : authority.trialId;
        const canonical = `${authority.mode}:${targetId}:${authority.deploymentId}:${authority.workspaceId}`;
        const shape = authority.mode === "ACCOUNT_WORKSPACE" ? authority.accountId !== null && authority.trialId === null
          : authority.trialId !== null && authority.accountId === null;
        if (authority.id !== id || authority.mode !== requestedMode || !shape || authority.status !== "PLANNED"
          || authority.terminalAt !== null || authority.canonicalKey !== canonical || authority.activeKey !== canonical) return false;
        const capturedAt = captureTenantPurgePrismaClockMilliseconds();
        const workspaceRow = optionalRow(await tx.workspace.findUnique({ where: { id: authority.workspaceId },
          select: { id: true } }), ID_FIELDS, 1);
        const deployment = deploymentValues(await tx.customerDeployment.findUnique({ where: { id: authority.deploymentId }, select: { id: true, managedWorkspaceId: true, customerAccountId: true,
          releaseLeaseId: true, releaseLeaseTokenHash: true, releaseLeaseOwner: true, releaseLeaseExpectedImageTag: true, releaseLeaseIncomingImageTag: true, releaseLeaseIncomingVersion: true,
          releaseLeasePhase: true, releaseLeaseAcquiredAt: true, releaseLeaseHeartbeatAt: true, releaseLeaseExpiresAt: true, releaseLeaseRollbackRecord: true,
          releaseLeaseRecoveryEvidence: true, releaseLeaseError: true } }));
        const accountId = authority.mode === "ACCOUNT_WORKSPACE" ? authority.accountId : deployment?.accountId ?? null;
        const account = accountId === null ? null : accountValues(await tx.customerAccount.findUnique({
          where: { id: accountId }, select: { id: true, primaryDeploymentId: true } }));
        const trial = authority.mode === "SELF_SERVE_TRIAL_WORKSPACE" ? trialValues(await tx.procurementTrial.findUnique({
          where: { id: authority.trialId! }, select: { id: true, workspaceId: true, trialExpiresAt: true } })) : null;
        const bounded = { select: { id: true }, orderBy: { id: "asc" as const }, take: 1_001 };
        const workspaceDeployments = captureTenantPurgePrismaOrderedUuidVector(await tx.customerDeployment.findMany({ where: { managedWorkspaceId: authority.workspaceId }, ...bounded }));
        const workspaceTrials = captureTenantPurgePrismaOrderedUuidVector(await tx.procurementTrial.findMany({ where: { workspaceId: authority.workspaceId }, ...bounded }));
        const accountDeployments = accountId === null ? createTenantPurgeOwnedVector<string>(0)
          : captureTenantPurgePrismaOrderedUuidVector(await tx.customerDeployment.findMany({
            where: { customerAccountId: accountId }, ...bounded }));
        const primaryAccounts = captureTenantPurgePrismaOrderedUuidVector(await tx.customerAccount.findMany({ where: { primaryDeploymentId: authority.deploymentId }, ...bounded }));
        const relation = authority.mode === "ACCOUNT_WORKSPACE" ? { OR: [{ customerAccountId: authority.accountId! },
          { sourceDeploymentId: authority.deploymentId }, { destinationDeploymentId: authority.deploymentId }] }
          : { OR: [{ sourceDeploymentId: authority.deploymentId },
            { destinationDeploymentId: authority.deploymentId }] };
        const cutover = exists(await tx.providerCutover.findFirst({ where: relation, select: { id: true } }));
        const migration = exists(await tx.clientMigrationRun.findFirst({ where: relation, select: { id: true } }));
        const workspaceId = workspaceRow === null ? null : uuid(workspaceRow[0]);
        const shared = deployment !== null && ((deployment.workspaceId !== null
          && deployment.workspaceId !== authority.workspaceId) || (authority.mode === "ACCOUNT_WORKSPACE"
          ? deployment.accountId !== null && deployment.accountId !== authority.accountId : deployment.accountId !== null));
        const target = authority.mode === "ACCOUNT_WORKSPACE" ? record([["mode", authority.mode],
          ["accountId", authority.accountId!], ["deploymentId", authority.deploymentId],
          ["workspaceId", authority.workspaceId]]) : record([["mode", authority.mode],
          ["trialId", authority.trialId!], ["deploymentId", authority.deploymentId],
          ["workspaceId", authority.workspaceId]]);
        const topology = record([["capturedAt", capturedAt], ["workspace", workspaceRow === null ? null
          : record([["id", workspaceId!], ["managedDeploymentIds", workspaceDeployments],
            ["trialIds", workspaceTrials]])], ["deployment", deployment === null ? null : record([
          ["id", deployment.id], ["managedWorkspaceId", deployment.workspaceId], ["accountId", deployment.accountId],
          ["primaryAccountIds", primaryAccounts], ["sharedResourceAmbiguous", shared],
          ["hasManagedReleaseLease", deployment.lease], ["hasProviderCutover", cutover],
          ["hasClientMigration", migration]])], ["account", account === null ? null : record([
          ["id", account.id], ["deploymentIds", accountDeployments],
          ["primaryDeploymentId", account.primaryDeploymentId]])], ["trial", trial === null ? null : record([
          ["id", trial.id], ["workspaceId", trial.workspaceId], ["expired", trial.expiresAt <= capturedAt]])]]);
        return record([["target", target], ["capabilitySha", authority.capabilitySha],
          ["redactionKeyBytes", bytes], ["policies", record([["pageSize", policies[0]],
            ["maxPagesPerModel", policies[1]], ["maxEvidenceItems", policies[2]],
            ["cacheMaxTtlSeconds", policies[3]]])], ["topology", topology],
          ["suppliedBlockers", createTenantPurgeOwnedVector(0)]]);
      }, { maxWait: 5_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch { return invalid(); }
  });
}
