import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type CustomerDeployment } from "@prisma/client";
import { prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError } from "./errors";
import { canonicalizeManagedAzureRollbackPayloadV1, type ManagedAzureRollbackPayloadV1 } from "./managed-azure-rollback-payload";
import { createManagedReleaseProofReader } from "./managed-release-proof-support";
const IMAGE_TAG = /^sha-[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLLBACK_RESERVATION = /^rollback-archive:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const POSTGRES_UNSAFE_STRING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_INT = 2_147_483_647;
const TTL_MS = 5 * 60 * 1000;
const ACTIVE_PHASES = ["RESERVED", "MUTATING", "RECOVERY_REQUIRED"] as const;
const RECOVERY_STAGES = ["INVENTORY", "PREFLIGHT", "IMPORT", "WEB", "WORKER", "READBACK", "OBSERVATION", "ROLLBACK", "FENCING"] as const;
const ROLLBACK_ENVELOPE_KEYS = new Set(["version", "deploymentId", "leaseId", "fence", "expectedImageTag", "incomingImageTag", "incomingVersion", "payload"]);
type LockedDeployment = CustomerDeployment & { databaseNow: Date; rollbackRecordPresent: boolean };
type LeaseHandle = { deploymentId: string; leaseId: string; capability: string; fence: number };
type AcrIdentity = { acrName: string; acrServer: string };
type RecoveryEvidence = { stage: typeof RECOVERY_STAGES[number]; code: string };
type ManagedReleaseLeaseTarget = Readonly<{
  deploymentId: string; leaseId: string; fence: number; phase: typeof ACTIVE_PHASES[number];
  release: Readonly<{ baselineImageTag: string; baselineVersion: string | null; target:
    | Readonly<{ kind: "FORWARD"; imageTag: string; version: string }>
    | Readonly<{ kind: "ROLLBACK"; imageTag: string; rollbackArchiveId: string }> }>;
  origin: string;
  target: Readonly<{ subscriptionId: string; resourceGroup: string; acrName: string; acrServer: string; webAppName: string; workerAppName: string }>;
}>;
function reject(code: string, status = 409): never {
  throw new AppError(status, code, "Managed release lease request was rejected.");
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
function targetView(row: LockedDeployment, acrIdentity: AcrIdentity) {
  const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
  if (!row.releaseImageTag || !IMAGE_TAG.test(row.releaseImageTag)
    || row.releaseLeaseExpectedImageTag !== row.releaseImageTag
    || !row.releaseLeaseIncomingImageTag || !IMAGE_TAG.test(row.releaseLeaseIncomingImageTag)
    || row.releaseLeaseIncomingImageTag === row.releaseImageTag
    || !row.releaseLeasePhase || !ACTIVE_PHASES.includes(row.releaseLeasePhase)
    || !row.providerSubscriptionId || !UUID.test(row.providerSubscriptionId)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const baselineVersion = row.releaseVersion === null ? null : reader.version(row.releaseVersion);
  const incomingVersion = row.releaseLeaseIncomingVersion;
  if (typeof incomingVersion !== "string") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const rollback = ROLLBACK_RESERVATION.exec(incomingVersion);
  const releaseTarget = rollback
    ? reader.exactRecord({ kind: "ROLLBACK", imageTag: row.releaseLeaseIncomingImageTag,
      rollbackArchiveId: rollback[1]! }, ["kind", "imageTag", "rollbackArchiveId"] as const)
    : reader.exactRecord({ kind: "FORWARD", imageTag: row.releaseLeaseIncomingImageTag,
      version: reader.version(incomingVersion) }, ["kind", "imageTag", "version"] as const);
  const subscriptionId = reader.uuid(row.providerSubscriptionId);
  const resourceGroup = reader.azureResourceGroup(row.providerResourceGroup);
  const webAppName = reader.azureAppName(row.providerWebServiceId);
  const workerAppName = reader.azureAppName(row.providerWorkerServiceId);
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
    fence: row.releaseLeaseFence, phase: row.releaseLeasePhase, release, origin: canonicalOrigin(row.url), target },
  ["deploymentId", "leaseId", "fence", "phase", "release", "origin", "target"] as const)) as ManagedReleaseLeaseTarget;
}
function rollbackTargetMatches(row: CustomerDeployment, payload: Readonly<ManagedAzureRollbackPayloadV1>) {
  return row.providerSubscriptionId === payload.target.subscriptionId
    && row.providerResourceGroup === payload.target.resourceGroup
    && row.providerWebServiceId === payload.target.webAppName
    && row.providerWorkerServiceId === payload.target.workerAppName
    && row.releaseVersion === payload.previous.releaseVersion;
}
function storedRollbackPayload(row: CustomerDeployment) {
  const value = row.releaseLeaseRollbackRecord;
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ROLLBACK_ENVELOPE_KEYS.size || keys.some((key) => !ROLLBACK_ENVELOPE_KEYS.has(key))
    || record.version !== 1 || record.deploymentId !== row.id || record.leaseId !== row.releaseLeaseId
    || record.fence !== row.releaseLeaseFence || record.expectedImageTag !== row.releaseLeaseExpectedImageTag
    || record.incomingImageTag !== row.releaseLeaseIncomingImageTag || record.incomingVersion !== row.releaseLeaseIncomingVersion) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  let payload: Readonly<ManagedAzureRollbackPayloadV1>;
  try { payload = canonicalizeManagedAzureRollbackPayloadV1(record.payload); } catch { reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
  if (!rollbackTargetMatches(row, payload)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
  return payload;
}
function rollbackEnvelope(
  row: CustomerDeployment,
  payload: Readonly<ManagedAzureRollbackPayloadV1>,
  leaseId = row.releaseLeaseId!,
  fence = row.releaseLeaseFence,
) {
  return {
    version: 1,
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
  return Boolean(row.customerAccountId && row.deploymentKind === "REMOTE_MANAGED" && row.cloudProvider === "AZURE" && row.environment === "production" && row.deploymentStatus === "ACTIVE" && row.provisioningStatus === "active");
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
async function event(tx: Prisma.TransactionClient, row: LockedDeployment, action: string) {
  await tx.customerDeploymentEvent.create({
    data: {
      deploymentId: row.id,
      action,
      meta: {
        leaseId: row.releaseLeaseId,
        fence: row.releaseLeaseFence,
        owner: row.releaseLeaseOwner,
        expectedImageTag: row.releaseLeaseExpectedImageTag,
        incomingImageTag: row.releaseLeaseIncomingImageTag,
        incomingVersion: row.releaseLeaseIncomingVersion,
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
  const overlaps = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CustomerDeployment"
    WHERE "id" <> ${row.id}
      AND lower(COALESCE("providerSubscriptionId", '')) = lower(${row.providerSubscriptionId ?? ""})
      AND lower(COALESCE("providerResourceGroup", '')) = lower(${row.providerResourceGroup ?? ""})
      AND (
        lower(COALESCE("providerWebServiceId", '')) IN (lower(${row.providerWebServiceId ?? ""}), lower(${row.providerWorkerServiceId ?? ""}))
        OR lower(COALESCE("providerWorkerServiceId", '')) IN (lower(${row.providerWebServiceId ?? ""}), lower(${row.providerWorkerServiceId ?? ""}))
      )
    LIMIT 1
  `;
  if (overlaps.length > 0) reject("MANAGED_RELEASE_TARGET_OVERLAP");
}

export async function getManagedReleaseTargetPreflight(deploymentId: string, acrIdentity: AcrIdentity) {
  requireInput(typeof deploymentId === "string" && UUID.test(deploymentId));
  const input = targetInputs({ deploymentId, leaseId: "00000000-0000-4000-8000-000000000000", capability: "preflight", fence: 1 }, acrIdentity);
  return transact(async (tx) => {
    const row = await lock(tx, deploymentId);
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    if (row.releaseLeaseId) reject(row.releaseLeasePhase === "RESERVED" ? "MANAGED_RELEASE_LEASE_CONFLICT" : "MANAGED_RELEASE_RECOVERY_REQUIRED");
    await assertNoTargetOverlap(tx, row);
    const reader = createManagedReleaseProofReader(() => reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT"));
    if (!row.releaseImageTag || !IMAGE_TAG.test(row.releaseImageTag) || !row.providerSubscriptionId || !UUID.test(row.providerSubscriptionId)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const acrName = reader.azureAcrName(input.acrIdentity.acrName);
    const target = reader.exactRecord({
      subscriptionId: reader.uuid(row.providerSubscriptionId),
      resourceGroup: reader.azureResourceGroup(row.providerResourceGroup),
      acrName,
      acrServer: reader.azureAcrServer(input.acrIdentity.acrServer, acrName),
      webAppName: reader.azureAppName(row.providerWebServiceId),
      workerAppName: reader.azureAppName(row.providerWorkerServiceId),
    }, ["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"] as const);
    if (target.webAppName === target.workerAppName) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const release = reader.exactRecord({
      baselineImageTag: row.releaseImageTag,
      baselineVersion: row.releaseVersion === null ? null : reader.version(row.releaseVersion),
    }, ["baselineImageTag", "baselineVersion"] as const);
    return reader.deepFreeze(reader.exactRecord({ deploymentId: row.id, origin: canonicalOrigin(row.url), release, target },
      ["deploymentId", "origin", "release", "target"] as const));
  });
}

export async function acquireManagedReleaseLease(params: { deploymentId: string; expectedImageTag: string; incomingImageTag: string; incomingVersion: string; owner: string }) {
  requireInput(params && typeof params === "object" && !Array.isArray(params));
  requireInput(typeof params.deploymentId === "string" && UUID.test(params.deploymentId));
  requireInput(typeof params.expectedImageTag === "string" && IMAGE_TAG.test(params.expectedImageTag));
  requireInput(typeof params.incomingImageTag === "string" && IMAGE_TAG.test(params.incomingImageTag) && params.incomingImageTag !== params.expectedImageTag);
  requireInput(typeof params.incomingVersion === "string" && params.incomingVersion.trim().length > 0 && params.incomingVersion.length <= 128 && !/[\u0000-\u001f\u007f]/.test(params.incomingVersion) && !POSTGRES_UNSAFE_STRING.test(params.incomingVersion));
  requireInput(typeof params.owner === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(params.owner));
  return transact(async (tx) => {
    const row = await lock(tx, params.deploymentId);
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    await assertNoTargetOverlap(tx, row);
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
    await event(tx, updated, replaced ? "control_plane.release_lease.reservation_replaced" : "control_plane.release_lease.acquired");
    return { ...view({ ...updated, databaseNow: row.databaseNow }), capability };
  });
}

export async function heartbeatManagedReleaseLease(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
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
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    return targetView(row, input.acrIdentity);
  });
}

export async function getManagedReleaseRollbackRecord(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (!row.rollbackRecordPresent) reject("MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    return storedRollbackPayload(row);
  });
}

export async function recordManagedReleaseRollbackRecord(handle: LeaseHandle, payload: unknown) {
  const canonicalPayload = canonicalizeManagedAzureRollbackPayloadV1(payload);
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (!rollbackTargetMatches(row, canonicalPayload)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const envelope = rollbackEnvelope(row, canonicalPayload);
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
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    if (row.releaseLeasePhase === "MUTATING") { storedRollbackPayload(row); return view(row); }
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (row.releaseImageTag !== row.releaseLeaseExpectedImageTag) reject("MANAGED_RELEASE_BASELINE_CONFLICT");
    if (!row.rollbackRecordPresent) reject("MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    storedRollbackPayload(row);
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const updated = await tx.customerDeployment.update({ where: { id: row.id }, data: { releaseLeasePhase: "MUTATING", releaseLeaseHeartbeatAt: row.databaseNow, releaseLeaseExpiresAt: expiresAt } }) as LockedDeployment;
    await event(tx, updated, "control_plane.release_lease.mutation_begun");
    return { ...view({ ...updated, databaseNow: row.databaseNow }), expiresAt };
  });
}

export async function abortManagedReleaseLease(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle, true);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    await event(tx, row, "control_plane.release_lease.aborted");
    return { deploymentId: row.id, fence: row.releaseLeaseFence, aborted: true };
  });
}

export async function finalizeManagedReleaseSuccess(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
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

export async function finalizeManagedReleaseRollback(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    storedRollbackPayload(row);
    await tx.customerDeployment.update({ where: { id: row.id }, data: clearLeaseData() });
    await event(tx, row, "control_plane.release_lease.rolled_back");
    return { deploymentId: row.id, fence: row.releaseLeaseFence, status: "ROLLED_BACK" as const,
      releaseImageTag: row.releaseImageTag, releaseVersion: row.releaseVersion };
  });
}

export async function markManagedReleaseRecoveryRequired(handle: LeaseHandle, evidence: RecoveryEvidence) {
  const canonicalEvidence = validateRecoveryEvidence(evidence);
  return transact(async (tx) => {
    const row = await owned(tx, handle, true);
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
    if (!eligible(row)) reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
    if (row.releaseLeaseId !== params.expectedLeaseId || row.releaseLeaseFence !== params.expectedFence) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    if ((row.releaseLeasePhase !== "MUTATING" && row.releaseLeasePhase !== "RECOVERY_REQUIRED")
      || !row.releaseLeaseExpiresAt || row.releaseLeaseExpiresAt > row.databaseNow || !row.rollbackRecordPresent) reject("MANAGED_RELEASE_RECOVERY_REQUIRED");
    const rollbackPayload = storedRollbackPayload(row);
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
      releaseLeaseRollbackRecord: rollbackEnvelope(row, rollbackPayload, leaseId, fence) as unknown as Prisma.InputJsonValue,
    } }) as LockedDeployment;
    await event(tx, updated, "control_plane.release_lease.recovery_claimed");
    return { ...view({ ...updated, databaseNow: row.databaseNow }), expiresAt, capability };
  });
}
