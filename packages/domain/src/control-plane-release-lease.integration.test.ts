import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, sha256 } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { abortManagedReleaseLease, acquireManagedReleaseLease, beginManagedReleaseMutation, heartbeatManagedReleaseLease, recordManagedReleaseRollbackRecord } from "./control-plane-release-lease";
const prisma = getPrismaClient();
const BASE = `sha-${"a".repeat(40)}`; const NEXT = `sha-${"b".repeat(40)}`;
const SUBSCRIPTION = "123e4567-e89b-12d3-a456-426614174000"; const [RG, WEB, WORKER, ACR] = ["rg.Safe_1", "web-app", "worker-app", "acr12.azurecr.io"];
const DIGESTS = ["1", "2", "3", "4"].map((value) => `sha256:${value.repeat(64)}`);
function rollbackPayload() {
  return {
    schemaVersion: 1,
    target: { subscriptionId: SUBSCRIPTION, resourceGroup: RG, acrName: "acr12", acrServer: ACR, webAppName: WEB, workerAppName: WORKER },
    previous: { releaseVersion: "release-1", web: { containerName: "web--old", image: `${ACR}/corgtex/web@${DIGESTS[0]}`, readyRevision: `${WEB}--rev-1` },
      worker: { containerName: "worker--old", image: `${ACR}/corgtex/worker@${DIGESTS[1]}`, readyRevision: `${WORKER}--rev-2` } },
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
function acquire(deploymentId: string, overrides = {}) {
  return acquireManagedReleaseLease({ deploymentId, expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "release-2", owner: "fleet:test", ...overrides });
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
      deployment({ customerAccountId: null }), deployment({ deploymentKind: "SHARED_WORKSPACE" }), deployment({ cloudProvider: "RAILWAY" }),
      deployment({ environment: "staging" }), deployment({ deploymentStatus: "SUSPENDED" }), deployment({ provisioningStatus: "draft" }),
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
    const corrupt = await deployment(); const corruptHandle = await acquire(corrupt.id); await prisma.customerDeployment.update({ where: { id: corrupt.id }, data: { releaseLeaseRollbackRecord: { version: 1 } } });
    await expectCode(recordManagedReleaseRollbackRecord(corruptHandle, rollbackPayload()), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); await expectCode(beginManagedReleaseMutation(corruptHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    for (const malformed of [false, 0, "", Prisma.JsonNull]) { await prisma.customerDeployment.update({ where: { id: corrupt.id }, data: { releaseLeaseRollbackRecord: malformed } }); await expectCode(recordManagedReleaseRollbackRecord(corruptHandle, rollbackPayload()), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); await expectCode(beginManagedReleaseMutation(corruptHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); }
    for (const phase of ["RESERVED", "MUTATING"] as const) { const drifted = await deployment(); const driftedHandle = await acquire(drifted.id); await recordManagedReleaseRollbackRecord(driftedHandle, rollbackPayload()); if (phase === "MUTATING") await beginManagedReleaseMutation(driftedHandle); const envelope = structuredClone((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } })).releaseLeaseRollbackRecord) as { payload: ReturnType<typeof rollbackPayload> }; if (phase === "RESERVED") envelope.payload.previous.releaseVersion = "release-drift"; else { envelope.payload.target.webAppName = "web-drift"; envelope.payload.previous.web.readyRevision = "web-drift--rev-1"; } await prisma.customerDeployment.update({ where: { id: drifted.id }, data: { releaseLeaseRollbackRecord: envelope as Prisma.InputJsonValue } }); const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } }); await expectCode(heartbeatManagedReleaseLease(driftedHandle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT"); expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: drifted.id } })).toEqual(before); }
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
  it("rejects every eligibility drift after mutation begins and leaves the row unchanged", async () => {
    const drifts: Prisma.CustomerDeploymentUncheckedUpdateInput[] = [
      { customerAccountId: null }, { deploymentKind: "SHARED_WORKSPACE" }, { cloudProvider: "RAILWAY" },
      { environment: "staging" }, { deploymentStatus: "SUSPENDED" }, { provisioningStatus: "draft" },
    ];
    for (const data of drifts) {
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
});
