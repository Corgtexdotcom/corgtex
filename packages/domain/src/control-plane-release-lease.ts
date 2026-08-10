import { randomUUID } from "node:crypto";
import { Prisma, type CustomerDeployment } from "@prisma/client";
import { prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError } from "./errors";

const IMAGE_TAG = /^sha-[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL_KEY = /(authorization|bearer|cookie|credential|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const MAX_INT = 2_147_483_647;
const TTL_MS = 5 * 60 * 1000;
const ACTIVE_PHASES = ["RESERVED", "MUTATING", "RECOVERY_REQUIRED"] as const;

type LockedDeployment = CustomerDeployment & { databaseNow: Date };
type LeaseHandle = { deploymentId: string; leaseId: string; capability: string; fence: number };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function reject(code: string, status = 409): never {
  throw new AppError(status, code, "Managed release lease request was rejected.");
}

function requireInput(condition: unknown): asserts condition {
  if (!condition) reject("MANAGED_RELEASE_INVALID_INPUT", 400);
}

function validateHandle(handle: LeaseHandle) {
  requireInput(handle && typeof handle === "object" && !Array.isArray(handle));
  requireInput(typeof handle.deploymentId === "string" && UUID.test(handle.deploymentId));
  requireInput(typeof handle.leaseId === "string" && UUID.test(handle.leaseId));
  requireInput(typeof handle.capability === "string" && handle.capability.length > 0 && handle.capability.length <= 512);
  requireInput(Number.isSafeInteger(handle.fence) && handle.fence > 0 && handle.fence <= MAX_INT);
}

function cleanJson(value: unknown, capability: string, depth = 0, walk = { seen: new WeakSet<object>(), nodes: 0 }): Json {
  requireInput(depth <= 32 && ++walk.nodes <= 10_000);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.includes(capability)) reject("MANAGED_RELEASE_INVALID_INPUT", 400);
    return value;
  }
  if (typeof value === "number") {
    requireInput(Number.isFinite(value));
    return value;
  }
  if (Array.isArray(value)) {
    requireInput(!walk.seen.has(value));
    walk.seen.add(value);
    return value.map((item) => cleanJson(item, capability, depth + 1, walk));
  }
  requireInput(typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  requireInput(!walk.seen.has(value));
  walk.seen.add(value);
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    requireInput(!CREDENTIAL_KEY.test(key) && !key.includes(capability));
    result[key] = cleanJson(item, capability, depth + 1, walk);
  }
  return result;
}

function validateRollbackPayload(value: unknown, capability: string) {
  requireInput(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
  const clean = cleanJson(value, capability);
  requireInput(Buffer.byteLength(JSON.stringify(clean), "utf8") <= 65_536);
  return clean as Record<string, Json>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function lock(tx: Prisma.TransactionClient, deploymentId: string) {
  const [row] = await tx.$queryRaw<LockedDeployment[]>`
    SELECT *, CURRENT_TIMESTAMP AS "databaseNow"
    FROM "CustomerDeployment" WHERE "id" = ${deploymentId} FOR UPDATE
  `;
  if (!row) reject("MANAGED_RELEASE_DEPLOYMENT_NOT_FOUND", 404);
  return row;
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

export async function acquireManagedReleaseLease(params: { deploymentId: string; expectedImageTag: string; incomingImageTag: string; incomingVersion: string; owner: string }) {
  requireInput(params && typeof params === "object" && !Array.isArray(params));
  requireInput(typeof params.deploymentId === "string" && UUID.test(params.deploymentId));
  requireInput(typeof params.expectedImageTag === "string" && IMAGE_TAG.test(params.expectedImageTag));
  requireInput(typeof params.incomingImageTag === "string" && IMAGE_TAG.test(params.incomingImageTag) && params.incomingImageTag !== params.expectedImageTag);
  requireInput(typeof params.incomingVersion === "string" && params.incomingVersion.trim().length > 0 && params.incomingVersion.length <= 128 && !/[\u0000-\u001f\u007f]/.test(params.incomingVersion));
  requireInput(typeof params.owner === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(params.owner));
  return transact(async (tx) => {
    const row = await lock(tx, params.deploymentId);
    if (!row.customerAccountId || row.deploymentKind !== "REMOTE_MANAGED" || row.cloudProvider !== "AZURE" || row.environment !== "production" || row.deploymentStatus !== "ACTIVE" || row.provisioningStatus !== "active") reject("MANAGED_RELEASE_TARGET_INELIGIBLE");
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
    if (!row.releaseLeasePhase || !ACTIVE_PHASES.includes(row.releaseLeasePhase)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const expiresAt = new Date(row.databaseNow.getTime() + TTL_MS);
    const result = await tx.customerDeployment.updateMany({ where: {
      id: row.id, releaseLeaseId: handle.leaseId, releaseLeaseTokenHash: sha256(handle.capability), releaseLeaseFence: handle.fence,
      releaseLeaseExpiresAt: { gt: row.databaseNow }, releaseLeasePhase: { in: [...ACTIVE_PHASES] },
    }, data: { releaseLeaseHeartbeatAt: row.databaseNow, releaseLeaseExpiresAt: expiresAt } });
    if (result.count !== 1) reject("MANAGED_RELEASE_LEASE_CONFLICT");
    return { ...view(row), expiresAt };
  });
}

export async function recordManagedReleaseRollbackRecord(handle: LeaseHandle, payload: unknown) {
  const cleanPayload = validateRollbackPayload(payload, handle?.capability);
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const envelope = { version: 1, deploymentId: row.id, leaseId: row.releaseLeaseId!, fence: row.releaseLeaseFence,
      expectedImageTag: row.releaseLeaseExpectedImageTag!, incomingImageTag: row.releaseLeaseIncomingImageTag!, incomingVersion: row.releaseLeaseIncomingVersion!, payload: cleanPayload };
    if (row.releaseLeaseRollbackRecord) {
      if (canonical(row.releaseLeaseRollbackRecord) !== canonical(envelope)) reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
      return { ...view(row), rollbackRecorded: true };
    }
    await tx.customerDeployment.update({ where: { id: row.id }, data: { releaseLeaseRollbackRecord: envelope as Prisma.InputJsonObject } });
    await event(tx, row, "control_plane.release_lease.rollback_recorded");
    return { ...view(row), rollbackRecorded: true };
  });
}

export async function beginManagedReleaseMutation(handle: LeaseHandle) {
  return transact(async (tx) => {
    const row = await owned(tx, handle);
    if (row.releaseLeasePhase === "MUTATING") return view(row);
    if (row.releaseLeasePhase !== "RESERVED") reject("MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    if (row.releaseImageTag !== row.releaseLeaseExpectedImageTag) reject("MANAGED_RELEASE_BASELINE_CONFLICT");
    if (!row.releaseLeaseRollbackRecord) reject("MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
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
    await tx.customerDeployment.update({ where: { id: row.id }, data: {
      releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null, releaseLeaseExpectedImageTag: null,
      releaseLeaseIncomingImageTag: null, releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null,
      releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: Prisma.DbNull,
      releaseLeaseRecoveryEvidence: Prisma.DbNull, releaseLeaseError: null,
    } });
    await event(tx, row, "control_plane.release_lease.aborted");
    return { deploymentId: row.id, fence: row.releaseLeaseFence, aborted: true };
  });
}
