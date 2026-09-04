import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordVerifiedControlPlaneRelease } from "./control-plane";
import {
  abortManagedReleaseLease,
  acquireManagedReleaseLease,
  beginManagedReleaseMutation,
  heartbeatManagedReleaseLease,
  recordManagedReleaseRollbackRecord,
} from "./control-plane-release-lease";
import { registerCustomerDeployment } from "./customer-lifecycle";

const prisma = getPrismaClient();
const BASE = `sha-${"a".repeat(40)}`;
const NEXT = `sha-${"b".repeat(40)}`;
const SUBSCRIPTION = "123e4567-e89b-12d3-a456-426614174000";
const [RESOURCE_GROUP, WEB, WORKER, ACR] = ["rg.Safe_1", "web-app", "worker-app", "acr12.azurecr.io"];
const DIGESTS = ["1", "2", "3", "4"].map((value) => `sha256:${value.repeat(64)}`);
const actor: AppActor = {
  kind: "agent",
  authProvider: "control-plane",
  label: "synthetic-release-guard",
  scopes: ["control-plane:read", "control-plane:releases:write"],
};
function rollbackPayload() {
  return {
    schemaVersion: 1,
    target: {
      subscriptionId: SUBSCRIPTION,
      resourceGroup: RESOURCE_GROUP,
      acrName: "acr12",
      acrServer: ACR,
      webAppName: WEB,
      workerAppName: WORKER,
    },
    previous: {
      releaseVersion: "release-1",
      web: { containerName: "web--old", image: `${ACR}/corgtex/web@${DIGESTS[0]}`, readyRevision: `${WEB}--rev-1`, templateDigest: DIGESTS[2] },
      worker: { containerName: "worker--old", image: `${ACR}/corgtex/worker@${DIGESTS[1]}`, readyRevision: `${WORKER}--rev-2`, templateDigest: DIGESTS[3] },
    },
    incoming: { webDigest: DIGESTS[0], workerDigest: DIGESTS[1] },
  };
}
function managedInput(suffix: string = randomUUID()) {
  return {
    accountSlug: `guard-${suffix}`,
    accountDisplayName: "Synthetic guard account",
    accountStatus: "ACTIVE" as const,
    label: "Synthetic managed Azure",
    url: `https://${suffix}.example.test`,
    deploymentKind: "REMOTE_MANAGED" as const,
    deploymentStatus: "ACTIVE" as const,
    cloudProvider: "AZURE" as const,
    customerSlug: `guard-${suffix}`,
    environment: "production",
    releaseImageTag: BASE,
    releaseVersion: "release-1",
    provisioningStatus: "active",
    providerSubscriptionId: SUBSCRIPTION,
    providerResourceGroup: RESOURCE_GROUP,
    providerWebServiceId: WEB,
    providerWorkerServiceId: WORKER,
  };
}
async function createManaged() {
  return (await registerCustomerDeployment(managedInput())).deployment;
}
function acquire(deploymentId: string) {
  return acquireManagedReleaseLease({
    deploymentId,
    expectedImageTag: BASE,
    incomingImageTag: NEXT,
    incomingVersion: "release-2",
    owner: "fleet:synthetic-test",
  });
}
function errorDetail(error: unknown) {
  return `${String(error)} ${JSON.stringify(error)}`;
}
async function rejected(operation: Promise<unknown>) {
  const error = await operation.then(() => null, (reason: unknown) => reason);
  expect(error).toBeTruthy();
  return error;
}
function expectUpdateGuard(error: unknown, secrets: string[] = []) {
  const detail = errorDetail(error);
  expect(detail).toContain("23514");
  expect(detail).toContain("MANAGED_RELEASE_LEASE_UPDATE_CONFLICT");
  for (const secret of secrets) expect(detail).not.toContain(secret);
}
async function expectDatabaseDiagnostic(deploymentId: string) {
  expect(deploymentId).toMatch(/^[0-9a-f-]{36}$/);
  await prisma.$executeRawUnsafe(`
    DO $guard$
    DECLARE actual_state text; actual_constraint text; actual_message text;
    BEGIN
      BEGIN
        UPDATE public."CustomerDeployment" SET "notes" = 'diagnostic drift' WHERE "id" = '${deploymentId}';
        RAISE EXCEPTION 'update guard did not fire';
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE,
          actual_constraint = CONSTRAINT_NAME, actual_message = MESSAGE_TEXT;
        IF ROW(actual_state, actual_constraint, actual_message) IS DISTINCT FROM
          ROW('23514', 'CustomerDeployment_release_lease_update_guard', 'MANAGED_RELEASE_LEASE_UPDATE_CONFLICT') THEN
          RAISE EXCEPTION 'unexpected update-guard diagnostics';
        END IF;
      END;
    END $guard$;
  `);
}
async function expire(deploymentId: string) {
  const now = Date.now();
  await prisma.customerDeployment.update({
    where: { id: deploymentId },
    data: {
      releaseLeaseAcquiredAt: new Date(now - 600_000),
      releaseLeaseHeartbeatAt: new Date(now - 300_000),
      releaseLeaseExpiresAt: new Date(now - 60_000),
    },
  });
}
async function leasedState(phase: "RESERVED" | "MUTATING" | "RECOVERY_REQUIRED", expired = false) {
  const deployment = await createManaged();
  const handle = await acquire(deployment.id);
  if (phase !== "RESERVED") {
    await recordManagedReleaseRollbackRecord(handle, rollbackPayload());
    await beginManagedReleaseMutation(handle);
  }
  if (phase === "RECOVERY_REQUIRED") {
    await prisma.customerDeployment.update({
      where: { id: deployment.id },
      data: { releaseLeasePhase: "RECOVERY_REQUIRED", releaseLeaseError: "synthetic recovery" },
    });
  }
  if (expired) await expire(deployment.id);
  return { deployment, handle };
}

beforeEach(async () => truncateAllTables());
afterEach(() => vi.unstubAllGlobals());

describe("CustomerDeployment retained-lease update guard", () => {
  it("installs one exact collision-intolerant ALWAYS trigger", async () => {
    const functions = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT p.pronargs::text AS "argumentCount", pg_get_function_result(p.oid) AS "resultType",
        l.lanname AS language, md5(p.prosrc) AS "sourceHash"
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname = 'customer_deployment_release_lease_update_guard_v1'
    `;
    const triggers = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT t.tgname AS name, t.tgenabled AS enabled, t.tgisinternal AS internal,
        (t.tgtype & 1) = 1 AS "rowLevel", (t.tgtype & 2) = 2 AS "before",
        (t.tgtype & 16) = 16 AS "onUpdate", p.proname AS function
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = 'CustomerDeployment'
        AND t.tgname = 'CustomerDeployment_release_lease_update_guard'
    `;
    expect(functions).toEqual([expect.objectContaining({ argumentCount: "0", resultType: "trigger", language: "plpgsql" })]);
    expect(triggers).toEqual([{
      name: "CustomerDeployment_release_lease_update_guard",
      enabled: "A",
      internal: false,
      rowLevel: true,
      before: true,
      onUpdate: true,
      function: "customer_deployment_release_lease_update_guard_v1",
    }]);
    const snapshot = { functions, triggers };
    const functionCollision = await rejected(prisma.$transaction((tx) => tx.$executeRawUnsafe(`
      CREATE FUNCTION public.customer_deployment_release_lease_update_guard_v1()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
    `)));
    const triggerCollision = await rejected(prisma.$transaction((tx) => tx.$executeRawUnsafe(`
      CREATE TRIGGER "CustomerDeployment_release_lease_update_guard"
      BEFORE UPDATE ON public."CustomerDeployment" FOR EACH ROW
      EXECUTE FUNCTION public.customer_deployment_release_lease_update_guard_v1()
    `)));
    expect(errorDetail(functionCollision)).toContain("42723");
    expect(errorDetail(triggerCollision)).toContain("42710");
    expect({
      functions: await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT p.pronargs::text AS "argumentCount", pg_get_function_result(p.oid) AS "resultType",
          l.lanname AS language, md5(p.prosrc) AS "sourceHash"
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.proname = 'customer_deployment_release_lease_update_guard_v1'`,
      triggers: await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT t.tgname AS name, t.tgenabled AS enabled, t.tgisinternal AS internal,
          (t.tgtype & 1) = 1 AS "rowLevel", (t.tgtype & 2) = 2 AS "before",
          (t.tgtype & 16) = 16 AS "onUpdate", p.proname AS function
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND c.relname = 'CustomerDeployment'
          AND t.tgname = 'CustomerDeployment_release_lease_update_guard'`,
    }).toEqual(snapshot);
  });

  it("preserves unleased Railway and Azure self-serve lifecycle updates", async () => {
    const railway = managedInput("railway");
    Object.assign(railway, { deploymentKind: "HOSTED_DEDICATED", cloudProvider: "RAILWAY", providerSubscriptionId: null, providerResourceGroup: null, providerWebServiceId: null, providerWorkerServiceId: null });
    await registerCustomerDeployment(railway);
    expect((await registerCustomerDeployment({ ...railway, label: "Railway active", deploymentStatus: "ACTIVE" })).deployment.label).toBe("Railway active");
    const azure = managedInput("selfserve");
    Object.assign(azure, { deploymentKind: "SHARED_WORKSPACE", deploymentStatus: "PROVISIONING", provisioningStatus: "provisioning", releaseImageTag: null, releaseVersion: null });
    await registerCustomerDeployment(azure);
    expect((await registerCustomerDeployment({ ...azure, label: "Azure self-serve active", deploymentStatus: "ACTIVE", provisioningStatus: "active" })).deployment.label).toBe("Azure self-serve active");
  });

  it("rejects generic, no-op, and mixed writes in every retained phase", async () => {
    for (const state of ["RESERVED", "MUTATING", "RECOVERY_REQUIRED", "EXPIRED"] as const) {
      await truncateAllTables();
      const { deployment, handle } = await leasedState(state === "EXPIRED" ? "RESERVED" : state, state === "EXPIRED");
      if (state === "RESERVED") await expectDatabaseDiagnostic(deployment.id);
      const initial = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
      const writes: Prisma.CustomerDeploymentUncheckedUpdateInput[] = [
        { notes: `generic-${state}` },
        { label: initial.label },
        { notes: `mixed-${state}`, releaseLeaseError: `lease-${state}` },
      ];
      for (const data of writes) {
        const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
        const error = await rejected(prisma.customerDeployment.update({ where: { id: deployment.id }, data }));
        expectUpdateGuard(error, [handle.capability, before.releaseLeaseTokenHash!, WEB, SUBSCRIPTION]);
        expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } })).toEqual(before);
      }
    }
  });

  it("fires under replica role and restores the isolated rolled-back session", async () => {
    const { deployment, handle } = await leasedState("RESERVED");
    const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
    let triggerError: unknown;
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe("SAVEPOINT update_guard_attempt");
      triggerError = await tx.$executeRaw`UPDATE "CustomerDeployment" SET "notes" = 'replica drift' WHERE "id" = ${deployment.id}`.then(() => null, (error: unknown) => error);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT update_guard_attempt");
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
      expect(await tx.$queryRaw<Array<{ role: string }>>`SELECT current_setting('session_replication_role') AS role`).toEqual([{ role: "origin" }]);
      throw new Error("ROLLBACK_REPLICA_GUARD_TEST");
    })).rejects.toThrow("ROLLBACK_REPLICA_GUARD_TEST");
    expectUpdateGuard(triggerError, [handle.capability, before.releaseLeaseTokenHash!]);
    expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } })).toEqual(before);
  });

  it("preserves lease transitions, pure clear, persistent fence, and delete guard", async () => {
    const first = await createManaged();
    const firstHandle = await acquire(first.id);
    await heartbeatManagedReleaseLease(firstHandle);
    await recordManagedReleaseRollbackRecord(firstHandle, rollbackPayload());
    await beginManagedReleaseMutation(firstHandle);
    expect((await prisma.customerDeployment.findUniqueOrThrow({ where: { id: first.id } })).releaseLeasePhase).toBe("MUTATING");
    const beforeDelete = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: first.id } });
    const deleteError = await rejected(prisma.customerDeployment.delete({ where: { id: first.id } }));
    expect(errorDetail(deleteError)).toContain("MANAGED_RELEASE_LEASE_DELETE_CONFLICT");
    expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: first.id } })).toEqual(beforeDelete);

    await truncateAllTables();
    const second = await createManaged();
    const stale = await acquire(second.id);
    await expire(second.id);
    const current = await acquire(second.id);
    expect(current.fence).toBe(stale.fence + 1);
    await abortManagedReleaseLease(current);
    const cleared = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: second.id } });
    expect(cleared.releaseLeaseFence).toBe(current.fence);
    expect(Object.entries(cleared).filter(([key]) => key.startsWith("releaseLease") && key !== "releaseLeaseFence").every(([, value]) => value === null)).toBe(true);
  });

  it("rejects the real generic registration writer for a leased URL", async () => {
    const input = managedInput("registered");
    const deployment = (await registerCustomerDeployment(input)).deployment;
    const handle = await acquire(deployment.id);
    const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
    const error = await rejected(registerCustomerDeployment({ ...input, notes: "generic lifecycle drift" }));
    expectUpdateGuard(error, [handle.capability, before.releaseLeaseTokenHash!, WEB, SUBSCRIPTION]);
    expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } })).toEqual(before);
  });

  it("rejects verified-release publication under a retained lease after health proof", async () => {
    const deployment = await createManaged();
    const handle = await acquire(deployment.id);
    const before = await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        database: "up",
        schema: "ready",
        runtime: { redis: "configured", storage: "configured" },
        release: { imageTag: NEXT, gitSha: NEXT.slice(4), version: "release-2" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await rejected(recordVerifiedControlPlaneRelease(actor, {
      deploymentId: deployment.id,
      releaseImageTag: NEXT,
      releaseVersion: "release-2",
      reason: "Synthetic post-health verification.",
    }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 409, code: "MANAGED_AZURE_TARGET_DRIFT" });
    for (const secret of [handle.capability, before.releaseLeaseTokenHash!, WEB, SUBSCRIPTION]) {
      expect(errorDetail(error)).not.toContain(secret);
    }
    expect(await prisma.customerDeployment.findUniqueOrThrow({ where: { id: deployment.id } })).toEqual(before);
    expect(await prisma.customerReleaseTarget.count({ where: { deploymentId: deployment.id } })).toBe(0);
    expect(await prisma.customerDeploymentEvent.count({ where: { deploymentId: deployment.id, action: "control_plane.release.verified_recorded" } })).toBe(0);
    expect(await prisma.fleetHealthSnapshot.count({ where: { deploymentId: deployment.id } })).toBe(0);
  });
});
