import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { updateAction } from "./actions";
import { updateGoal } from "./goals";
import { updateProposal } from "./proposals";
import { updateTension } from "./tensions";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables();
});

async function fixture() {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({
    data: { slug: `wi-concurrency-${suffix}`, name: "Work item concurrency" },
  });
  const foreignWorkspace = await prisma.workspace.create({
    data: { slug: `wi-concurrency-foreign-${suffix}`, name: "Foreign work item concurrency" },
  });
  const user = await prisma.user.create({
    data: {
      email: `wi-concurrency-${suffix}@example.com`,
      displayName: "Concurrency Editor",
      passwordHash: "test-password-hash",
    },
  });
  await prisma.member.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" },
  });
  await prisma.member.create({
    data: { workspaceId: foreignWorkspace.id, userId: user.id, role: "ADMIN" },
  });
  const actor: AppActor = {
    kind: "user",
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      globalRole: "USER",
    },
  };
  return { workspace, foreignWorkspace, user, actor };
}

async function releaseTogether<T>(calls: Array<() => Promise<T>>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const attempts = calls.map(async (call) => {
    await gate;
    return call();
  });
  release();
  return Promise.allSettled(attempts);
}

function expectOneWinner<T>(results: Array<PromiseSettledResult<T>>) {
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(results.length - 1);
  for (const result of rejected) {
    expect(result.reason).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
  }
  return fulfilled[0].value;
}

describe("work-item content concurrency matrix", () => {
  it("serializes Tension content edits and leaves stale/missing/cross-workspace attempts without effects", async () => {
    const { workspace, foreignWorkspace, user, actor } = await fixture();
    const tension = await prisma.tension.create({
      data: {
        workspaceId: workspace.id,
        authorUserId: user.id,
        title: "Original tension",
        bodyMd: "Original body",
        status: "OPEN",
        isPrivate: false,
        publishedAt: new Date(),
      },
    });

    const winner = expectOneWinner(await releaseTogether([
      () => updateTension(actor, { workspaceId: workspace.id, tensionId: tension.id, title: "Tension winner A", expectedVersion: tension.version }),
      () => updateTension(actor, { workspaceId: workspace.id, tensionId: tension.id, title: "Tension winner B", expectedVersion: tension.version }),
    ]));

    const stored = await prisma.tension.findUniqueOrThrow({ where: { id: tension.id } });
    expect(stored.title).toBe(winner.title);
    expect(stored.version).toBe(2);
    expect(await prisma.workItemVersion.count({ where: { entityType: "Tension", entityId: tension.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Tension", entityId: tension.id, action: "tension.updated" } })).toBe(1);
    expect(await prisma.event.count({ where: { aggregateType: "Tension", aggregateId: tension.id, type: "tension.updated" } })).toBe(1);

    await expect(updateTension(actor, { workspaceId: workspace.id, tensionId: tension.id, title: stored.title }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(updateTension(actor, { workspaceId: foreignWorkspace.id, tensionId: tension.id, title: "Foreign", expectedVersion: stored.version }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(updateTension(actor, { workspaceId: workspace.id, tensionId: tension.id, title: stored.title, expectedVersion: stored.version }))
      .resolves.toMatchObject({ version: stored.version });
    expect(await prisma.tension.findUniqueOrThrow({ where: { id: tension.id } })).toMatchObject({ title: stored.title, version: 2 });
    expect(await prisma.workItemVersion.count({ where: { entityType: "Tension", entityId: tension.id } })).toBe(1);
  });

  it("serializes Proposal content edits and leaves stale/missing/cross-workspace attempts without effects", async () => {
    const { workspace, foreignWorkspace, user, actor } = await fixture();
    const proposal = await prisma.proposal.create({
      data: {
        workspaceId: workspace.id,
        authorUserId: user.id,
        title: "Original proposal",
        bodyMd: "Original proposal body",
        status: "OPEN",
        isPrivate: false,
        publishedAt: new Date(),
      },
    });

    const winner = expectOneWinner(await releaseTogether([
      () => updateProposal(actor, { workspaceId: workspace.id, proposalId: proposal.id, title: "Proposal winner A", expectedVersion: proposal.version }),
      () => updateProposal(actor, { workspaceId: workspace.id, proposalId: proposal.id, title: "Proposal winner B", expectedVersion: proposal.version }),
    ]));

    const stored = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.title).toBe(winner.title);
    expect(stored.version).toBe(2);
    expect(await prisma.workItemVersion.count({ where: { entityType: "Proposal", entityId: proposal.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Proposal", entityId: proposal.id, action: "proposal.updated" } })).toBe(1);
    expect(await prisma.event.count({ where: { aggregateType: "Proposal", aggregateId: proposal.id, type: "proposal.updated" } })).toBe(1);

    await expect(updateProposal(actor, { workspaceId: workspace.id, proposalId: proposal.id, title: stored.title }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(updateProposal(actor, { workspaceId: foreignWorkspace.id, proposalId: proposal.id, title: "Foreign", expectedVersion: stored.version }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(updateProposal(actor, { workspaceId: workspace.id, proposalId: proposal.id, title: stored.title, expectedVersion: stored.version }))
      .resolves.toMatchObject({ version: stored.version });
    expect(await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ title: stored.title, version: 2 });
    expect(await prisma.workItemVersion.count({ where: { entityType: "Proposal", entityId: proposal.id } })).toBe(1);
  });

  it("serializes Action content edits and leaves stale/missing/cross-workspace attempts without effects", async () => {
    const { workspace, foreignWorkspace, user, actor } = await fixture();
    const action = await prisma.action.create({
      data: {
        workspaceId: workspace.id,
        authorUserId: user.id,
        title: "Original action",
        bodyMd: "Original action body",
        status: "OPEN",
        isPrivate: false,
        publishedAt: new Date(),
      },
    });

    const winner = expectOneWinner(await releaseTogether([
      () => updateAction(actor, { workspaceId: workspace.id, actionId: action.id, title: "Action winner A", expectedVersion: action.version }),
      () => updateAction(actor, { workspaceId: workspace.id, actionId: action.id, title: "Action winner B", expectedVersion: action.version }),
    ]));

    const stored = await prisma.action.findUniqueOrThrow({ where: { id: action.id } });
    expect(stored.title).toBe(winner.title);
    expect(stored.version).toBe(2);
    expect(await prisma.workItemVersion.count({ where: { entityType: "Action", entityId: action.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Action", entityId: action.id, action: "action.updated" } })).toBe(1);
    expect(await prisma.event.count({ where: { aggregateType: "Action", aggregateId: action.id, type: "action.updated" } })).toBe(1);

    await expect(updateAction(actor, { workspaceId: workspace.id, actionId: action.id, title: stored.title }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(updateAction(actor, { workspaceId: foreignWorkspace.id, actionId: action.id, title: "Foreign", expectedVersion: stored.version }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(updateAction(actor, { workspaceId: workspace.id, actionId: action.id, title: stored.title, expectedVersion: stored.version }))
      .resolves.toMatchObject({ version: stored.version });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ title: stored.title, version: 2 });
    expect(await prisma.workItemVersion.count({ where: { entityType: "Action", entityId: action.id } })).toBe(1);
  });

  it("serializes Goal content edits and leaves stale/missing/cross-workspace attempts without effects", async () => {
    const { workspace, foreignWorkspace, user, actor } = await fixture();
    const goal = await prisma.goal.create({
      data: {
        workspaceId: workspace.id,
        authorUserId: user.id,
        title: "Original goal",
        descriptionMd: "Original goal body",
        status: "ACTIVE",
        isPrivate: false,
        publishedAt: new Date(),
        progressPercent: 0,
      },
    });

    const winner = expectOneWinner(await releaseTogether([
      () => updateGoal(actor, { workspaceId: workspace.id, goalId: goal.id, title: "Goal winner A", expectedVersion: goal.version }),
      () => updateGoal(actor, { workspaceId: workspace.id, goalId: goal.id, title: "Goal winner B", expectedVersion: goal.version }),
    ]));

    const stored = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(stored.title).toBe(winner.title);
    expect(stored.version).toBe(2);
    expect(await prisma.workItemVersion.count({ where: { entityType: "Goal", entityId: goal.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Goal", entityId: goal.id, action: "goal.updated" } })).toBe(1);
    expect(await prisma.event.count({ where: { aggregateType: "Goal", aggregateId: goal.id, type: "goal.updated" } })).toBe(1);

    await expect(updateGoal(actor, { workspaceId: workspace.id, goalId: goal.id, title: stored.title }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(updateGoal(actor, { workspaceId: foreignWorkspace.id, goalId: goal.id, title: "Foreign", expectedVersion: stored.version }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(updateGoal(actor, { workspaceId: workspace.id, goalId: goal.id, title: stored.title, expectedVersion: stored.version }))
      .resolves.toMatchObject({ version: stored.version });
    expect(await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).toMatchObject({ title: stored.title, version: 2 });
    expect(await prisma.workItemVersion.count({ where: { entityType: "Goal", entityId: goal.id } })).toBe(1);
  });
});
