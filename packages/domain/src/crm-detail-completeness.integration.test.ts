import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createActivity, createContact, createCrmAccount, createDeal, getContact, getCrmAccount } from "./crm";
import { withCrmReadSnapshot } from "./crm-lineage";
import { capturePermissionEpochs } from "./source-permission-epochs";
import { lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
  || database.pathname !== "/corgtex_test" || database.searchParams.get("schema") !== "public") {
  throw new Error("CRM detail tests require a disposable loopback corgtex_test database.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic CRM detail", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const account = await createCrmAccount(actor, { workspaceId: workspace.id, name: "Synthetic detail account" });
  return { workspaceId: workspace.id, actor, user, member, account };
}

async function seedRelations(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const kind of ["CrmContact", "CrmDeal"] as const) for (let offset = 0; offset < count; offset += 100) {
    const ids = Array.from({ length: Math.min(100, count - offset) }, (_, index) => `${kind}-${String(offset + index).padStart(6, "0")}`);
    if (kind === "CrmContact") await prisma.crmContact.createMany({ data: ids.map(id => ({ id, workspaceId: f.workspaceId,
      accountId: f.account.id, email: `${id}@example.test`, lastSeenAt: now })) });
    else await prisma.crmDeal.createMany({ data: ids.map(id => ({ id, workspaceId: f.workspaceId, accountId: f.account.id,
      contactId: "CrmContact-000000", title: id, updatedAt: now })) });
    const rows = kind === "CrmContact" ? await prisma.crmContact.findMany({ where: { id: { in: ids } } })
      : await prisma.crmDeal.findMany({ where: { id: { in: ids } } });
    await prisma.$transaction(async tx => {
      const epochs = await capturePermissionEpochs(tx, f.workspaceId, [{ kind: "Workspace", id: f.workspaceId },
        { kind: "MemberUserPolicy", id: f.user.id }, { kind: "WorkspaceSupportPolicy", id: f.user.id },
        { kind: "CrmAccount", id: f.account.id }, ...(kind === "CrmDeal" ? [{ kind: "CrmContact", id: "CrmContact-000000" }] : []),
        ...ids.map(id => ({ kind, id }))]);
      await tx.artifactInputLineage.createMany({ data: rows.map(row => ({ workspaceId: f.workspaceId, artifactType: kind,
        artifactId: row.id, revision: 1, origin: "HUMAN_ORIGINAL", contentHash: lineageContentFingerprint(kind, row),
        inputsJson: [], rootsJson: [], epochProofVersion: 1,
        permissionEpochsJson: { ...epochs, entries: epochs.entries.filter(entry => entry.kind !== kind || entry.id === row.id) } })) });
    });
  }
}

it("returns all 5001 account contacts, account deals and contact deals with bounded canonical pages", async () => {
  const f = await fixture();
  await seedRelations(f, 5001);
  const contacts = vi.spyOn(prisma.crmContact, "findMany"), deals = vi.spyOn(prisma.crmDeal, "findMany");
  const activities = vi.spyOn(prisma.crmActivity, "findMany");
  const account = await getCrmAccount(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id });
  expect.soft(account.contacts).toHaveLength(5001);
  expect.soft(account.deals).toHaveLength(5001);
  expect.soft(account.contacts.at(-1)?.id).toBe("CrmContact-005000");
  expect.soft(account.deals.at(-1)?.id).toBe("CrmDeal-005000");
  const contact = await getContact(f.actor, { workspaceId: f.workspaceId, contactId: "CrmContact-000000" });
  expect.soft(contact.deals).toHaveLength(5001);
  expect.soft(contact.deals.at(-1)?.id).toBe("CrmDeal-005000");
  expect.soft(activities.mock.calls.length).toBeLessThan(100);
  for (const query of [...contacts.mock.calls, ...deals.mock.calls]) {
    const args = query[0];
    if (args?.take !== undefined) expect(args.take).toBeLessThanOrEqual(100);
    else expect((args?.where?.id as { in: string[] }).in.length).toBeLessThanOrEqual(100);
  }
}, 180_000);

it("preserves account pipeline metadata, mandatory contact admission and source-backed exclusions", async () => {
  const f = await fixture();
  const contact = await createContact(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id, email: "visible@example.test" });
  const deal = await createDeal(f.actor, { workspaceId: f.workspaceId, contactId: contact.id, title: "Visible deal" });
  const task = await createActivity(f.actor, { workspaceId: f.workspaceId, dealId: deal.id, type: "TASK", title: "Visible follow-up" });
  await prisma.crmActivity.create({ data: { workspaceId: f.workspaceId, dealId: deal.id, type: "TASK", title: "Unproved first task", dueAt: new Date("2020-01-01") } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: f.workspaceId, userId: other.id, role: "CONTRIBUTOR" } });
  const otherActor: AppActor = { kind: "user", user: other };
  const privateSource = await prisma.action.create({ data: { workspaceId: f.workspaceId, authorUserId: other.id,
    title: "Private source", status: "DRAFT", isPrivate: true } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: otherActor, workspaceId: f.workspaceId,
    artifact: { kind: "Action", id: privateSource.id }, content: privateSource, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const privateContact = await createContact(otherActor, { workspaceId: f.workspaceId, accountId: f.account.id,
    email: "private@example.test", lineageInputs: [{ kind: "Action", id: privateSource.id }] });
  await createDeal(otherActor, { workspaceId: f.workspaceId, contactId: privateContact.id, title: "Private-contact deal" });
  const archived = await createContact(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id, email: "archived@example.test" });
  await createDeal(f.actor, { workspaceId: f.workspaceId, contactId: archived.id, title: "Archived-contact deal" });
  await prisma.crmContact.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
  await prisma.crmContact.create({ data: { workspaceId: foreign.id, accountId: f.account.id, email: "foreign@example.test" } });
  const result = await getCrmAccount(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id });
  expect(result.contacts.map(row => row.id)).toEqual([contact.id]);
  expect(result.deals.map(row => row.id)).toEqual([deal.id]);
  expect(result.deals[0].contact.id).toBe(contact.id);
  expect(result.deals[0].activities.map(row => row.id)).toEqual([task.id]);
  expect(result.deals[0].stageTransitions).toHaveLength(1);
});

it.each(["body", "head", "revoke-restore"] as const)("retains original detail relation receipts across %s changes before release", async change => {
  const f = await fixture();
  await seedRelations(f, 101);
  const contact = { id: "CrmContact-000000" }, deal = { id: "CrmDeal-000100" };
  await expect(withCrmReadSnapshot(f.actor, f.workspaceId, async () => {
    const result = await getContact(f.actor, { workspaceId: f.workspaceId, contactId: contact.id });
    expect(result.deals).toHaveLength(101);
    if (change === "body") await prisma.crmDeal.update({ where: { id: deal.id }, data: { title: "Changed body" } });
    if (change === "head") {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "CrmDeal", artifactId: deal.id }, orderBy: { revision: "desc" } });
      await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspaceId, artifactType: head.artifactType, artifactId: deal.id,
        revision: head.revision + 1, origin: head.origin, contentHash: head.contentHash,
        inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
        epochProofVersion: head.epochProofVersion, permissionEpochsJson: head.permissionEpochsJson as Prisma.InputJsonValue } });
    }
    if (change === "revoke-restore") {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    }
    return result;
  })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it.each(["contact", "task", "transition"] as const)("revalidates selected account pipeline %s metadata before release", async kind => {
  const f = await fixture();
  const contact = await createContact(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id, email: "pipeline@example.test" });
  const deal = await createDeal(f.actor, { workspaceId: f.workspaceId, contactId: contact.id, title: "Pipeline deal" });
  const task = await createActivity(f.actor, { workspaceId: f.workspaceId, dealId: deal.id, type: "TASK", title: "Selected task" });
  await expect(withCrmReadSnapshot(f.actor, f.workspaceId, async () => {
    const result = await getCrmAccount(f.actor, { workspaceId: f.workspaceId, accountId: f.account.id });
    expect(result.deals[0].contact.id).toBe(contact.id);
    expect(result.deals[0].activities[0].id).toBe(task.id);
    const transition = result.deals[0].stageTransitions[0];
    expect(transition).toBeDefined();
    if (kind === "contact") await prisma.crmContact.update({ where: { id: contact.id }, data: { name: "Changed label" } });
    if (kind === "task") await prisma.crmActivity.update({ where: { id: task.id }, data: { title: "Changed task" } });
    if (kind === "transition") await prisma.crmDealStageTransition.update({ where: { id: transition.id }, data: { toStage: "CLOSED_WON" } });
    return result;
  })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
