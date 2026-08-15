import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureAuthorizedTenantPurgeManifestValues } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import { createTenantPurgePrismaAuthorizeAndCapture as create } from "./tenant-purge-prisma-reader";
const database = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
const writer = new PrismaClient();
const sql: string[] = [];
let barrier: null | (() => Promise<void>) = null;
database.$on("query", (event) => sql.push(event.query));
const extended = database.$extends({ query: { tenantPurgeRun: { async findUnique({ args, query }) {
  const row = await query(args);
  if (barrier) await barrier();
  return row;
} } } });
beforeAll(() => {
  (globalThis as any).prismaGlobal = extended;
  (globalThis as any).prismaGlobalUrl = process.env.DATABASE_URL;
});
afterAll(async () => Promise.all([database.$disconnect(), writer.$disconnect()]));
const SHA = "a".repeat(40);
function key() {
  let value = createTenantPurgeOwnedVector<number>(32);
  for (let index = 0; index < 32; index += 1) value = pushTenantPurgeOwnedVector(value, index);
  return value;
}
async function fixture(mode: "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE") {
  const suffix = randomUUID();
  const workspace = await database.workspace.create({ data: { slug: `pr2b1-${suffix}`, name: "PR2B1" } });
  const account = mode === "ACCOUNT_WORKSPACE" ? await database.customerAccount.create({
    data: { slug: `pr2b1-${suffix}`, displayName: "PR2B1" },
  }) : null;
  const deployment = await database.customerDeployment.create({ data: {
    label: "PR2B1", url: `https://${suffix}.example.test`, managedWorkspaceId: workspace.id,
    customerAccountId: account?.id ?? null,
  } });
  const trial = mode === "SELF_SERVE_TRIAL_WORKSPACE" ? await database.procurementTrial.create({ data: {
    workspaceId: workspace.id, companyName: "PR2B1", adminEmail: `${suffix}@example.test`,
    emailDomain: "example.test", acceptedTermsVersion: "v1", trialExpiresAt: new Date(Date.now() + 60_000),
  } }) : null;
  const targetId = account?.id ?? trial!.id;
  const canonical = `${mode}:${targetId}:${deployment.id}:${workspace.id}`;
  const run = await database.tenantPurgeRun.create({ data: { mode, targetAccountId: account?.id,
    targetDeploymentId: deployment.id, targetWorkspaceId: workspace.id, targetTrialId: trial?.id,
    canonicalTargetKey: canonical, activeTargetKey: canonical, capabilitySha: SHA,
    requestedByUserId: randomUUID(), reason: "pr2b1 test" } });
  return { mode, workspace, account, deployment, trial, run };
}
async function capture(target: Awaited<ReturnType<typeof fixture>>) {
  const callback = create(true, target.mode, target.run.id, key(), 10, 20, 30, 40);
  return captureAuthorizedTenantPurgeManifestValues(true, target.mode, callback);
}
async function durable(target: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(await Promise.all([
    database.workspace.findUnique({ where: { id: target.workspace.id } }),
    database.customerDeployment.findUnique({ where: { id: target.deployment.id } }),
    target.account ? database.customerAccount.findUnique({ where: { id: target.account.id } }) : null,
    target.trial ? database.procurementTrial.findUnique({ where: { id: target.trial.id } }) : null,
    database.tenantPurgeRun.findUnique({ where: { id: target.run.id } }),
  ]));
}
async function cleanup(target: Awaited<ReturnType<typeof fixture>>) {
  await database.tenantPurgeRun.deleteMany({ where: { id: target.run.id } });
  if (target.trial) await database.procurementTrial.delete({ where: { id: target.trial.id } });
  await database.customerDeployment.delete({ where: { id: target.deployment.id } });
  if (target.account) await database.customerAccount.delete({ where: { id: target.account.id } });
  await database.workspace.delete({ where: { id: target.workspace.id } });
}
describe("tenant purge Prisma snapshot adapter integration", () => {
  it("captures both modes and leaves exact durable rows unchanged", async () => {
    for (const mode of ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"] as const) {
      const target = await fixture(mode);
      const before = await durable(target);
      sql.length = 0;
      const result = await capture(target);
      const after = await durable(target);
      expect(result.blockers).toEqual(mode === "ACCOUNT_WORKSPACE" ? [] : ["TRIAL_NOT_EXPIRED"]);
      expect(after).toBe(before);
      expect(sql.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
      await cleanup(target);
    }
  });
  it("holds one repeatable snapshot across a committed revocation", async () => {
    const target = await fixture("ACCOUNT_WORKSPACE");
    const other = await database.workspace.create({ data: { slug: `pr2b1-${randomUUID()}`, name: "other" } });
    let started!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    barrier = async () => { started(); await held; };
    const pending = capture(target);
    await observed;
    await writer.$transaction([
      writer.customerDeployment.update({ where: { id: target.deployment.id },
        data: { managedWorkspaceId: other.id } }),
      writer.tenantPurgeRun.update({ where: { id: target.run.id }, data: {
        status: "DRY_RUN_COMPLETE", manifestDigest: "b".repeat(64),
        manifestEvidenceRef: "synthetic", manifestCapturedAt: new Date(),
      } }),
    ]);
    release();
    expect((await pending).blockers).toEqual([]);
    barrier = null;
    await expect(capture(target)).rejects.toMatchObject({ status: 403, code: "TENANT_PURGE_TARGET_FORBIDDEN" });
    await cleanup(target);
    await database.workspace.delete({ where: { id: other.id } });
  });
});
