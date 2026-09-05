import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type CustomerDeployment, type CustomerDeploymentEvent } from "@prisma/client";
import { prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError } from "./errors";
import { activeManagedAzureDeployment, managedAzureReleaseDeployment, managedAzureReleaseEligible } from "./managed-azure-release-policy";
import { canonicalizeManagedAzureRollbackPayload, type ManagedAzureRollbackPayload } from "./managed-azure-recovery-payload";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";
import { assertManagedAzureTargetBinding, managedAzureRecoveryAuthorityDigest, managedAzureTargetDigest, requireManagedAzureAccountAuthority } from "./managed-azure-targets";
const IMAGE_TAG = /^sha-[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLLBACK_RESERVATION = /^rollback-archive:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const POSTGRES_UNSAFE_STRING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_INT = 2_147_483_647;
const TTL_MS = 5 * 60 * 1000;
const ACTIVE_PHASES = ["RESERVED", "MUTATING", "RECOVERY_REQUIRED"] as const;
const RECOVERY_STAGES = ["INVENTORY", "PREFLIGHT", "IMPORT", "WEB", "WORKER", "READBACK", "AUTH", "DIAGNOSTIC", "OBSERVATION", "ROLLBACK", "FENCING"] as const;
const ROLLBACK_ENVELOPE_KEYS = new Set(["version", "deploymentId", "leaseId", "fence", "expectedImageTag", "incomingImageTag", "incomingVersion", "payload"]);
const ORIGINATING_LEASE_EVENT_ACTION = "control_plane.release_lease.rollback_recorded";
type LockedDeployment = CustomerDeployment & { databaseNow: Date; rollbackRecordPresent: boolean };
type LeaseHandle = { deploymentId: string; leaseId: string; capability: string; fence: number };
type AcrIdentity = { acrName: string; acrServer: string };
type RecoveryEvidence = { stage: typeof RECOVERY_STAGES[number]; code: string };
type ReleaseProvenance = ReturnType<typeof releaseProvenance>;
type AcquisitionProof = Readonly<{ provenance: ReleaseProvenance | null; targetDigest: string | null; recoveryAuthorityDigest: string | null }>;
type RollbackEnvelope = Readonly<{ provenance: ReleaseProvenance | null; leaseId: string; fence: number; payload: Readonly<ManagedAzureRollbackPayload> }>;
type ManagedReleaseLeaseTarget = Readonly<{
  deploymentId: string; leaseId: string; fence: number; phase: typeof ACTIVE_PHASES[number];
  release: Readonly<{ baselineImageTag: string; baselineVersion: string | null; target:
    | Readonly<{ kind: "FORWARD"; imageTag: string; version: string }>
    | Readonly<{ kind: "ROLLBACK"; imageTag: string; rollbackArchiveId: string }> }>;
  deployment: ReturnType<typeof managedAzureReleaseDeployment>;
  authorityDigest: string;
  origin: string;
  target: Readonly<{ subscriptionId: string; resourceGroup: string; acrName: string; acrServer: string; webAppName: string; workerAppName: string }>;
}>;
function reject(code: string, status = 409): never {
  throw new AppError(status, code, "Managed release lease request was rejected.");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function requireInput(condition: unknown): asserts condition {
  if (!condition) reject("MANAGED_RELEASE_INVALID_INPUT", 400);
}
function hasEnumerablePrototypeField(prototype: object) {
  try {
    return Reflect.ownKeys(prototype).some((key) => Object.getOwnPropertyDescriptor(prototype, key)!.enumerable);
  } catch { return true; }
}
function validateHandle(handle: LeaseHandle) {
  requireInput(handle && typeof handle === "object" && !Array.isArray(handle));
  requireInput(typeof handle.deploymentId === "string" && UUID.test(handle.deploymentId));
  requireInput(typeof handle.leaseId === "string" && UUID.test(handle.leaseId));
  requireInput(typeof handle.capability === "string" && handle.capability.length > 0 && handle.capability.length <= 512);
  requireInput(Number.isSafeInteger(handle.fence) && handle.fence > 0 && handle.fence <= MAX_INT);
}
function validateRecoveryEvidence(value: RecoveryEvidence) {
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_INVALID_INPUT", 400));
  const raw = reader.exactRecord(value, ["stage", "code"] as const);
  const stage = reader.enumString(raw.stage, RECOVERY_STAGES);
  requireInput(typeof raw.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(raw.code));
  return Object.freeze({ stage, code: raw.code });
}
function diagnosticOperationId(leaseId: string, gitSha: string, purpose: string) {
  const value = createHash("sha256").update(`${purpose}:${leaseId}:${gitSha}`).digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = (8 + (Number.parseInt(value[16]!, 16) % 4)).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function imageDigest(image: string) {
  const matched = /@(sha256:[0-9a-f]{64})$/.exec(image);
  if (!matched) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  return matched[1]!;
}
function validateRollbackAcceptanceEvidence(value: unknown, row: CustomerDeployment, envelope: RollbackEnvelope) {
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_INVALID_INPUT", 400));
  const raw = reader.exactRecord(value, ["gitSha", "imageTag", "releaseVersion", "webDigest", "workerDigest", "operationId", "acceptanceEvidenceDigest"] as const);
  const gitSha = reader.gitSha(raw.gitSha);
  const accepted = {
    gitSha,
    imageTag: reader.imageTag(raw.imageTag, gitSha),
    releaseVersion: reader.version(raw.releaseVersion),
    webDigest: reader.digest(raw.webDigest),
    workerDigest: reader.digest(raw.workerDigest),
    operationId: reader.uuid(raw.operationId),
    acceptanceEvidenceDigest: reader.digest(raw.acceptanceEvidenceDigest),
  };
  const previous = envelope.payload.previous;
  if (accepted.imageTag !== row.releaseImageTag || accepted.releaseVersion !== row.releaseVersion
    || accepted.releaseVersion !== previous.releaseVersion
    || accepted.webDigest !== imageDigest(previous.web.image) || accepted.workerDigest !== imageDigest(previous.worker.image)
    || accepted.operationId !== diagnosticOperationId(envelope.leaseId, accepted.gitSha, "baseline-rollback")) {
    reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  }
  return Object.freeze(accepted);
}
function targetInputs(handle: LeaseHandle, acrIdentity: AcrIdentity) {
  requireInput(!hasEnumerablePrototypeField(Object.prototype) && !hasEnumerablePrototypeField(Array.prototype));
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_INVALID_INPUT", 400));
  const rawHandle = reader.exactRecord(handle, ["deploymentId", "leaseId", "capability", "fence"] as const);
  const rawAcr = reader.exactRecord(acrIdentity, ["acrName", "acrServer"] as const);
  const exactHandle = {
    deploymentId: reader.uuid(rawHandle.deploymentId),
    leaseId: reader.uuid(rawHandle.leaseId),
    capability: rawHandle.capability,
    fence: reader.integer(rawHandle.fence, 1, MAX_INT),
  };
  requireInput(UUID.test(exactHandle.deploymentId) && UUID.test(exactHandle.leaseId));
  requireInput(typeof exactHandle.capability === "string");
  validateHandle(exactHandle as LeaseHandle);
  const acrName = reader.azureAcrName(rawAcr.acrName);
  return { handle: exactHandle as LeaseHandle, acrIdentity: {
    acrName,
    acrServer: reader.azureAcrServer(rawAcr.acrServer, acrName),
  } };
}
function canonicalOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  let parsed: URL;
  try { parsed = new URL(value); } catch { reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== "/" || parsed.search || parsed.hash
    || (value !== parsed.origin && value !== `${parsed.origin}/`)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  return parsed.origin;
}
function azureDeploymentAppName(reader: ReturnType<typeof createManagedReleaseProofReader>, value: unknown, subscriptionId: string, resourceGroup: string) {
  if (typeof value !== "string") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const resourceId = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([A-Za-z0-9][A-Za-z0-9_.()-]*)\/providers\/Microsoft\.App\/containerApps\/([a-z][a-z0-9-]*[a-z0-9])$/i.exec(value);
  if (resourceId) {
    if (reader.uuid(resourceId[1]!.toLowerCase()) !== subscriptionId) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (reader.azureResourceGroup(resourceId[2]).toLowerCase() !== resourceGroup.toLowerCase()) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    return reader.azureAppName(resourceId[3]);
  }
  return reader.azureAppName(value);
}
function projectedDeploymentTarget(row: CustomerDeployment) {
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
  const subscriptionId = reader.uuid(typeof row.providerSubscriptionId === "string"
    ? row.providerSubscriptionId.toLowerCase() : row.providerSubscriptionId);
  const resourceGroup = reader.azureResourceGroup(row.providerResourceGroup);
  return {
    subscriptionId,
    resourceGroup,
    webAppName: azureDeploymentAppName(reader, row.providerWebServiceId, subscriptionId, resourceGroup),
    workerAppName: azureDeploymentAppName(reader, row.providerWorkerServiceId, subscriptionId, resourceGroup),
  };
}
function deploymentView(reader: ReturnType<typeof createManagedReleaseProofReader>, row: CustomerDeployment, workloadClass: string) {
  return reader.exactRecord(managedAzureReleaseDeployment(row, workloadClass), ["deploymentId", "deploymentKind", "cloudProvider", "environment", "deploymentStatus", "provisioningStatus", "releaseEligible", "provider", "group", "workload", "workloadClass"] as const);
}
function targetView(row: LockedDeployment, acrIdentity: AcrIdentity) {
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
  if (!row.releaseImageTag || !IMAGE_TAG.test(row.releaseImageTag)
    || row.releaseLeaseExpectedImageTag !== row.releaseImageTag
    || !row.releaseLeaseIncomingImageTag || !IMAGE_TAG.test(row.releaseLeaseIncomingImageTag)
    || row.releaseLeaseIncomingImageTag === row.releaseImageTag
    || !row.releaseLeasePhase || !ACTIVE_PHASES.includes(row.releaseLeasePhase)
    || !row.providerSubscriptionId || !UUID.test(row.providerSubscriptionId.toLowerCase())) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const baselineVersion = row.releaseVersion === null ? null : reader.version(row.releaseVersion);
  const incomingVersion = row.releaseLeaseIncomingVersion;
  if (typeof incomingVersion !== "string") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const rollback = ROLLBACK_RESERVATION.exec(incomingVersion);
  const releaseTarget = rollback
    ? reader.exactRecord({ kind: "ROLLBACK", imageTag: row.releaseLeaseIncomingImageTag,
      rollbackArchiveId: rollback[1]! }, ["kind", "imageTag", "rollbackArchiveId"] as const)
    : reader.exactRecord({ kind: "FORWARD", imageTag: row.releaseLeaseIncomingImageTag,
      version: reader.version(incomingVersion) }, ["kind", "imageTag", "version"] as const);
  const { subscriptionId, resourceGroup, webAppName, workerAppName } = projectedDeploymentTarget(row);
  if (webAppName === workerAppName) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  if (row.rollbackRecordPresent) {
    const payload = storedRollbackPayload(row);
    if (payload.target.acrName !== acrIdentity.acrName || payload.target.acrServer !== acrIdentity.acrServer) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  } else if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  // Before an envelope exists this remains a caller assertion; provider proof is a separate runner preflight.
  const release = reader.exactRecord({ baselineImageTag: row.releaseImageTag, baselineVersion,
    target: releaseTarget }, ["baselineImageTag", "baselineVersion", "target"] as const);
  const target = reader.exactRecord({ subscriptionId, resourceGroup, acrName: acrIdentity.acrName,
    acrServer: acrIdentity.acrServer, webAppName, workerAppName },
  ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
  return reader.deepFreeze(reader.exactRecord({ deploymentId: row.id, leaseId: row.releaseLeaseId!,
    fence: row.releaseLeaseFence, phase: row.releaseLeasePhase, release, deployment: deploymentView(reader, row, "ACTIVE_CLIENT_PRIMARY"), authorityDigest: sha256(JSON.stringify(releaseProvenance(row))), origin: canonicalOrigin(row.url), target },
  ["deploymentId", "leaseId", "fence", "phase", "release", "deployment", "authorityDigest", "origin", "target"] as const)) as ManagedReleaseLeaseTarget;
}
function rollbackTargetMatches(row: CustomerDeployment, payload: Readonly<ManagedAzureRollbackPayload>) {
  const { subscriptionId, resourceGroup, webAppName, workerAppName } = projectedDeploymentTarget(row);
  return subscriptionId === payload.target.subscriptionId
    && resourceGroup === payload.target.resourceGroup
    && webAppName === payload.target.webAppName
    && workerAppName === payload.target.workerAppName
    && row.releaseVersion === payload.previous.releaseVersion;
}
function assertProtectedApprovalBinding(row: CustomerDeployment, payload: Readonly<ManagedAzureRollbackPayload>) {
  if (row.deploymentKind !== "HOSTED_DEDICATED") return;
  const target = assertManagedAzureTargetBinding(row, payload.target);
  if (payload.schemaVersion !== 2 || row.releaseLeaseIncomingImageTag !== `sha-${target!.releaseApproval.gitSha}`
    || payload.incoming.schemaApprovalDigest !== `sha256:${target!.releaseApproval.schemaApprovalDigest}`
    || payload.compatibleRecovery.gitSha !== target!.recovery.gitSha
    || payload.compatibleRecovery.imageTag !== `sha-${target!.recovery.gitSha}`
    || payload.compatibleRecovery.releaseVersion !== target!.recovery.releaseVersion
    || payload.compatibleRecovery.schemaCompatibilityApprovalDigest !== `sha256:${target!.recovery.schemaCompatibilityApprovalDigest}`
    || payload.compatibleRecovery.activationPolicy !== target!.activationPolicy) {
    reject("MANAGED_RELEASE_TARGET_CONFIG_CONFLICT");
  }
}
function storedRollbackEnvelope(row: CustomerDeployment) {
  const value = row.releaseLeaseRollbackRecord;
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const envelopeKeys = record.version === 2 ? new Set([...ROLLBACK_ENVELOPE_KEYS, "provenance"]) : ROLLBACK_ENVELOPE_KEYS;
  if (keys.length !== envelopeKeys.size || keys.some((key) => !envelopeKeys.has(key))
    || (record.version !== 1 && record.version !== 2) || record.deploymentId !== row.id
    || typeof record.leaseId !== "string" || !UUID.test(record.leaseId)
    || !Number.isSafeInteger(record.fence) || (record.fence as number) < 1 || (record.fence as number) > MAX_INT
    || record.expectedImageTag !== row.releaseLeaseExpectedImageTag
    || record.incomingImageTag !== row.releaseLeaseIncomingImageTag || record.incomingVersion !== row.releaseLeaseIncomingVersion) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const currentLease = record.leaseId === row.releaseLeaseId && record.fence === row.releaseLeaseFence;
  const originatingRecoveryLease = row.releaseLeasePhase === "RECOVERY_REQUIRED" && (record.fence as number) <= row.releaseLeaseFence;
  if (!currentLease && !originatingRecoveryLease) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  let payload: Readonly<ManagedAzureRollbackPayload>;
  try { payload = canonicalizeManagedAzureRollbackPayload(record.payload); } catch { reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
  if (!rollbackTargetMatches(row, payload)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const provenance = record.version === 2 ? record.provenance as ReleaseProvenance : null;
  if (record.version === 2) assertProvenance(row, provenance, true);
  return { leaseId: record.leaseId, fence: record.fence as number, payload, provenance } satisfies RollbackEnvelope;
}
function storedRollbackPayload(row: CustomerDeployment) {
  return storedRollbackEnvelope(row).payload;
}
function originatingLeaseFromEvent(row: CustomerDeployment, event: CustomerDeploymentEvent) {
  if (!event.meta || typeof event.meta !== "object" || Array.isArray(event.meta)) return null;
  const meta = event.meta as Record<string, unknown>;
  if (meta.expectedImageTag !== row.releaseLeaseExpectedImageTag
    || meta.incomingImageTag !== row.releaseLeaseIncomingImageTag
    || meta.incomingVersion !== row.releaseLeaseIncomingVersion
    || typeof meta.leaseId !== "string" || !UUID.test(meta.leaseId)
    || !Number.isSafeInteger(meta.fence) || (meta.fence as number) < 1 || (meta.fence as number) > row.releaseLeaseFence) return null;
  return { leaseId: meta.leaseId, fence: meta.fence as number };
}
async function originatingRollbackEnvelope(tx: Prisma.TransactionClient, row: CustomerDeployment) {
  const envelope = storedRollbackEnvelope(row);
  if (row.releaseLeasePhase !== "RECOVERY_REQUIRED") return envelope;
  const events = await tx.customerDeploymentEvent.findMany({
    where: { deploymentId: row.id, action: ORIGINATING_LEASE_EVENT_ACTION },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const origin = events.map((eventRecord) => originatingLeaseFromEvent(row, eventRecord)).find(Boolean);
  return origin ? { ...envelope, leaseId: origin.leaseId, fence: origin.fence } satisfies RollbackEnvelope : envelope;
}
function rollbackEnvelope(
  row: CustomerDeployment,
  payload: Readonly<ManagedAzureRollbackPayload>,
  leaseId = row.releaseLeaseId!,
  fence = row.releaseLeaseFence,
  provenance: ReleaseProvenance | null = null,
) {
  return {
    version: provenance ? 2 : 1,
    ...(provenance ? { provenance } : {}),
    deploymentId: row.id,
    leaseId,
    fence,
    expectedImageTag: row.releaseLeaseExpectedImageTag!,
    incomingImageTag: row.releaseLeaseIncomingImageTag!,
    incomingVersion: row.releaseLeaseIncomingVersion!,
    payload,
  };
}
async function lock(tx: Prisma.TransactionClient, deploymentId: string) {
  const [row] = await tx.$queryRaw<LockedDeployment[]>`SELECT *, ("releaseLeaseRollbackRecord" IS NOT NULL) AS "rollbackRecordPresent" FROM "CustomerDeployment" WHERE "id" = ${deploymentId} FOR UPDATE`;
  if (!row) reject("MANAGED_RELEASE_DEPLOYMENT_NOT_FOUND", 404);
  const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`SELECT clock_timestamp() AS "databaseNow"`;
  return { ...row, ...clock };
}
function eligible(row: CustomerDeployment) {
  return managedAzureReleaseEligible(row);
}
const readOnlyPreflightEligible = managedAzureReleaseEligible;

function releaseProvenance(row: CustomerDeployment) {
  return {
    deploymentKind: row.deploymentKind,
    identity: {
      deploymentId: row.id, customerAccountId: row.customerAccountId,
      origin: canonicalOrigin(row.url), cloudProvider: row.cloudProvider, environment: row.environment,
      managedWorkspaceId: row.managedWorkspaceId, remoteWorkspaceId: row.remoteWorkspaceId,
      remoteWorkspaceSlug: row.remoteWorkspaceSlug, target: projectedDeploymentTarget(row),
      providerEnvironmentId: row.providerEnvironmentId, providerProjectId: row.providerProjectId,
      providerPostgresServiceId: row.providerPostgresServiceId, providerRedisServiceId: row.providerRedisServiceId,
      providerStorageResourceId: row.providerStorageResourceId, storageBucketName: row.storageBucketName,
    },
  };
}
function assertProvenance(row: CustomerDeployment, provenance: ReleaseProvenance | null, recovery: boolean) {
  if (!provenance || !["REMOTE_MANAGED", "HOSTED_DEDICATED"].includes(provenance.deploymentKind)
    || Object.keys(provenance).length !== 2
    || !isDeepStrictEqual(provenance.identity, releaseProvenance(row).identity)) reject("MANAGED_RELEASE_PROVENANCE_CONFLICT");
  if (!recovery && provenance.deploymentKind !== row.deploymentKind) reject("MANAGED_RELEASE_FORWARD_NOT_ALLOWED");
}
async function acquisitionProof(tx: Prisma.TransactionClient, row: CustomerDeployment): Promise<AcquisitionProof> {
  const record = await tx.customerDeploymentEvent.findFirst({
    where: { deploymentId: row.id,
      action: { in: ["control_plane.release_lease.acquired", "control_plane.release_lease.reservation_replaced", "control_plane.release_lease.recovery_claimed"] },
      AND: [{ meta: { path: ["leaseId"], equals: row.releaseLeaseId! } }, { meta: { path: ["fence"], equals: row.releaseLeaseFence } }],
    }, orderBy: { createdAt: "desc" },
  });
  const meta = record?.meta as Record<string, unknown> | null;
  if (meta && meta.owner !== row.releaseLeaseOwner) reject("MANAGED_RELEASE_PROVENANCE_CONFLICT");
  return {
    provenance: meta?.provenance as ReleaseProvenance | null ?? null,
    targetDigest: typeof meta?.targetDigest === "string" && SHA256.test(meta.targetDigest) ? meta.targetDigest : null,
    recoveryAuthorityDigest: typeof meta?.recoveryAuthorityDigest === "string" && SHA256.test(meta.recoveryAuthorityDigest)
      ? meta.recoveryAuthorityDigest : null,
  };
}
async function requireAdmission(tx: Prisma.TransactionClient, row: LockedDeployment, recovery = false) {
  if (!activeManagedAzureDeployment(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
  if (row.deploymentKind === "HOSTED_DEDICATED") await requireManagedAzureAccountAuthority(tx, row);
  const proof = await acquisitionProof(tx, row);
  const provenance = proof.provenance;
  if (provenance) assertProvenance(row, provenance, recovery);
  const envelope = row.rollbackRecordPresent ? storedRollbackEnvelope(row) : null;
  if (envelope?.provenance) assertProvenance(row, envelope.provenance, recovery);
  if (!provenance && (row.deploymentKind !== "REMOTE_MANAGED" || envelope?.provenance)) reject("MANAGED_RELEASE_PROVENANCE_CONFLICT");
  if (recovery) {
    // Historical V1 remote leases stay readable, but cannot grant a hosted exemption.
    if (!envelope?.provenance && !provenance && !eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
  } else if (!eligible(row)) reject("MANAGED_RELEASE_FORWARD_NOT_ALLOWED");
  await assertNoTargetOverlap(tx, row);
  if (row.deploymentKind === "HOSTED_DEDICATED") {
    const target = assertManagedAzureTargetBinding(row);
    const protectedDigest = recovery ? proof.recoveryAuthorityDigest : proof.targetDigest;
    if (!protectedDigest) reject("MANAGED_RELEASE_PROVENANCE_CONFLICT");
    const currentDigest = recovery ? managedAzureRecoveryAuthorityDigest(target!) : managedAzureTargetDigest(target!);
    if (currentDigest !== protectedDigest) reject("MANAGED_RELEASE_TARGET_CONFIG_CONFLICT");
  } else if (!recovery) assertManagedAzureTargetBinding(row);
  return proof;
}
async function owned(tx: Prisma.TransactionClient, handle: LeaseHandle, allowExpired = false) {
  validateHandle(handle);
  const row = await lock(tx, handle.deploymentId);
  const matches = row.releaseLeaseId === handle.leaseId && row.releaseLeaseTokenHash === sha256(handle.capability) && row.releaseLeaseFence === handle.fence;
  if (!matches) reject("MANAGED_RELEASE_LEASE_CONFLICT");
  if (!allowExpired && (!row.releaseLeaseExpiresAt || row.releaseLeaseExpiresAt <= row.databaseNow)) reject("MANAGED_RELEASE_LEASE_EXPIRED");
  return row;
}
async function transact<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await prisma.$transaction(operation);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") reject("MANAGED_RELEASE_LEASE_CONFLICT");
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2004") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    throw error;
  }
}
function view(row: LockedDeployment) {
  return { deploymentId: row.id, leaseId: row.releaseLeaseId!, fence: row.releaseLeaseFence, phase: row.releaseLeasePhase!, expiresAt: row.releaseLeaseExpiresAt! };
}
async function event(tx: Prisma.TransactionClient, row: LockedDeployment, action: string, extra: Record<string, unknown> = {}) {
  await tx.customerDeploymentEvent.create({
    data: {
      deploymentId: row.id,
      action,
      meta: {
        ...extra,
        leaseId: row.releaseLeaseId,
        fence: row.releaseLeaseFence,
        owner: row.releaseLeaseOwner,
        expectedImageTag: row.releaseLeaseExpectedImageTag,
        incomingImageTag: row.releaseLeaseIncomingImageTag,
        incomingVersion: row.releaseLeaseIncomingVersion,
        ...(["control_plane.release_lease.acquired", "control_plane.release_lease.reservation_replaced", "control_plane.release_lease.recovery_claimed"].includes(action) ? { provenance: releaseProvenance(row) } : {}),
      },
    },
  });
}
function clearLeaseData() {
  return {
    releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null, releaseLeaseExpectedImageTag: null,
    releaseLeaseIncomingImageTag: null, releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null,
    releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: Prisma.DbNull,
    releaseLeaseRecoveryEvidence: Prisma.DbNull, releaseLeaseError: null,
  } as const;
}

async function assertNoTargetOverlap(tx: Prisma.TransactionClient, row: CustomerDeployment) {
  const target = projectedDeploymentTarget(row);
  const targetResourcePrefix = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/`;
  const fullWebId = `${targetResourcePrefix}${target.webAppName}`;
  const fullWorkerId = `${targetResourcePrefix}${target.workerAppName}`;
  const candidates = await tx.$queryRaw<CustomerDeployment[]>`
    SELECT * FROM "CustomerDeployment"
    WHERE "id" <> ${row.id}
      AND (
        (lower(COALESCE("providerSubscriptionId", '')) = lower(${target.subscriptionId})
          AND lower(COALESCE("providerResourceGroup", '')) = lower(${target.resourceGroup}))
        OR lower(COALESCE("providerWebServiceId", '')) IN (lower(${fullWebId}), lower(${fullWorkerId}))
        OR lower(COALESCE("providerWorkerServiceId", '')) IN (lower(${fullWebId}), lower(${fullWorkerId}))
      )
  `;
  for (const candidate of candidates) {
    const sameCoordinates = candidate.providerSubscriptionId?.toLowerCase() === target.subscriptionId.toLowerCase()
      && candidate.providerResourceGroup?.toLowerCase() === target.resourceGroup.toLowerCase();
    const candidateTarget = sameCoordinates ? projectedDeploymentTarget(candidate) : null;
    const identities = candidateTarget
      ? [candidateTarget.webAppName, candidateTarget.workerAppName].map((appName) => ({
        subscriptionId: target.subscriptionId.toLowerCase(), resourceGroup: target.resourceGroup.toLowerCase(), appName,
      }))
      : [candidate.providerWebServiceId, candidate.providerWorkerServiceId].map((value) => {
        const matched = typeof value === "string"
          ? /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([^/]+)$/i.exec(value)
          : null;
        return matched ? { subscriptionId: matched[1]!.toLowerCase(), resourceGroup: matched[2]!.toLowerCase(), appName: matched[3]!.toLowerCase() } : null;
      }).filter((value): value is { subscriptionId: string; resourceGroup: string; appName: string } => value !== null);
    if (identities.some((identity) => identity.subscriptionId === target.subscriptionId.toLowerCase()
      && identity.resourceGroup === target.resourceGroup.toLowerCase()
      && (identity.appName === target.webAppName || identity.appName === target.workerAppName))) {
      reject("MANAGED_RELEASE_TARGET_OVERLAP");
    }
  }
}

export async function getManagedReleaseTargetPreflight(deploymentId: string, acrIdentity: AcrIdentity, workloadClass = "ACTIVE_CLIENT_PRIMARY") {
  requireInput(typeof deploymentId === "string" && UUID.test(deploymentId));
  requireInput(workloadClass === "ACTIVE_CLIENT_PRIMARY" || workloadClass === "ACTIVE_CLIENT_CANARY");
  const input = targetInputs({ deploymentId, leaseId: "00000000-0000-4000-8000-000000000000", capability: "preflight", fence: 1 }, acrIdentity);
  return transact(async (tx) => {
    const row = await lock(tx, deploymentId);
    if (!readOnlyPreflightEligible(row, workloadClass)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY" && row.deploymentKind === "HOSTED_DEDICATED") {
      await requireManagedAzureAccountAuthority(tx, row);
    }
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY") assertManagedAzureTargetBinding(row, input.acrIdentity);
    if (row.releaseLeaseId && (row.releaseLeasePhase !== "RESERVED" || row.releaseLeaseExpiresAt! > row.databaseNow)) {
      reject(row.releaseLeasePhase === "RESERVED" ? "MANAGED_RELEASE_LEASE_CONFLICT" : "MANAGED_RELEASE_RECOVERY_REQUIRED");
    }
    await assertNoTargetOverlap(tx, row);
    const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
    if (!row.releaseImageTag || !IMAGE_TAG.test(row.releaseImageTag) || !row.providerSubscriptionId
      || !UUID.test(row.providerSubscriptionId.toLowerCase())) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const acrName = reader.azureAcrName(input.acrIdentity.acrName);
    const { subscriptionId, resourceGroup, webAppName, workerAppName } = projectedDeploymentTarget(row);
    const target = reader.exactRecord({
      subscriptionId,
      resourceGroup,
      acrName,
      acrServer: reader.azureAcrServer(input.acrIdentity.acrServer, acrName),
      webAppName,
      workerAppName,
    }, ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
    if (target.webAppName === target.workerAppName) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const release = reader.exactRecord({
      baselineImageTag: row.releaseImageTag,
      baselineVersion: row.releaseVersion === null ? null : reader.version(row.releaseVersion),
    }, ["baselineImageTag", "baselineVersion"] as const);
    return reader.deepFreeze(reader.exactRecord({ deploymentId: row.id, deployment: deploymentView(reader, row, workloadClass), authorityDigest: sha256(JSON.stringify(releaseProvenance(row))), origin: canonicalOrigin(row.url), release, target },
      ["deploymentId", "deployment", "authorityDigest", "origin", "release", "target"] as const));
  });
}

export async function getManagedReleaseBootstrapTarget(deploymentId: string, acrIdentity: AcrIdentity, workloadClass = "ACTIVE_CLIENT_PRIMARY") {
  requireInput(typeof deploymentId === "string" && UUID.test(deploymentId));
  requireInput(workloadClass === "ACTIVE_CLIENT_PRIMARY" || workloadClass === "ACTIVE_CLIENT_CANARY");
  const input = targetInputs({ deploymentId, leaseId: "00000000-0000-4000-8000-000000000000", capability: "bootstrap", fence: 1 }, acrIdentity);
  return transact(async (tx) => {
    const row = await lock(tx, deploymentId);
    if (!readOnlyPreflightEligible(row, workloadClass)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY" && row.deploymentKind === "HOSTED_DEDICATED") {
      await requireManagedAzureAccountAuthority(tx, row);
    }
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY") assertManagedAzureTargetBinding(row, input.acrIdentity);
    if (row.releaseLeaseId && (row.releaseLeasePhase !== "RESERVED" || row.releaseLeaseExpiresAt! > row.databaseNow)) {
      reject(row.releaseLeasePhase === "RESERVED" ? "MANAGED_RELEASE_LEASE_CONFLICT" : "MANAGED_RELEASE_RECOVERY_REQUIRED");
    }
    await assertNoTargetOverlap(tx, row);
    const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
    if (!row.providerSubscriptionId || !UUID.test(row.providerSubscriptionId.toLowerCase())) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const acrName = reader.azureAcrName(input.acrIdentity.acrName);
    const { subscriptionId, resourceGroup, webAppName, workerAppName } = projectedDeploymentTarget(row);
    const target = reader.exactRecord({
      subscriptionId,
      resourceGroup,
      acrName,
      acrServer: reader.azureAcrServer(input.acrIdentity.acrServer, acrName),
      webAppName,
      workerAppName,
    }, ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
    if (target.webAppName === target.workerAppName) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    return reader.deepFreeze(reader.exactRecord({ deploymentId: row.id, deployment: deploymentView(reader, row, workloadClass), authorityDigest: sha256(JSON.stringify(releaseProvenance(row))), origin: canonicalOrigin(row.url), target },
      ["deploymentId", "deployment", "authorityDigest", "origin", "target"] as const));
  });
}

export async function acquireManagedReleaseLease(params: { deploymentId: string; expectedImageTag: string; incomingImageTag: string; incomingVersion: string; owner: string; expectedTargetDigest?: string }) {
  requireInput(params && typeof params === "object" && !Array.isArray(params));
  requireInput(typeof params.deploymentId === "string" && UUID.test(params.deploymentId));
  requireInput(typeof params.expectedImageTag === "string" && IMAGE_TAG.test(params.expectedImageTag));
  requireInput(typeof params.incomingImageTag === "string" && IMAGE_TAG.test(params.incomingImageTag) && params.incomingImageTag !== params.expectedImageTag);
  requireInput(typeof params.incomingVersion === "string" && params.incomingVersion.trim().length > 0 && params.incomingVersion.length <= 128 && !/[\u0000-\u001f\u007f]/.test(params.incomingVersion) && !POSTGRES_UNSAFE_STRING.test(params.incomingVersion));
  requireInput(typeof params.owner === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(params.owner));
  requireInput(params.expectedTargetDigest === undefined || (typeof params.expectedTargetDigest === "string" && SHA256.test(params.expectedTargetDigest)));
  return transact(async (tx) => {
    const row = await lock(tx, params.deploymentId);
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    await assertNoTargetOverlap(tx, row);
    let targetDigest: string | null = null;
    let recoveryAuthorityDigest: string | null = null;
    if (row.deploymentKind === "HOSTED_DEDICATED") {
      await requireManagedAzureAccountAuthority(tx, row);
      const target = assertManagedAzureTargetBinding(row);
      targetDigest = managedAzureTargetDigest(target!);
      recoveryAuthorityDigest = managedAzureRecoveryAuthorityDigest(target!);
      if (params.expectedTargetDigest !== targetDigest) reject("MANAGED_RELEASE_TARGET_CONFIG_CONFLICT");
    } else {
      requireInput(params.expectedTargetDigest === undefined);
      assertManagedAzureTargetBinding(row);
    }
    if (row.releaseLeaseId && row.releaseLeaseExpiresAt! > row.databaseNow) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    if (row.releaseLeaseId && row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_RECOVERY_REQUIRED");
    if (row.releaseImageTag !== params.expectedImageTag) reject("MANAGED_RELEASE_BASELINE_CONFLICT");
    if (row.releaseLeaseFence >= MAX_INT) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    const capability = randomOpaqueToken(32);
    const replaced = Boolean(row.releaseLeaseId);
    const leaseId = randomUUID();
    const fence = row.releaseLeaseFence + 1;
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: {
      releaseLeaseFence: fence, releaseLeaseId: leaseId, releaseLeaseTokenHash: sha256(capability), releaseLeaseOwner: params.owner,
      releaseLeaseExpectedImageTag: params.expectedImageTag, releaseLeaseIncomingImageTag: params.incomingImageTag, releaseLeaseIncomingVersion: params.incomingVersion,
      releaseLeasePhase: "RESERVED", releaseLeaseAcquiredAt: row.databaseNow, releaseLeaseHeartbeatAt: row.databaseNow, releaseLeaseExpiresAt: expiresAt,
      releaseLeaseRollbackRecord: Prisma.DbNull, releaseLeaseRecoveryEvidence: Prisma.DbNull, releaseLeaseError: null,
    } }) as LockedDeployment;
    await event(tx, updated, replaced ? "control_plane.release_lease.reservation_replaced" : "control_plane.release_lease.acquired",
      targetDigest && recoveryAuthorityDigest ? { targetDigest, recoveryAuthorityDigest } : {});
    return { ...view({ ...updated, databaseNow: row.databaseNow }), capability };
  });
}

export async function heartbeatManagedReleaseLease(handle: LeaseHandle, recovery = false) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    await requireAdmission(tx, row, recovery);
    if (!row.releaseLeasePhase || !ACTIVE_PHASES.includes(row.releaseLeasePhase)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (row.rollbackRecordPresent) storedRollbackPayload(row);
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const result = await tx.customerDeployment.updateMany({ where: {
      id: row.id, releaseLeaseId: handle.leaseId, releaseLeaseTokenHash: sha256(handle.capability), releaseLeaseFence: handle.fence,
      releaseLeaseExpiresAt: { gt: row.databaseNow }, releaseLeasePhase: { in: [...ACTIVE_PHASES] },
    }, data: { releaseLeaseHeartbeatAt: row.databaseNow, releaseLeaseExpiresAt: expiresAt } });
    if (result.count !== 1) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    return { ...view(row), expiresAt };
  });
}

export async function getManagedReleaseLeaseTarget(handle: LeaseHandle, acrIdentity: AcrIdentity) {
  const input = targetInputs(handle, acrIdentity);
  return transact(async (tx) => {
    const row = await owned(tx, input.handle);
    const proof = await requireAdmission(tx, row);
    assertManagedAzureTargetBinding(row, input.acrIdentity);
    const target = targetView(row, input.acrIdentity);
    return proof.targetDigest ? Object.freeze({ ...target, targetDigest: proof.targetDigest }) : target;
  });
}

export async function getManagedReleaseRollbackRecord(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    await requireAdmission(tx, row, true);
    if (!row.rollbackRecordPresent) reject("MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    return storedRollbackPayload(row);
  });
}

async function completedCompatibleRecoveryReceipt(
  tx: Prisma.TransactionClient,
  row: LockedDeployment,
  acrIdentity: AcrIdentity,
) {
  const terminal = await tx.customerDeploymentEvent.findFirst({
    where: { deploymentId: row.id, action: "control_plane.release_lease.compatible_recovery_succeeded",
      meta: { path: ["fence"], equals: row.releaseLeaseFence } },
    orderBy: { createdAt: "desc" },
  });
  if (!terminal) return null;
  if (!activeManagedAzureDeployment(row) || row.deploymentKind !== "HOSTED_DEDICATED") reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
  await requireManagedAzureAccountAuthority(tx, row);
  await assertNoTargetOverlap(tx, row);
  const target = assertManagedAzureTargetBinding(row, acrIdentity);
  const meta = terminal.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
  const raw = reader.exactRecord(meta, ["schemaVersion", "leaseId", "fence", "originatingLeaseId", "originatingFence", "provenance",
    "targetDigest", "recoveryAuthorityDigest", "gitSha", "imageTag", "releaseVersion", "webDigest", "workerDigest",
    "approvalDigest", "acceptanceEvidenceDigest", "completedAt", "receiptDigest"] as const);
  if (raw.schemaVersion !== 1) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const gitSha = reader.gitSha(raw.gitSha);
  const imageTag = reader.imageTag(raw.imageTag, gitSha);
  const releaseVersion = reader.version(raw.releaseVersion);
  const leaseId = reader.uuid(raw.leaseId);
  const fence = reader.integer(raw.fence, 1, MAX_INT);
  const originatingLeaseId = reader.uuid(raw.originatingLeaseId);
  const originatingFence = reader.integer(raw.originatingFence, 1, fence);
  const targetDigest = reader.digest(raw.targetDigest).slice("sha256:".length);
  const recoveryAuthorityDigest = reader.digest(raw.recoveryAuthorityDigest).slice("sha256:".length);
  const webDigest = reader.digest(raw.webDigest);
  const workerDigest = reader.digest(raw.workerDigest);
  const approvalDigest = reader.digest(raw.approvalDigest);
  const acceptanceEvidenceDigest = reader.digest(raw.acceptanceEvidenceDigest);
  const receipt = { schemaVersion: 1, leaseId, fence, originatingLeaseId, originatingFence, provenance: raw.provenance,
    targetDigest: `sha256:${targetDigest}`, recoveryAuthorityDigest: `sha256:${recoveryAuthorityDigest}`,
    gitSha, imageTag, releaseVersion, webDigest, workerDigest, approvalDigest, acceptanceEvidenceDigest,
    completedAt: raw.completedAt };
  if (reader.digest(raw.receiptDigest) !== `sha256:${sha256(canonicalJson(receipt))}`) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  if (fence !== row.releaseLeaseFence || imageTag !== row.releaseImageTag || releaseVersion !== row.releaseVersion
    || typeof raw.completedAt !== "string" || row.lastReleaseCheck?.toISOString() !== raw.completedAt
    || recoveryAuthorityDigest !== managedAzureRecoveryAuthorityDigest(target!)
    || gitSha !== target!.recovery.gitSha || imageTag !== `sha-${target!.recovery.gitSha}`
    || releaseVersion !== target!.recovery.releaseVersion
    || approvalDigest !== `sha256:${target!.recovery.schemaCompatibilityApprovalDigest}`) reject("MANAGED_RELEASE_TARGET_CONFIG_CONFLICT");
  assertProvenance(row, raw.provenance as ReleaseProvenance, true);
  return Object.freeze({ status: "RECOVERED_COMPATIBLE" as const, terminal: true as const, deploymentId: row.id,
    leaseId, fence, originatingLeaseId, originatingFence, targetDigest, recoveryAuthorityDigest,
    releaseImageTag: imageTag, releaseVersion, webDigest, workerDigest, approvalDigest, acceptanceEvidenceDigest });
}

export async function getManagedReleaseRecoveryStatus(deploymentId: string, acrIdentity: AcrIdentity) {
  requireInput(typeof deploymentId === "string" && UUID.test(deploymentId));
  const input = targetInputs({ deploymentId, leaseId: "00000000-0000-4000-8000-000000000000", capability: "recovery-status", fence: 1 }, acrIdentity);
  return transact(async (tx) => {
    const row = await lock(tx, deploymentId);
    if ((row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED") || !row.rollbackRecordPresent) {
      const completed = await completedCompatibleRecoveryReceipt(tx, row, input.acrIdentity);
      if (completed) return completed;
      reject("MANAGED_RELEASE_RECOVERY_REQUIRED");
    }
    await requireAdmission(tx, row, true);
    const target = targetView(row, input.acrIdentity);
    const rollbackRecord = await originatingRollbackEnvelope(tx, row);
    const recovery = row.releaseLeaseRecoveryEvidence && typeof row.releaseLeaseRecoveryEvidence === "object" && !Array.isArray(row.releaseLeaseRecoveryEvidence)
      ? validateRecoveryEvidence(row.releaseLeaseRecoveryEvidence as RecoveryEvidence)
      : null;
    return {
      deploymentId: row.id,
      leaseId: row.releaseLeaseId!,
      fence: row.releaseLeaseFence,
      phase: row.releaseLeasePhase,
      expiresAt: row.releaseLeaseExpiresAt!,
      recovery,
      rollbackRecorded: true,
      originatingLease: { leaseId: rollbackRecord.leaseId, fence: rollbackRecord.fence },
      release: target.release,
      origin: target.origin,
      target: target.target,
    };
  });
}

export async function recordManagedReleaseRollbackRecord(handle: LeaseHandle, payload: unknown) {
  const canonicalPayload = canonicalizeManagedAzureRollbackPayload(payload);
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    const proof = await requireAdmission(tx, row, false);
    assertManagedAzureTargetBinding(row, canonicalPayload.target);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (!rollbackTargetMatches(row, canonicalPayload)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    assertProtectedApprovalBinding(row, canonicalPayload);
    const envelope = rollbackEnvelope(row, canonicalPayload, row.releaseLeaseId!, row.releaseLeaseFence, proof.provenance);
    if (row.rollbackRecordPresent) {
      if (!isDeepStrictEqual(storedRollbackPayload(row), canonicalPayload)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
      return { ...view(row), rollbackRecorded: true };
    }
    await tx.customerDeployment.update({ where: { id: row.id }, data: { releaseLeaseRollbackRecord: envelope as unknown as Prisma.InputJsonValue } });
    await event(tx, row, "control_plane.release_lease.rollback_recorded");
    return { ...view(row), rollbackRecorded: true };
  });
}

export async function beginManagedReleaseMutation(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    await requireAdmission(tx, row, false);
    if (row.releaseLeasePhase === "MUTATING") { assertProtectedApprovalBinding(row, storedRollbackPayload(row)); return view(row); }
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (row.releaseImageTag !== row.releaseLeaseExpectedImageTag) reject("MANAGED_RELEASE_BASELINE_CONFLICT");
    if (!row.rollbackRecordPresent) reject("MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    assertProtectedApprovalBinding(row, storedRollbackPayload(row));
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: { releaseLeasePhase: "MUTATING", releaseLeaseHeartbeatAt: row.databaseNow, releaseLeaseExpiresAt: expiresAt } }) as LockedDeployment;
    await event(tx, updated, "control_plane.release_lease.mutation_begun");
    return { ...view({ ...updated, databaseNow: row.databaseNow }), expiresAt };
  });
}

export async function abortManagedReleaseLease(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle, true);
    await requireAdmission(tx, row, true);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    await event(tx, row, "control_plane.release_lease.aborted");
    return { deploymentId: row.id, fence: row.releaseLeaseFence, aborted: true };
  });
}

export async function finalizeManagedReleaseSuccess(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    await requireAdmission(tx, row, false);
    if (row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    storedRollbackPayload(row);
    if (!row.releaseLeaseIncomingImageTag || !row.releaseLeaseIncomingVersion || ROLLBACK_RESERVATION.test(row.releaseLeaseIncomingVersion)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const imageTag = row.releaseLeaseIncomingImageTag;
    const version = row.releaseLeaseIncomingVersion;
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    await tx.customerDeployment.update({ where: { id: row.id }, data: {
      releaseImageTag: imageTag,
      releaseVersion: version,
      lastReleaseCheck: row.databaseNow,
      lastHealthCheck: row.databaseNow,
      lastHealthStatus: "ok",
      lastHealthError: null,
    } });
    await event(tx, row, "control_plane.release_lease.succeeded");
    return { deploymentId: row.id, fence: row.releaseLeaseFence, status: "SUCCEEDED" as const, releaseImageTag: imageTag, releaseVersion: version };
  });
}

export async function finalizeManagedReleaseCompatibleRecovery(handle: LeaseHandle, evidence: unknown) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    const proof = await requireAdmission(tx, row, true);
    if (row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const envelope = await originatingRollbackEnvelope(tx, row);
    const payload = envelope.payload;
    if (payload.schemaVersion !== 2) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_INVALID_INPUT", 400));
    const raw = reader.exactRecord(evidence, ["gitSha", "imageTag", "releaseVersion", "webDigest", "workerDigest", "acceptanceEvidenceDigest"] as const);
    const accepted = { gitSha: reader.gitSha(raw.gitSha), imageTag: raw.imageTag, releaseVersion: raw.releaseVersion,
      webDigest: reader.digest(raw.webDigest), workerDigest: reader.digest(raw.workerDigest), acceptanceEvidenceDigest: reader.digest(raw.acceptanceEvidenceDigest) };
    const recovery = payload.compatibleRecovery;
    if (accepted.imageTag !== recovery.imageTag || accepted.gitSha !== recovery.gitSha || accepted.releaseVersion !== recovery.releaseVersion
      || accepted.webDigest !== recovery.web.digest || accepted.workerDigest !== recovery.worker.digest) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    await tx.customerDeployment.update({ where: { id: row.id }, data: { releaseImageTag: recovery.imageTag,
      releaseVersion: recovery.releaseVersion, lastReleaseCheck: row.databaseNow, lastHealthCheck: row.databaseNow,
      lastHealthStatus: "ok", lastHealthError: null } });
    const terminalReceipt = { schemaVersion: 1, leaseId: row.releaseLeaseId, fence: row.releaseLeaseFence,
      originatingLeaseId: envelope.leaseId, originatingFence: envelope.fence, provenance: envelope.provenance,
      targetDigest: proof.targetDigest ? `sha256:${proof.targetDigest}` : null,
      recoveryAuthorityDigest: proof.recoveryAuthorityDigest ? `sha256:${proof.recoveryAuthorityDigest}` : null,
      gitSha: recovery.gitSha, imageTag: recovery.imageTag, releaseVersion: recovery.releaseVersion,
      webDigest: recovery.web.digest, workerDigest: recovery.worker.digest,
      approvalDigest: recovery.schemaCompatibilityApprovalDigest, acceptanceEvidenceDigest: accepted.acceptanceEvidenceDigest,
      completedAt: row.databaseNow.toISOString() };
    await tx.customerDeploymentEvent.create({ data: { deploymentId: row.id, action: "control_plane.release_lease.compatible_recovery_succeeded",
      meta: { ...terminalReceipt, receiptDigest: `sha256:${sha256(canonicalJson(terminalReceipt))}` } } });
    return { deploymentId: row.id, fence: row.releaseLeaseFence, status: "RECOVERED_COMPATIBLE" as const,
      releaseImageTag: recovery.imageTag, releaseVersion: recovery.releaseVersion };
  });
}

export async function finalizeManagedReleaseRollback(handle: LeaseHandle, evidence?: unknown) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    await requireAdmission(tx, row, true);
    if (row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const envelope = await originatingRollbackEnvelope(tx, row);
    if (envelope.payload.schemaVersion === 2) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const accepted = evidence === undefined ? null : validateRollbackAcceptanceEvidence(evidence, row, envelope);
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    if (accepted) {
      await tx.customerDeploymentEvent.create({ data: { deploymentId: row.id, action: "control_plane.release_lease.rolled_back",
        meta: { leaseId: row.releaseLeaseId, fence: row.releaseLeaseFence, owner: row.releaseLeaseOwner,
          expectedImageTag: row.releaseLeaseExpectedImageTag, incomingImageTag: row.releaseLeaseIncomingImageTag,
          incomingVersion: row.releaseLeaseIncomingVersion, releaseImageTag: accepted.imageTag,
          releaseVersion: accepted.releaseVersion, webDigest: accepted.webDigest, workerDigest: accepted.workerDigest,
          diagnosticOperationId: accepted.operationId, acceptanceEvidenceDigest: accepted.acceptanceEvidenceDigest,
          originatingLeaseId: envelope.leaseId } } });
    } else {
      await event(tx, row, "control_plane.release_lease.rolled_back");
    }
    return { deploymentId: row.id, fence: row.releaseLeaseFence, status: "ROLLED_BACK" as const,
      releaseImageTag: row.releaseImageTag, releaseVersion: row.releaseVersion };
  });
}

export async function markManagedReleaseRecoveryRequired(handle: LeaseHandle, evidence: RecoveryEvidence) {
  const canonicalEvidence = validateRecoveryEvidence(evidence);
  return transact(async (tx) => {
    const row = await owned(tx, handle, true);
    await requireAdmission(tx, row, true);
    if (!row.releaseLeasePhase || !ACTIVE_PHASES.includes(row.releaseLeasePhase) || !row.rollbackRecordPresent) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    storedRollbackPayload(row);
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: {
      releaseLeasePhase: "RECOVERY_REQUIRED",
      releaseLeaseHeartbeatAt: row.databaseNow,
      releaseLeaseExpiresAt: expiresAt,
      releaseLeaseRecoveryEvidence: canonicalEvidence,
      releaseLeaseError: canonicalEvidence.code,
    } }) as LockedDeployment;
    await event(tx, updated, "control_plane.release_lease.recovery_required");
    return { ...view({ ...updated, databaseNow: row.databaseNow }), expiresAt, recovery: canonicalEvidence };
  });
}

export async function claimManagedReleaseRecovery(params: {
  deploymentId: string;
  expectedLeaseId: string;
  expectedFence: number;
  owner: string;
}) {
  requireInput(params && typeof params === "object" && !Array.isArray(params));
  requireInput(typeof params.deploymentId === "string" && UUID.test(params.deploymentId));
  requireInput(typeof params.expectedLeaseId === "string" && UUID.test(params.expectedLeaseId));
  requireInput(Number.isSafeInteger(params.expectedFence) && params.expectedFence > 0 && params.expectedFence < MAX_INT);
  requireInput(typeof params.owner === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(params.owner));
  return transact(async (tx) => {
    const row = await lock(tx, params.deploymentId);
    const proof = await requireAdmission(tx, row, true);
    if (row.releaseLeaseId !== params.expectedLeaseId || row.releaseLeaseFence !== params.expectedFence) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    if ((row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED")
      || !row.releaseLeaseExpiresAt || row.releaseLeaseExpiresAt > row.databaseNow || !row.rollbackRecordPresent) reject("MANAGED_RELEASE_RECOVERY_REQUIRED");
    const storedEnvelope = await originatingRollbackEnvelope(tx, row);
    const rollbackPayload = storedEnvelope.payload;
    const capability = randomOpaqueToken(32);
    const leaseId = randomUUID();
    const fence = row.releaseLeaseFence + 1;
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: {
      releaseLeaseFence: fence,
      releaseLeaseId: leaseId,
      releaseLeaseTokenHash: sha256(capability),
      releaseLeaseOwner: params.owner,
      releaseLeasePhase: "RECOVERY_REQUIRED",
      releaseLeaseAcquiredAt: row.databaseNow,
      releaseLeaseHeartbeatAt: row.databaseNow,
      releaseLeaseExpiresAt: expiresAt,
      releaseLeaseRollbackRecord: rollbackEnvelope(row, rollbackPayload, storedEnvelope.leaseId, storedEnvelope.fence, storedEnvelope.provenance) as unknown as Prisma.InputJsonValue,
    } }) as LockedDeployment;
    await event(tx, updated, "control_plane.release_lease.recovery_claimed", proof.targetDigest && proof.recoveryAuthorityDigest
      ? { targetDigest: proof.targetDigest, recoveryAuthorityDigest: proof.recoveryAuthorityDigest } : {});
    return { ...view({ ...updated, databaseNow: row.databaseNow }), expiresAt, capability };
  });
}
