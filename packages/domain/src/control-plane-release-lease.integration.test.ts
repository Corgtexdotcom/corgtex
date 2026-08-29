import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, sha256 } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import {
  abortManagedReleaseLease,
  acquireManagedReleaseLease,
  beginManagedReleaseMutation,
  claimManagedReleaseRecovery,
  finalizeManagedReleaseRollback,
  finalizeManagedReleaseSuccess,
  getManagedReleaseLeaseTarget,
  getManagedReleaseRecoveryStatus,
  getManagedReleaseRollbackRecord,
  getManagedReleaseTargetPreflight,
  heartbeatManagedReleaseLease,
  markManagedReleaseRecoveryRequired,
  recordManagedReleaseRollbackRecord,
} from "./control-plane-release-lease";
const prisma = getPrismaClient();
const BASE = `sha-${"a".repeat(40)}`; const NEXT = `sha-${"b".repeat(40)}`;
const SUBSCRIPTION = "123e4567-e89b-12d3-a456-426614174000"; const [RG, WEB, WORKER, ACR] = ["rg.Safe_1", "web-app", "worker-app", "acr12.azurecr.io"];
const ARM_WEB = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${WEB}`;
const ARM_WORKER = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${WORKER}`;
const ARM_WEB_UPPER_RG = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG.toUpperCase()}/providers/Microsoft.App/containerApps/${WEB}`;
const ACR_IDENTITY = { acrName: "acr12", acrServer: ACR };
const DIGESTS = ["1", "2", "3", "4"].map((value) => `sha256:${value.repeat(64)}`);
function rollbackPayload() {
  return {
    schemaVersion: 1,
    target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    previous: { releaseVersion: "release-1", web: { containerName: "web--old", image: `${ACR}/corgtex/web@${DIGESTS[0]}`, readyRevision: `${WEB}--rev-1`, templateDigest: DIGESTS[2] },
      worker: { containerName: "worker--old", image: `${ACR}/corgtex/worker@${DIGESTS[1]}`, readyRevision: `${WORKER}--rev-2`, templateDigest: DIGESTS[3] } },
    incoming: { webDigest: DIGESTS[2], workerDigest: DIGESTS[3] },
  };
}
function reverseKeys(value: unknown): unknown { if (!value || typeof value !== "object" || Array.isArray(value)) return value; return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])); }
async function deployment(overrides: Partial<Prisma.CustomerDeploymentUncheckedCreateInput> = {}) {
  const suffix = randomUUID();
  const account = await prisma.customerAccount.create({ data: { slug: `lease-${suffix}`, displayName: "Synthetic lease account" } });
  return prisma.customerDeployment.create({ data: {
    label: "Synthetic managed Azure", url: `https://${suffix}.example.test`, customerAccountId: account.id,
    deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE", environment: "production", deploymentStatus: "ACTIVE",
    provisioningStatus: "active", releaseImageTag: BASE, releaseVersion: "release-1", providerSubscriptionId: SUBSCRIPTION,
    providerResourceGroup: RG, providerWebServiceId: WEB, providerWorkerServiceId: WORKER, ...overrides,
  } });
}
async function acquire(deploymentId: string, overrides = {}) {
  const result = await acquireManagedReleaseLease({ deploymentId, expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "release-2", owner: "fleet:test", ...overrides });
  return { deploymentId: result.deploymentId, leaseId: result.leaseId, capability: result.capability, fence: result.fence };
}
async function seededLease(overrides: Partial<Prisma.CustomerDeploymentUncheckedCreateInput> = {}) {
  const capability = `synthetic-${randomUUID()}`; const leaseId = randomUUID(); const now = new Date();
  const row = await deployment({ releaseLeaseFence: 7, releaseLeaseId: leaseId, releaseLeaseTokenHash: sha256(capability), releaseLeaseOwner: "fleet:test",
    releaseLeaseExpectedImageTag: BASE, releaseLeaseIncomingImageTag: NEXT, releaseLeaseIncomingVersion: "release-2", releaseLeasePhase: "RESERVED",
    releaseLeaseAcquiredAt: now, releaseLeaseHeartbeatAt: now, releaseLeaseExpiresAt: new Date(now.getTime() + 300_000), ...overrides });
  return { row, handle: { deploymentId: row.id, leaseId, capability, fence: 7 } };
}
async function releaseState(deploymentId: string) {
  return {
    deployment: await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deploymentId } }),
    events: await prisma.customerDeploymentEvent.findMany({ where: { deploymentId }, orderBy: { id: "asc" } }),
    snapshots: await prisma.fleetHealthSnapshot.findMany({ where: { deploymentId }, orderBy: { id: "asc" } }),
    targets: await prisma.customerReleaseTarget.findMany({ where: { deploymentId }, orderBy: { id: "asc" } }),
  };
}
async function expectCode(value: Promise<unknown>, code: string, status = 409, message = "Managed release lease request was rejected.") {
  await expect(value).rejects.toMatchObject({ code, status, message });
}
async function expire(deploymentId: string) {
  const now = Date.now();
  await prisma.customerDeployment.update({ where: { id: deploymentId }, data: {
    releaseLeaseAcquiredAt: new Date(now - 600_000), releaseLeaseHeartbeatAt: new Date(now - 360_000), releaseLeaseExpiresAt: new Date(now - 60_000),
  } });
}
beforeEach(async () => truncateAllTables());
describe("managed release lease CAS", () => {
  it("validates exact targeting, eligibility, and baseline before reserving", async () => {
    const eligible = await deployment();
    for (const incomingVersion of ["bad\u0000", "\uD800", "\uDC00"]) await expectCode(acquire(eligible.id, { incomingVersion }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(acquireManagedReleaseLease({ deploymentId: "azure-prod", expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "v", owner: "fleet:test" }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(acquire(eligible.id, { expectedImageTag: "latest" }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(acquire(eligible.id, { incomingImageTag: BASE }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(acquire(randomUUID()), "MANAGED_RELEASE_DEPLOYMENT_NOT_FOUND", 404);
    await expectCode(acquire(eligible.id, { expectedImageTag: `sha-${"c".repeat(40)}` }), "MANAGED_RELEASE_BASELINE_CONFLICT");
    const ineligible = await Promise.all([
      deployment({ customerAccountId: null, providerSubscriptionId: randomUUID() }), deployment({ deploymentKind: "SHARED_WORKSPACE", providerSubscriptionId: randomUUID() }),
      deployment({ cloudProvider: "RAILWAY", providerSubscriptionId: randomUUID() }), deployment({ environment: "staging", providerSubscriptionId: randomUUID() }),
      deployment({ deploymentStatus: "SUSPENDED", providerSubscriptionId: randomUUID() }), deployment({ provisioningStatus: "draft", providerSubscriptionId: randomUUID() }),
    ]);
    for (const row of ineligible) await expectCode(acquire(row.id), "MANAGED_RELEASE_TARGET_INELIGIBLE");
    await expect(acquire(eligible.id, { incomingVersion: "release-\uD801\uDC00" })).resolves.toMatchObject({ deploymentId: eligible.id });
  });
  it("serializes simultaneous acquisition and heartbeats the exact owner without event noise", async () => {
    const target = await deployment();
    const attempts = await Promise.allSettled([acquire(target.id), acquire(target.id)]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const handle = attempts.find((result) => result.status === "fulfilled")!.value;
    const loser = attempts.find((result) => result.status === "rejected")!;
    expect(loser.reason).toMatchObject({ code: "MANAGED_RELEASE_LEASE_CONFLICT", status: 409 });
    const stored = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(stored.releaseLeaseTokenHash).toBe(sha256(handle.capability)); expect(stored.releaseLeaseTokenHash).not.toBe(handle.capability);
    expect(stored.releaseLeaseExpiresAt!.getTime() - stored.releaseLeaseAcquiredAt!.getTime()).toBe(300_000);
    const heartbeat = await heartbeatManagedReleaseLease(handle);
    expect(heartbeat).not.toHaveProperty("capability");
    expect(await prisma.customerDeploymentEvent.count({ where: { deploymentId: target.id } })).toBe(1);
    await expectCode(heartbeatManagedReleaseLease({ ...handle, capability: "wrong" }), "MANAGED_RELEASE_LEASE_CONFLICT");
    await expectCode(heartbeatManagedReleaseLease({ ...handle, capability: stored.releaseLeaseTokenHash! }), "MANAGED_RELEASE_LEASE_CONFLICT");
    await expectCode(heartbeatManagedReleaseLease({ ...handle, fence: handle.fence + 1 }), "MANAGED_RELEASE_LEASE_CONFLICT");
  });
  it("checks expiry against post-lock database wall time", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    await prisma.$executeRaw`UPDATE "CustomerDeployment" SET "releaseLeaseAcquiredAt" = clock_timestamp() - interval '1 minute', "releaseLeaseHeartbeatAt" = clock_timestamp(), "releaseLeaseExpiresAt" = clock_timestamp() + interval '300 milliseconds' WHERE "id" = ${target.id}`;
    const locker = new PrismaClient();
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => { signal = resolve; });
    const blocker = locker.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "CustomerDeployment" WHERE "id" = ${target.id} FOR UPDATE`; signal(); await tx.$queryRaw`SELECT clock_timestamp() FROM pg_sleep(0.6)`; });
    await locked;
    const expired = expectCode(heartbeatManagedReleaseLease(handle), "MANAGED_RELEASE_LEASE_EXPIRED");
    await blocker;
    await expired;
    await locker.$disconnect();
  });
  it("replaces only expired reservations and fences every operation from the prior owner", async () => {
    const target = await deployment();
    const old = await acquire(target.id);
    await expire(target.id);
    const current = await acquire(target.id);
    expect(current.fence).toBe(old.fence + 1); expect(current.leaseId).not.toBe(old.leaseId);
    const stale = [
      () => heartbeatManagedReleaseLease(old), () => recordManagedReleaseRollbackRecord(old, rollbackPayload()),
      () => beginManagedReleaseMutation(old), () => abortManagedReleaseLease(old),
    ];
    for (const operation of stale) await expectCode(operation(), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect((await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: target.id } })).map(({ action }) => action)).toEqual(["control_plane.release_lease.acquired", "control_plane.release_lease.reservation_replaced"]);
    await recordManagedReleaseRollbackRecord(current, rollbackPayload());
    await beginManagedReleaseMutation(current);
    await expectCode(acquire(target.id), "MANAGED_RELEASE_LEASE_CONFLICT");
    await expire(target.id);
    await expectCode(acquire(target.id), "MANAGED_RELEASE_RECOVERY_REQUIRED");
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeasePhase: "RECOVERY_REQUIRED" } });
    await expectCode(acquire(target.id), "MANAGED_RELEASE_RECOVERY_REQUIRED");
    expect((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } })).releaseLeaseId).toBe(current.leaseId);
  });
  it("persists one exact canonical rollback envelope and begins mutation idempotently", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    const parserMessage = "Managed release rollback payload is invalid."; const missing = rollbackPayload(); delete (missing.previous.web as { containerName?: string }).containerName;
    const rejected = rollbackPayload(); rejected.previous.web.containerName = "Web--old"; const extra = { ...rollbackPayload(), arbitrary: "not-preserved" };
    for (const value of [missing, rejected, extra]) await expectCode(recordManagedReleaseRollbackRecord(handle, value), "MANAGED_RELEASE_INVALID_INPUT", 400, parserMessage);
    for (const change of [
      (value: ReturnType<typeof rollbackPayload>) => { value.target.subscriptionId = "123e4567-e89b-12d3-a456-426614174001"; }, (value: ReturnType<typeof rollbackPayload>) => { value.target.resourceGroup = "rg.Other_1"; },
      (value: ReturnType<typeof rollbackPayload>) => { value.target.webAppName = "web-other"; value.previous.web.readyRevision = "web-other--rev-1"; }, (value: ReturnType<typeof rollbackPayload>) => { value.target.workerAppName = "worker-other"; value.previous.worker.readyRevision = "worker-other--rev-2"; },
      (value: ReturnType<typeof rollbackPayload>) => { Object.assign(value.previous, { releaseVersion: null }); },
    ]) { const value = rollbackPayload(); change(value); await expectCode(recordManagedReleaseRollbackRecord(handle, value), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
    const payload = rollbackPayload(); await recordManagedReleaseRollbackRecord(handle, payload);
    await recordManagedReleaseRollbackRecord(handle, reverseKeys(payload));
    const changed = rollbackPayload(); changed.previous.web.containerName = "web--changed";
    await expectCode(recordManagedReleaseRollbackRecord(handle, changed), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const reserved = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(reserved.releaseLeaseRollbackRecord).toMatchObject({ version: 1, deploymentId: target.id, leaseId: handle.leaseId, fence: handle.fence, expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "release-2" });
    expect((reserved.releaseLeaseRollbackRecord as { payload: unknown }).payload).toEqual(payload);
    await beginManagedReleaseMutation(handle); expect(await beginManagedReleaseMutation(handle)).not.toHaveProperty("capability");
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeaseRollbackRecord: { version: 1 } } }); await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    await expectCode(abortManagedReleaseLease(handle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const events = await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: target.id } });
    expect(events.map(({ action }) => action)).toEqual(["control_plane.release_lease.acquired", "control_plane.release_lease.rollback_recorded", "control_plane.release_lease.mutation_begun"]);
    expect(JSON.stringify(events)).not.toContain(handle.capability);
    expect(JSON.stringify(events)).not.toContain("web--old");
    await truncateAllTables();
    const corrupt = await deployment(); const corruptHandle = await acquire(corrupt.id); await prisma.customerDeployment.update({ where: { id: corrupt.id }, data: { releaseLeaseRollbackRecord: { version: 1 } } });
    await expectCode(recordManagedReleaseRollbackRecord(corruptHandle, rollbackPayload()), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); await expectCode(beginManagedReleaseMutation(corruptHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    for (const malformed of [false, 0, "", Prisma.JsonNull]) { await prisma.customerDeployment.update({ where: { id: corrupt.id }, data: { releaseLeaseRollbackRecord: malformed } }); await expectCode(recordManagedReleaseRollbackRecord(corruptHandle, rollbackPayload()), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); await expectCode(beginManagedReleaseMutation(corruptHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
    for (const phase of ["RESERVED", "MUTATING"] as const) { await truncateAllTables(); const drifted = await deployment(); const driftedHandle = await acquire(drifted.id); await recordManagedReleaseRollbackRecord(driftedHandle, rollbackPayload()); if (phase === "MUTATING") await beginManagedReleaseMutation(driftedHandle); const envelope = structuredClone((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } })).releaseLeaseRollbackRecord) as { payload: ReturnType<typeof rollbackPayload> }; if (phase === "RESERVED") envelope.payload.previous.releaseVersion = "release-drift"; else { envelope.payload.target.webAppName = "web-drift"; envelope.payload.previous.web.readyRevision = "web-drift--rev-1"; } await prisma.customerDeployment.update({ where: { id: drifted.id }, data: { releaseLeaseRollbackRecord: envelope as Prisma.InputJsonValue } }); const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } }); await expectCode(heartbeatManagedReleaseLease(driftedHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } })).toEqual(before); }
  });
  it("permits safe expired-reservation abort and clears the slot without resetting its fence or baseline", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    await recordManagedReleaseRollbackRecord(handle, rollbackPayload());
    await expire(target.id);
    await expectCode(heartbeatManagedReleaseLease(handle), "MANAGED_RELEASE_LEASE_EXPIRED");
    await expectCode(recordManagedReleaseRollbackRecord(handle, rollbackPayload()), "MANAGED_RELEASE_LEASE_EXPIRED");
    await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_LEASE_EXPIRED");
    expect(await abortManagedReleaseLease(handle)).toEqual({ deploymentId: target.id, fence: handle.fence, aborted: true });
    const cleared = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(Object.entries(cleared).filter(([key]) => key.startsWith("releaseLease") && key !== "releaseLeaseFence").every(([, value]) => value === null)).toBe(true);
    expect(cleared.releaseLeaseFence).toBe(handle.fence); expect(cleared.releaseImageTag).toBe(BASE);
  });
  it("projects one exact frozen forward target without changing durable release state", async () => {
    const target = await deployment(); const handle = await acquire(target.id);
    const nullHandle = Object.assign(Object.create(null), handle); const nullAcr = Object.assign(Object.create(null), ACR_IDENTITY);
    const before = await releaseState(target.id); const projected = await getManagedReleaseLeaseTarget(nullHandle, nullAcr);
    expect(projected).toEqual({ deploymentId: target.id, leaseId: handle.leaseId, fence: handle.fence, phase: "RESERVED",
      release: { baselineImageTag: BASE, baselineVersion: "release-1", target: { kind: "FORWARD", imageTag: NEXT, version: "release-2" } },
      origin: target.url, target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER } });
    expect(Object.keys(projected)).toEqual(["deploymentId", "leaseId", "fence", "phase", "release", "origin", "target"]);
    expect(Object.keys(projected.release)).toEqual(["baselineImageTag", "baselineVersion", "target"]);
    expect(Object.keys(projected.target)).toEqual(["subscriptionId", "resourceGroup", "acrName", "acrServer", "webAppName", "workerAppName"]);
    expect([projected, projected.release, projected.release.target, projected.target].every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain(handle.capability); expect(JSON.stringify(projected)).not.toContain(sha256(handle.capability));
    const replay = await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY); expect(replay).toEqual(projected); expect(replay).not.toBe(projected);
    expect(await releaseState(target.id)).toEqual(before);
    await recordManagedReleaseRollbackRecord(handle, rollbackPayload());
    const recorded = await releaseState(target.id);
    await expectCode(getManagedReleaseLeaseTarget(handle, { acrName: "other12", acrServer: "other12.azurecr.io" }), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    expect(await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).toMatchObject({ phase: "RESERVED", release: { target: { kind: "FORWARD" } } });
    expect(await releaseState(target.id)).toEqual(recorded);
    await beginManagedReleaseMutation(handle); const mutating = await releaseState(target.id);
    expect(await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).toMatchObject({ phase: "MUTATING" }); expect(await releaseState(target.id)).toEqual(mutating);
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeasePhase: "RECOVERY_REQUIRED" } });
    const recovering = await releaseState(target.id); expect(await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).toMatchObject({ phase: "RECOVERY_REQUIRED" });
    expect(await releaseState(target.id)).toEqual(recovering);
  });
  it("keeps an exact rollback reservation distinct from nullable release versions and binds its recorded ACR", async () => {
    const archiveId = randomUUID(); const { row, handle } = await seededLease({ releaseVersion: null, releaseLeaseIncomingVersion: `rollback-archive:${archiveId}` });
    const before = await releaseState(row.id); const reserved = await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY);
    expect(reserved.release).toEqual({ baselineImageTag: BASE, baselineVersion: null, target: { kind: "ROLLBACK", imageTag: NEXT, rollbackArchiveId: archiveId } });
    expect(reserved.release.target).not.toHaveProperty("version"); expect(await releaseState(row.id)).toEqual(before);
    const payload = rollbackPayload(); Object.assign(payload.previous, { releaseVersion: null }); await recordManagedReleaseRollbackRecord(handle, payload);
    const stored = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: row.id } });
    expect((stored.releaseLeaseRollbackRecord as { payload: ReturnType<typeof rollbackPayload> }).payload.previous).toMatchObject({ releaseVersion: null,
      web: { containerName: "web--old" }, worker: { containerName: "worker--old" } });
    const recorded = await releaseState(row.id);
    await expectCode(getManagedReleaseLeaseTarget(handle, { acrName: "other12", acrServer: "other12.azurecr.io" }), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    expect(await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).toMatchObject({ release: { baselineVersion: null, target: { kind: "ROLLBACK", rollbackArchiveId: archiveId } } });
    expect(await releaseState(row.id)).toEqual(recorded);
    await beginManagedReleaseMutation(handle); await prisma.customerDeployment.update({ where: { id: row.id }, data: { releaseLeasePhase: "RECOVERY_REQUIRED" } });
    const recovering = await releaseState(row.id); expect(await getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).toMatchObject({ phase: "RECOVERY_REQUIRED" });
    expect(await releaseState(row.id)).toEqual(recovering);
  });
  it("rejects non-closed target inputs before they can change or disclose the leased row", async () => {
    const target = await deployment(); const handle = await acquire(target.id); const before = await releaseState(target.id); let getterCalls = 0;
    const accessor = { ...handle } as Record<string, unknown>; Object.defineProperty(accessor, "capability", { enumerable: true, get: () => { getterCalls += 1; return handle.capability; } });
    const hidden = { ...handle }; Object.defineProperty(hidden, "fence", { enumerable: false, value: handle.fence });
    const symbol = { ...handle } as Record<PropertyKey, unknown>; symbol[Symbol("private")] = "private";
    const invalidHandles = [null, [], { ...handle, extra: true }, { deploymentId: handle.deploymentId }, Object.create(handle), accessor, hidden, symbol,
      new Proxy({ ...handle }, {}), { ...handle, deploymentId: handle.deploymentId.toUpperCase() }, { ...handle, fence: 0 }, { ...handle, capability: 7 }];
    for (const value of invalidHandles) await expectCode(getManagedReleaseLeaseTarget(value as never, ACR_IDENTITY), "MANAGED_RELEASE_INVALID_INPUT", 400);
    const acrAccessor = { acrName: "acr12" } as Record<string, unknown>; Object.defineProperty(acrAccessor, "acrServer", { enumerable: true, get: () => { getterCalls += 1; return ACR; } });
    const invalidAcr = [null, [], { ...ACR_IDENTITY, extra: true }, Object.create(ACR_IDENTITY), acrAccessor, new Proxy({ ...ACR_IDENTITY }, {}),
      { acrName: "ACR12", acrServer: ACR }, { acrName: "acr12", acrServer: "other12.azurecr.io" }];
    for (const value of invalidAcr) await expectCode(getManagedReleaseLeaseTarget(handle, value as never), "MANAGED_RELEASE_INVALID_INPUT", 400);
    for (const prototype of [Object.prototype, Array.prototype]) {
      const key = Symbol("private"); Object.defineProperty(prototype, key, { configurable: true, enumerable: true, value: "private" });
      try { await expectCode(getManagedReleaseLeaseTarget(handle, ACR_IDENTITY), "MANAGED_RELEASE_INVALID_INPUT", 400); } finally { Reflect.deleteProperty(prototype, key); }
    }
    expect(getterCalls).toBe(0); expect(await releaseState(target.id)).toEqual(before);
  });
  it("fails closed on stale ownership, expiry, ineligible rows, unsafe target state, and envelope drift", async () => {
    const missing = { deploymentId: randomUUID(), leaseId: randomUUID(), capability: "synthetic", fence: 1 };
    await expectCode(getManagedReleaseLeaseTarget(missing, ACR_IDENTITY), "MANAGED_RELEASE_DEPLOYMENT_NOT_FOUND", 404);
    const target = await deployment(); const handle = await acquire(target.id); const before = await releaseState(target.id);
    for (const stale of [{ ...handle, leaseId: randomUUID() }, { ...handle, capability: "wrong" }, { ...handle, fence: handle.fence + 1 }])
      await expectCode(getManagedReleaseLeaseTarget(stale, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect(await releaseState(target.id)).toEqual(before); await expire(target.id); const expired = await releaseState(target.id);
    await expectCode(getManagedReleaseLeaseTarget(handle, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_EXPIRED"); expect(await releaseState(target.id)).toEqual(expired);
    const ineligible = await deployment({ cloudProvider: "RAILWAY" }); const ineligibleBefore = await releaseState(ineligible.id);
    await expectCode(getManagedReleaseLeaseTarget({ deploymentId: ineligible.id, leaseId: randomUUID(), capability: "synthetic", fence: 1 }, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect(await releaseState(ineligible.id)).toEqual(ineligibleBefore);
    await truncateAllTables();
    const unsafeCases: Array<{ overrides: Partial<Prisma.CustomerDeploymentUncheckedCreateInput>; incomingVersion?: string; acquireCode?: string; acquireStatus?: number }> = [
      { overrides: { url: "https://Upper.example.test" } }, { overrides: { url: "https://path.example.test/private" } },
      { overrides: { providerSubscriptionId: SUBSCRIPTION.toUpperCase() }, acquireCode: "MANAGED_RELEASE_LEASE_STATE_CONFLICT" },
      { overrides: { providerResourceGroup: "bad." }, acquireCode: "MANAGED_RELEASE_LEASE_STATE_CONFLICT" },
      { overrides: { providerWebServiceId: "Web-app" }, acquireCode: "MANAGED_RELEASE_LEASE_STATE_CONFLICT" }, { overrides: { providerWorkerServiceId: WEB } },
      { overrides: { releaseVersion: "bad/version" } }, { overrides: {}, incomingVersion: "bad/version" },
    ];
    for (const unsafeCase of unsafeCases) {
      const unsafeRow = await deployment(unsafeCase.overrides);
      const unsafeBefore = await releaseState(unsafeRow.id);
      if (unsafeCase.acquireCode) {
        await expectCode(acquire(unsafeRow.id, unsafeCase.incomingVersion ? { incomingVersion: unsafeCase.incomingVersion } : {}), unsafeCase.acquireCode, unsafeCase.acquireStatus ?? 409);
        expect(await releaseState(unsafeRow.id)).toEqual(unsafeBefore);
      } else {
        const unsafeHandle = await acquire(unsafeRow.id, unsafeCase.incomingVersion ? { incomingVersion: unsafeCase.incomingVersion } : {});
        const leasedBefore = await releaseState(unsafeRow.id);
        await expectCode(getManagedReleaseLeaseTarget(unsafeHandle, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
        expect(await releaseState(unsafeRow.id)).toEqual(leasedBefore);
        await abortManagedReleaseLease(unsafeHandle);
      }
      await truncateAllTables();
    }
    const corrupt = await deployment(); const corruptHandle = await acquire(corrupt.id); await recordManagedReleaseRollbackRecord(corruptHandle, rollbackPayload());
    await prisma.customerDeployment.update({ where: { id: corrupt.id }, data: { releaseLeaseRollbackRecord: { version: 1 } } }); const corruptBefore = await releaseState(corrupt.id);
    await expectCode(getManagedReleaseLeaseTarget(corruptHandle, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); expect(await releaseState(corrupt.id)).toEqual(corruptBefore);
  });
  it("rejects every eligibility drift after mutation begins and leaves the row unchanged", async () => {
    const drifts: Prisma.CustomerDeploymentUncheckedUpdateInput[] = [
      { customerAccountId: null }, { deploymentKind: "SHARED_WORKSPACE" }, { cloudProvider: "RAILWAY" },
      { environment: "staging" }, { deploymentStatus: "SUSPENDED" }, { provisioningStatus: "draft" },
    ];
    for (const data of drifts) {
      await truncateAllTables();
      const target = await deployment(); const handle = await acquire(target.id);
      await recordManagedReleaseRollbackRecord(handle, rollbackPayload());
      await beginManagedReleaseMutation(handle);
      const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
      const failure = await prisma.customerDeployment.update({ where: { id: target.id }, data }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: expect.stringContaining("MANAGED_RELEASE_LEASE_UPDATE_CONFLICT") });
      expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
    }
  });
  it("enforces database backstops without partially changing the leased row", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    const writes = [
      { releaseImageTag: NEXT }, { releaseImageTag: null }, { releaseLeaseOwner: null }, { releaseLeasePhase: "MUTATING" as const },
    ];
    for (const data of writes) {
      await expect(prisma.customerDeployment.update({ where: { id: target.id }, data })).rejects.toBeTruthy();
      expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
    }
    await expect(prisma.customerDeployment.delete({ where: { id: target.id } })).rejects.toThrow("MANAGED_RELEASE_LEASE_DELETE_CONFLICT"); expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
    await abortManagedReleaseLease(handle);
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeaseFence: 2_147_483_647 } });
    await expectCode(acquire(target.id), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect(handle.fence).toBe(1);
  });
  it("projects a read-only exact target and blocks overlapping sibling resources", async () => {
    const target = await deployment();
    const before = await releaseState(target.id);
    await expect(getManagedReleaseTargetPreflight(target.id, ACR_IDENTITY)).resolves.toEqual({
      deploymentId: target.id,
      origin: target.url,
      release: { baselineImageTag: BASE, baselineVersion: "release-1" },
      target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    });
    expect(await releaseState(target.id)).toEqual(before);
    await deployment({ providerWorkerServiceId: "other-worker" });
    await expectCode(getManagedReleaseTargetPreflight(target.id, ACR_IDENTITY), "MANAGED_RELEASE_TARGET_OVERLAP");
    await expectCode(acquire(target.id), "MANAGED_RELEASE_TARGET_OVERLAP");
  });
  it("projects Container App names from exact Azure resource IDs without mutating target state", async () => {
    const target = await deployment({ providerWebServiceId: ARM_WEB_UPPER_RG, providerWorkerServiceId: ARM_WORKER });
    const before = await releaseState(target.id);
    await expect(getManagedReleaseTargetPreflight(target.id, ACR_IDENTITY)).resolves.toEqual({
      deploymentId: target.id,
      origin: target.url,
      release: { baselineImageTag: BASE, baselineVersion: "release-1" },
      target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    });
    expect(await releaseState(target.id)).toEqual(before);
    const handle = await acquire(target.id);
    await expect(recordManagedReleaseRollbackRecord(handle, rollbackPayload())).resolves.toMatchObject({ rollbackRecorded: true });
    await expect(getManagedReleaseLeaseTarget(handle, ACR_IDENTITY)).resolves.toMatchObject({
      target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    });
  });
  it("blocks overlapping Azure targets when rows mix Container App names and resource IDs", async () => {
    const target = await deployment({ providerWebServiceId: ARM_WEB, providerWorkerServiceId: ARM_WORKER });
    await deployment({ providerWebServiceId: WEB, providerWorkerServiceId: "other-worker" });
    await expectCode(getManagedReleaseTargetPreflight(target.id, ACR_IDENTITY), "MANAGED_RELEASE_TARGET_OVERLAP");
    await expectCode(acquire(target.id), "MANAGED_RELEASE_TARGET_OVERLAP");
  });
  it("rejects Azure resource IDs whose embedded target does not match the deployment row", async () => {
    const wrongSubscription = `/subscriptions/${randomUUID()}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${WEB}`;
    const wrongResourceGroup = `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-other/providers/Microsoft.App/containerApps/${WEB}`;
    for (const providerWebServiceId of [wrongSubscription, wrongResourceGroup]) {
      await truncateAllTables();
      const target = await deployment({ providerWebServiceId, providerWorkerServiceId: ARM_WORKER });
      const before = await releaseState(target.id);
      await expectCode(getManagedReleaseTargetPreflight(target.id, ACR_IDENTITY), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
      expect(await releaseState(target.id)).toEqual(before);
    }
  });
  it("atomically finalizes proven success or proven rollback and clears capability state", async () => {
    const forward = await deployment(); const forwardHandle = await acquire(forward.id);
    await recordManagedReleaseRollbackRecord(forwardHandle, rollbackPayload()); await beginManagedReleaseMutation(forwardHandle);
    await expect(finalizeManagedReleaseSuccess(forwardHandle)).resolves.toMatchObject({ status: "SUCCEEDED", releaseImageTag: NEXT, releaseVersion: "release-2" });
    const succeeded = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: forward.id } });
    expect(succeeded.releaseImageTag).toBe(NEXT); expect(succeeded.releaseVersion).toBe("release-2");
    expect(Object.entries(succeeded).filter(([key]) => key.startsWith("releaseLease") && key !== "releaseLeaseFence").every(([, value]) => value === null)).toBe(true);
    await expectCode(heartbeatManagedReleaseLease(forwardHandle), "MANAGED_RELEASE_LEASE_CONFLICT");

    await truncateAllTables();
    const rollback = await deployment(); const rollbackHandle = await acquire(rollback.id);
    await recordManagedReleaseRollbackRecord(rollbackHandle, rollbackPayload()); await beginManagedReleaseMutation(rollbackHandle);
    await expect(finalizeManagedReleaseRollback(rollbackHandle)).resolves.toMatchObject({ status: "ROLLED_BACK", releaseImageTag: BASE, releaseVersion: "release-1" });
    const restored = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: rollback.id } });
    expect(restored.releaseImageTag).toBe(BASE); expect(restored.releaseVersion).toBe("release-1"); expect(restored.releaseLeaseId).toBeNull();
    expect(JSON.stringify(await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: rollback.id } }))).not.toContain(rollbackHandle.capability);
  });
  it("retains bounded recovery evidence and fences an expired recovery takeover", async () => {
    const target = await deployment(); const stale = await acquire(target.id);
    const rollback = rollbackPayload(); await recordManagedReleaseRollbackRecord(stale, rollback); await beginManagedReleaseMutation(stale);
    const recovering = await markManagedReleaseRecoveryRequired(stale, { stage: "WORKER", code: "ARM_OPERATION_AMBIGUOUS" });
    expect(recovering).toMatchObject({ phase: "RECOVERY_REQUIRED", recovery: { stage: "WORKER", code: "ARM_OPERATION_AMBIGUOUS" } });
    const retained = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(retained.releaseLeaseRecoveryEvidence).toEqual({ stage: "WORKER", code: "ARM_OPERATION_AMBIGUOUS" });
    expect(retained.releaseLeaseError).toBe("ARM_OPERATION_AMBIGUOUS");
    const status = await getManagedReleaseRecoveryStatus(target.id, ACR_IDENTITY);
    expect(status).toMatchObject({
      deploymentId: target.id,
      leaseId: stale.leaseId,
      fence: stale.fence,
      phase: "RECOVERY_REQUIRED",
      rollbackRecorded: true,
      recovery: { stage: "WORKER", code: "ARM_OPERATION_AMBIGUOUS" },
      release: { baselineImageTag: BASE, baselineVersion: "release-1" },
      target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    });
    expect(JSON.stringify(status)).not.toContain(stale.capability);
    expect(JSON.stringify(status)).not.toContain(retained.releaseLeaseTokenHash!);
    await expire(target.id);
    const claimed = await claimManagedReleaseRecovery({ deploymentId: target.id, expectedLeaseId: stale.leaseId, expectedFence: stale.fence, owner: "recovery:test" });
    expect(claimed.fence).toBe(stale.fence + 1); expect(claimed.leaseId).not.toBe(stale.leaseId);
    await expectCode(getManagedReleaseRollbackRecord(stale), "MANAGED_RELEASE_LEASE_CONFLICT");
    const currentHandle = { deploymentId: target.id, leaseId: claimed.leaseId, capability: claimed.capability, fence: claimed.fence };
    await expect(getManagedReleaseRollbackRecord(currentHandle)).resolves.toEqual(rollback);
    await expect(finalizeManagedReleaseRollback(currentHandle)).resolves.toMatchObject({ status: "ROLLED_BACK" });
    await expectCode(claimManagedReleaseRecovery({ deploymentId: target.id, expectedLeaseId: stale.leaseId, expectedFence: stale.fence, owner: "recovery:test" }), "MANAGED_RELEASE_LEASE_CONFLICT");
  });
});
