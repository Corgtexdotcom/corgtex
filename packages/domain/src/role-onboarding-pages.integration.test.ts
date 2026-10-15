import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getPrismaClient } from "../../shared/src/db";
import { recordArtifactInputLineage, type LineageInput } from "./source-lineage";
import { buildRoleOnboardingContextWithLineageForConversation } from "./role-onboarding";

beforeEach(truncateAllTables);
afterEach(() => { vi.restoreAllMocks(); });

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic onboarding pages", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" }, include: { user: true } });
  const actor: AppActor = { kind: "user", user };
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Operations", purposeMd: "Mandatory circle purpose" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Integrator", purposeMd: "Mandatory role purpose", accountabilities: ["Mandatory accountability"], artifacts: ["Dashboard"] } });
  const conversation = await prisma.conversationSession.create({ data: { workspaceId: workspace.id, userId: user.id, agentKey: "role-onboarding" } });
  const session = await prisma.roleOnboardingSession.create({ data: { workspaceId: workspace.id, roleId: role.id, memberId: member.id, conversationId: conversation.id } });
  const original = async (kind: LineageInput["kind"], row: { id: string }) => prisma.$transaction((tx) => recordArtifactInputLineage({
    tx, actor, workspaceId: workspace.id, artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [],
  }));
  for (const [kind, row] of [["Member", member], ["Circle", circle], ["Role", role], ["ConversationSession", conversation], ["RoleOnboardingSession", session]] as const) await original(kind, row);
  return { workspaceId: workspace.id, userId: user.id, conversationId: conversation.id, actor, member, circle, original };
}

async function candidates(f: Awaited<ReturnType<typeof fixture>>, denied: number, readable: number, allKinds = true) {
  const now = new Date("2026-01-01T00:00:00Z");
  const ids = Array.from({ length: denied + readable }, (_, index) => String(index).padStart(6, "0"));
  await prisma.action.createMany({ data: ids.map((id) => ({ id: `action-${id}`, workspaceId: f.workspaceId, circleId: f.circle.id,
    authorUserId: f.userId, title: `Action ${id}`, bodyMd: "Synthetic body ".repeat(100), status: "OPEN", updatedAt: now })) });
  if (allKinds) {
    await prisma.tension.createMany({ data: ids.map((id) => ({ id: `tension-${id}`, workspaceId: f.workspaceId, circleId: f.circle.id,
      authorUserId: f.userId, title: `Tension ${id}`, bodyMd: "Synthetic body ".repeat(100), status: "OPEN", priority: 3, updatedAt: now })) });
    await prisma.proposal.createMany({ data: ids.map((id) => ({ id: `proposal-${id}`, workspaceId: f.workspaceId, circleId: f.circle.id,
      authorUserId: f.userId, title: `Proposal ${id}`, bodyMd: "Synthetic body ".repeat(100), status: "OPEN", updatedAt: now })) });
    await prisma.policyCorpus.createMany({ data: ids.map((id) => ({ id: `policy-${id}`, workspaceId: f.workspaceId, circleId: f.circle.id,
      proposalId: `proposal-${id}`, title: `Policy ${id}`, bodyMd: "Synthetic policy body", acceptedAt: now })) });
    await prisma.meeting.createMany({ data: ids.map((id) => ({ id: `meeting-${id}`, workspaceId: f.workspaceId,
      source: "manual", title: `Meeting ${id}`, transcript: "Synthetic body ".repeat(100), summaryMd: "Synthetic summary",
      participantIds: [f.member.id], recordedAt: now })) });
  }
  for (const id of ids.slice(denied)) {
    await f.original("Action", await prisma.action.findUniqueOrThrow({ where: { id: `action-${id}` } }));
    if (!allKinds) continue;
    await f.original("Tension", await prisma.tension.findUniqueOrThrow({ where: { id: `tension-${id}` } }));
    await f.original("Proposal", await prisma.proposal.findUniqueOrThrow({ where: { id: `proposal-${id}` } }));
    await f.original("PolicyCorpus", await prisma.policyCorpus.findUniqueOrThrow({ where: { id: `policy-${id}` } }));
    await f.original("Meeting", await prisma.meeting.findUniqueOrThrow({ where: { id: `meeting-${id}` } }));
  }
}

it("pages all five persisted candidate kinds through denied prefixes with stable ties and bounded hydration", async () => {
  const f = await fixture();
  await candidates(f, 101, 9);
  const sizes: number[] = [];
  const client = getPrismaClient();
  for (const delegate of [client.action, client.tension, client.proposal, client.policyCorpus, client.meeting]) {
    // Observe the real client delegates; the exported lazy proxy cannot be spied on.
    const model = delegate as unknown as { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
    const find = model.findMany.bind(model);
    vi.spyOn(model, "findMany").mockImplementation(async (args) => {
      const rows = await find(args);
      sizes.push(rows.length);
      return rows;
    });
  }
  const result = await buildRoleOnboardingContextWithLineageForConversation(f);
  expect(sizes.length, "real Prisma hydration observations").toBeGreaterThan(0);
  expect(Math.max(...sizes), "maximum materialized candidate page").toBeLessThanOrEqual(100);
  expect(result?.context).toContain("Mandatory role purpose");
  expect(result?.context).toContain("Mandatory circle purpose");
  expect(result?.context).toContain("Mandatory accountability");
  for (const [kind, prefix, take] of [["PolicyCorpus", "policy", 5], ["Action", "action", 8], ["Tension", "tension", 8], ["Proposal", "proposal", 5], ["Meeting", "meeting", 5]] as const) {
    expect(result?.lineageInputs.filter((input) => input.kind === kind).map((input) => input.id)).toEqual(
      Array.from({ length: take }, (_, i) => `${prefix}-${String(101 + i).padStart(6, "0")}`));
  }
  console.log(JSON.stringify({ scenario: "five-kind-denied-prefix", maximumHydratedPage: Math.max(...sizes), selected: result?.lineageInputs.length }));
}, 60_000);

it("finds eight readable actions beyond a 5001-row denied prefix without a global scan cap", async () => {
  const f = await fixture();
  await candidates(f, 5001, 8, false);
  const result = await buildRoleOnboardingContextWithLineageForConversation(f);
  expect(result?.lineageInputs.filter((input) => input.kind === "Action").map((input) => input.id)).toEqual(
    Array.from({ length: 8 }, (_, i) => `action-${String(5001 + i).padStart(6, "0")}`));
}, 120_000);

it.each(["head", "source-revoke-restore", "caller-revoke-restore"] as const)("withholds the selected original proof after a late %s change", async (change) => {
  const f = await fixture();
  await candidates(f, 0, 1, false);
  let mutated = false;
  const changeInput = async () => {
    if (change === "head") {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Action", artifactId: "action-000000" }, orderBy: { revision: "desc" } });
      const { id: _id, ...data } = head;
      await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1, inputsJson: [], rootsJson: [], permissionEpochsJson: head.permissionEpochsJson! } });
    } else if (change === "source-revoke-restore") {
      await prisma.action.update({ where: { id: "action-000000" }, data: { isPrivate: true } });
      await prisma.action.update({ where: { id: "action-000000" }, data: { isPrivate: false } });
    } else {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    }
  };
  const client = getPrismaClient();
  const transaction = client.$transaction.bind(client);
  vi.spyOn(client, "$transaction").mockImplementation((async (...args: Parameters<typeof transaction>) => {
    if (!mutated && args[1]?.isolationLevel === "RepeatableRead") {
      mutated = true;
      await changeInput();
    }
    return transaction(...args);
  }) as typeof client.$transaction);
  const result = await buildRoleOnboardingContextWithLineageForConversation(f);
  expect(mutated, "mutation boundary was exercised").toBe(true);
  expect(result).toBeNull();
});
