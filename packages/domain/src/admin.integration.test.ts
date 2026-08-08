import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { PrismaClient, type ProviderCutoverStatus } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { removeCustomerDeployment } from "./admin";

const run = randomUUID().slice(0, 8);
const CONFLICT = {
  status: 409,
  code: "CUSTOMER_DEPLOYMENT_CUTOVER_CONFLICT",
  message: "Customer deployment is referenced by a provider cutover and cannot be removed.",
};
const EVIDENCE = { run, marker: "keep-me" };
const STATUSES: ProviderCutoverStatus[] = [
  "PLANNED", "SHADOW", "CUTOVER", "OBSERVING", "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED", "ROLLED_BACK",
];
const operator = (tag: string): AppActor => ({
  kind: "user",
  user: { id: `op-${run}-${tag}`, email: `op-${run}-${tag}@test.local`, displayName: "Operator", globalRole: "OPERATOR" },
});
const removedEvents = (tag: string) =>
  prisma.customerDeploymentEvent.findMany({ where: { action: "customer_deployment.removed", actorUserId: `op-${run}-${tag}` } });
const makeAccount = () =>
  prisma.customerAccount.create({ data: { slug: `acct-${run}-${randomUUID().slice(0, 8)}`, displayName: "Acct" } });
const makeDeployment = (customerAccountId?: string) =>
  prisma.customerDeployment.create({ data: { label: `dep-${run}`, url: `https://${randomUUID()}.test.local`, customerAccountId } });
const makeCutover = (
  customerAccountId: string,
  sourceDeploymentId: string,
  destinationDeploymentId: string | null,
  status: ProviderCutoverStatus
) => {
  const transitionKey = randomUUID();
  return prisma.providerCutover.create({
    data: {
      customerAccountId, sourceDeploymentId, destinationDeploymentId, status,
      sourceProvider: "RAILWAY", destinationProvider: "AZURE",
      reason: "integration guard", transitionKey, evidence: EVIDENCE,
      activeTransitionKey: status === "DELETED" || status === "ROLLED_BACK" ? null : transitionKey,
      sourceDeletedAt: status === "DELETED" ? new Date() : null,
    },
  });
};

describe("removeCustomerDeployment cutover guard", () => {
  it("removes an unreferenced deployment and leaves exactly one event with deploymentId null", async () => {
    const deployment = await makeDeployment();
    await removeCustomerDeployment(operator("ok"), deployment.id);

    expect(await prisma.customerDeployment.findUnique({ where: { id: deployment.id } })).toBeNull();
    const events = await removedEvents("ok");
    expect(events).toHaveLength(1);
    expect(events[0].deploymentId).toBeNull();
  });
  it.each(STATUSES)("rejects when a %s cutover references the deployment as source", async (status) => {
    const account = await makeAccount();
    const deployment = await makeDeployment(account.id);
    const spareDestination = await makeDeployment(account.id);
    const cutover = await makeCutover(account.id, deployment.id, spareDestination.id, status);
    await expect(removeCustomerDeployment(operator(`src-${status}`), deployment.id)).rejects.toMatchObject(CONFLICT);
    expect(await prisma.customerDeployment.findUnique({ where: { id: deployment.id } })).not.toBeNull();
    const persisted = await prisma.providerCutover.findUnique({ where: { id: cutover.id } });
    expect(persisted?.status).toBe(status);
    expect(persisted?.evidence).toEqual(EVIDENCE);
    expect(await removedEvents(`src-${status}`)).toEqual([]);
  });

  it("rejects when a cutover references the deployment as destination", async () => {
    const account = await makeAccount();
    const source = await makeDeployment(account.id);
    const destination = await makeDeployment(account.id);
    const cutover = await makeCutover(account.id, source.id, destination.id, "PLANNED");
    await expect(removeCustomerDeployment(operator("dest"), destination.id)).rejects.toMatchObject(CONFLICT);
    expect(await prisma.customerDeployment.findUnique({ where: { id: destination.id } })).not.toBeNull();
    expect((await prisma.providerCutover.findUnique({ where: { id: cutover.id } }))?.evidence).toEqual(EVIDENCE);
    expect(await removedEvents("dest")).toEqual([]);
  });

  it("rejects a non-operator without any write or false event", async () => {
    const deployment = await makeDeployment();
    const outsider = {
      kind: "user",
      user: { id: `op-${run}-auth`, email: "outsider@test.local", displayName: "Outsider" },
    } as AppActor;
    await expect(removeCustomerDeployment(outsider, deployment.id)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await prisma.customerDeployment.findUnique({ where: { id: deployment.id } })).not.toBeNull();
    expect(await removedEvents("auth")).toEqual([]);
  });

  it("keeps the missing-deployment failure distinct from the sanitized cutover conflict", async () => {
    const error = await removeCustomerDeployment(operator("missing"), randomUUID()).catch((e) => e);
    expect(error.code).not.toBe(CONFLICT.code);
    expect(error.message).not.toBe(CONFLICT.message);
    expect(await removedEvents("missing")).toEqual([]);
  });

  it("maps a delete-time restrict violation from a concurrent cutover insert to the conflict", async () => {
    const account = await makeAccount();
    const deployment = await makeDeployment(account.id);
    const locker = new PrismaClient();
    let releaseLock: () => void = () => {};
    let lockAcquired: () => void = () => {};
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
    try {
      const lockTx = locker.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "CustomerDeploymentEvent" IN ACCESS EXCLUSIVE MODE');
        lockAcquired();
        await new Promise<void>((resolve) => { releaseLock = resolve; });
      }, { timeout: 30_000, maxWait: 10_000 });
      // Bounded acquisition: an unref'd timer or a lockTx failure rejects instead of hanging CI.
      const acquisition = await Promise.race([
        acquired.then(() => null),
        lockTx.then(() => new Error("lock transaction ended before release"), (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve(new Error("timed out acquiring the event table lock")), 10_000).unref()),
      ]);
      if (acquisition) throw acquisition;
      const removal = removeCustomerDeployment(operator("race"), deployment.id).then(
        () => { throw new Error("removal unexpectedly succeeded"); },
        (error: unknown) => error
      );
      // The removal transaction must be observed blocked on its event INSERT after the
      // precheck; the poll is bounded and a timeout fails with diagnostic lock state.
      const deadline = Date.now() + 3_000;
      let blocked: unknown[] = [];
      while (Date.now() < deadline && blocked.length === 0) {
        blocked = await prisma.$queryRawUnsafe<unknown[]>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%INSERT INTO%CustomerDeploymentEvent%'`
        );
        if (blocked.length === 0) await new Promise((r) => setTimeout(r, 50));
      }
      if (blocked.length === 0) {
        const activity = await prisma.$queryRawUnsafe(
          `SELECT pid, state, wait_event_type, left(query, 200) AS query
           FROM pg_stat_activity WHERE datname = current_database()`
        );
        throw new Error(`Removal event insert was never observed blocked: ${JSON.stringify(activity)}`);
      }
      const cutover = await makeCutover(account.id, deployment.id, null, "PLANNED");
      releaseLock();
      expect(await removal).toMatchObject(CONFLICT);
      expect(await prisma.customerDeployment.findUnique({ where: { id: deployment.id } })).not.toBeNull();
      const persisted = await prisma.providerCutover.findUnique({ where: { id: cutover.id } });
      expect(persisted?.evidence).toEqual(EVIDENCE);
      expect(await removedEvents("race")).toEqual([]);
    } finally {
      releaseLock();
      await locker.$disconnect();
    }
  });
});
