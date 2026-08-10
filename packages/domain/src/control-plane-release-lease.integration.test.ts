import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, sha256 } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import {
  abortManagedReleaseLease,
  acquireManagedReleaseLease,
  beginManagedReleaseMutation,
  heartbeatManagedReleaseLease,
  recordManagedReleaseRollbackRecord,
} from "./control-plane-release-lease";

const prisma = getPrismaClient();
const BASE = `sha-${"a".repeat(40)}`;
const NEXT = `sha-${"b".repeat(40)}`;

async function deployment(overrides: Partial<Prisma.CustomerDeploymentUncheckedCreateInput> = {}) {
  const suffix = randomUUID();
  const account = await prisma.customerAccount.create({ data: { slug: `lease-${suffix}`, displayName: "Synthetic lease account" } });
  return prisma.customerDeployment.create({ data: {
    label: "Synthetic managed Azure", url: `https://${suffix}.example.test`, customerAccountId: account.id,
    deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE", environment: "production", deploymentStatus: "ACTIVE",
    provisioningStatus: "active", releaseImageTag: BASE, ...overrides,
  } });
}

function acquire(deploymentId: string, overrides = {}) {
  return acquireManagedReleaseLease({ deploymentId, expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "release-2", owner: "fleet:test", ...overrides });
}

async function expectCode(value: Promise<unknown>, code: string, status = 409) {
  await expect(value).rejects.toMatchObject({ code, status, message: "Managed release lease request was rejected." });
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
  });

  it("serializes simultaneous acquisition and heartbeats the exact owner without event noise", async () => {
    const target = await deployment();
    const attempts = await Promise.allSettled([acquire(target.id), acquire(target.id)]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const handle = attempts.find((result) => result.status === "fulfilled")!.value;
    const loser = attempts.find((result) => result.status === "rejected")!;
    expect(loser.reason).toMatchObject({ code: "MANAGED_RELEASE_LEASE_CONFLICT", status: 409 });
    const stored = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(stored.releaseLeaseTokenHash).toBe(sha256(handle.capability));
    expect(stored.releaseLeaseTokenHash).not.toBe(handle.capability);
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
    expect(current.fence).toBe(old.fence + 1);
    expect(current.leaseId).not.toBe(old.leaseId);
    const stale = [
      () => heartbeatManagedReleaseLease(old), () => recordManagedReleaseRollbackRecord(old, { revision: "old" }),
      () => beginManagedReleaseMutation(old), () => abortManagedReleaseLease(old),
    ];
    for (const operation of stale) await expectCode(operation(), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect((await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: target.id } })).map(({ action }) => action)).toEqual(["control_plane.release_lease.acquired", "control_plane.release_lease.reservation_replaced"]);
    await recordManagedReleaseRollbackRecord(current, { revision: "current" });
    await beginManagedReleaseMutation(current);
    await expectCode(acquire(target.id), "MANAGED_RELEASE_LEASE_CONFLICT");
    await expire(target.id);
    await expectCode(acquire(target.id), "MANAGED_RELEASE_RECOVERY_REQUIRED");
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeasePhase: "RECOVERY_REQUIRED" } });
    await expectCode(acquire(target.id), "MANAGED_RELEASE_RECOVERY_REQUIRED");
    expect((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } })).releaseLeaseId).toBe(current.leaseId);
  });

  it("persists one bounded semantic rollback envelope and begins mutation idempotently", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_ROLLBACK_RECORD_REQUIRED");
    await expectCode(recordManagedReleaseRollbackRecord(handle, { apiKey: "unsafe" }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(recordManagedReleaseRollbackRecord(handle, { nested: handle.capability }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(recordManagedReleaseRollbackRecord(handle, { when: new Date() }), "MANAGED_RELEASE_INVALID_INPUT", 400);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expectCode(recordManagedReleaseRollbackRecord(handle, cyclic), "MANAGED_RELEASE_INVALID_INPUT", 400);
    for (const unsafe of [{ DATABASE_URL: "redacted" }, { dsn: "postgresql://user:password@host/db" }, { telemetry: "InstrumentationKey=redacted" }, { telemetry: "ConnectionString=redacted" }]) await expectCode(recordManagedReleaseRollbackRecord(handle, unsafe), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await expectCode(recordManagedReleaseRollbackRecord(handle, JSON.parse(`{"__proto__":{"text":${JSON.stringify("x".repeat(65_537))}}}`)), "MANAGED_RELEASE_INVALID_INPUT", 400);
    await recordManagedReleaseRollbackRecord(handle, JSON.parse('{"__proto__":{"revision":"same"},"worker":{"revision":"r2"},"web":{"revision":"r1"}}'));
    await recordManagedReleaseRollbackRecord(handle, JSON.parse('{"web":{"revision":"r1"},"worker":{"revision":"r2"},"__proto__":{"revision":"same"}}'));
    await expectCode(recordManagedReleaseRollbackRecord(handle, { web: { revision: "different" } }), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const reserved = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(reserved.releaseLeaseRollbackRecord).toMatchObject({ version: 1, deploymentId: target.id, leaseId: handle.leaseId, fence: handle.fence, expectedImageTag: BASE, incomingImageTag: NEXT, incomingVersion: "release-2" });
    expect(JSON.stringify(reserved.releaseLeaseRollbackRecord)).toContain('"__proto__":{"revision":"same"}');
    await beginManagedReleaseMutation(handle);
    const retry = await beginManagedReleaseMutation(handle);
    expect(retry).not.toHaveProperty("capability");
    await expectCode(abortManagedReleaseLease(handle), "MANAGED_RELEASE_LEASE_STATE_CONFLICT");
    const events = await prisma.customerDeploymentEvent.findMany({ where: { deploymentId: target.id } });
    expect(events.map(({ action }) => action)).toEqual(["control_plane.release_lease.acquired", "control_plane.release_lease.rollback_recorded", "control_plane.release_lease.mutation_begun"]);
    expect(JSON.stringify(events)).not.toContain(handle.capability);
    expect(JSON.stringify(events)).not.toContain("revision");
  });

  it("permits safe expired-reservation abort and clears the slot without resetting its fence or baseline", async () => {
    const target = await deployment();
    const handle = await acquire(target.id);
    await recordManagedReleaseRollbackRecord(handle, { web: "prior" });
    await expire(target.id);
    await expectCode(heartbeatManagedReleaseLease(handle), "MANAGED_RELEASE_LEASE_EXPIRED");
    await expectCode(recordManagedReleaseRollbackRecord(handle, { web: "prior" }), "MANAGED_RELEASE_LEASE_EXPIRED");
    await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_LEASE_EXPIRED");
    expect(await abortManagedReleaseLease(handle)).toEqual({ deploymentId: target.id, fence: handle.fence, aborted: true });
    const cleared = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: target.id } });
    expect(Object.entries(cleared).filter(([key]) => key.startsWith("releaseLease") && key !== "releaseLeaseFence").every(([, value]) => value === null)).toBe(true);
    expect(cleared.releaseLeaseFence).toBe(handle.fence);
    expect(cleared.releaseImageTag).toBe(BASE);
  });

  it("fences every eligibility drift before provider work while retaining safe abort", async () => {
    const drifts: Prisma.CustomerDeploymentUncheckedUpdateInput[] = [
      { customerAccountId: null }, { deploymentKind: "SHARED_WORKSPACE" }, { cloudProvider: "RAILWAY" },
      { environment: "staging" }, { deploymentStatus: "SUSPENDED" }, { provisioningStatus: "draft" },
    ];
    for (const data of drifts) {
      const target = await deployment(); const handle = await acquire(target.id);
      await recordManagedReleaseRollbackRecord(handle, { web: "prior" });
      await prisma.customerDeployment.update({ where: { id: target.id }, data });
      await expectCode(heartbeatManagedReleaseLease(handle), "MANAGED_RELEASE_TARGET_INELIGIBLE");
      await expectCode(beginManagedReleaseMutation(handle), "MANAGED_RELEASE_TARGET_INELIGIBLE");
      await expect(abortManagedReleaseLease(handle)).resolves.toMatchObject({ aborted: true, fence: handle.fence });
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
    await prisma.customerDeployment.update({ where: { id: target.id }, data: { releaseLeaseFence: 2_147_483_647,
      releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null, releaseLeaseExpectedImageTag: null, releaseLeaseIncomingImageTag: null,
      releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null, releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null,
    } });
    await expectCode(acquire(target.id), "MANAGED_RELEASE_LEASE_CONFLICT");
    expect(handle.fence).toBe(1);
  });
});
