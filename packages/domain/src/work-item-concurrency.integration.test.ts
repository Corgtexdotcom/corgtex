import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { updateAction } from "./actions";
import { updateGoal } from "./goals";
import { updateProposal } from "./proposals";
import { updateTension } from "./tensions";

const prisma = getPrismaClient();
type Kind = "Action" | "Goal" | "Proposal" | "Tension";

beforeEach(async () => {
  await truncateAllTables();
});

async function fixture() {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({
    data: { slug: `version-race-${suffix}`, name: "Work item version race" },
  });
  const user = await prisma.user.create({
    data: {
      email: `version-race-${suffix}@example.com`,
      displayName: "Version editor",
      passwordHash: "synthetic-test-hash",
    },
  });
  await prisma.member.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" },
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
  return { workspaceId: workspace.id, userId: user.id, actor };
}

async function createItem(kind: Kind, workspaceId: string, userId: string) {
  const data = {
    workspaceId,
    authorUserId: userId,
    title: `Original ${kind}`,
    status: "OPEN" as const,
    isPrivate: false,
    publishedAt: new Date(),
  };
  switch (kind) {
    case "Action": return prisma.action.create({ data });
    case "Tension": return prisma.tension.create({ data });
    case "Proposal": return prisma.proposal.create({ data: { ...data, bodyMd: "Original proposal body" } });
    case "Goal": return prisma.goal.create({ data: {
      ...data,
      status: "ACTIVE",
      descriptionMd: "Original goal body",
      progressPercent: 0,
    } });
  }
}

async function editTitle(kind: Kind, actor: AppActor, workspaceId: string, id: string, title: string, expectedVersion?: number) {
  switch (kind) {
    case "Action": return updateAction(actor, { workspaceId, actionId: id, title, expectedVersion });
    case "Tension": return updateTension(actor, { workspaceId, tensionId: id, title, expectedVersion });
    case "Proposal": return updateProposal(actor, { workspaceId, proposalId: id, title, expectedVersion });
    case "Goal": return updateGoal(actor, { workspaceId, goalId: id, title, expectedVersion });
  }
}

async function readItem(kind: Kind, id: string) {
  switch (kind) {
    case "Action": return prisma.action.findUniqueOrThrow({ where: { id } });
    case "Tension": return prisma.tension.findUniqueOrThrow({ where: { id } });
    case "Proposal": return prisma.proposal.findUniqueOrThrow({ where: { id } });
    case "Goal": return prisma.goal.findUniqueOrThrow({ where: { id } });
  }
}

async function startTogether<T>(calls: Array<() => Promise<T>>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const results = calls.map(async (call) => {
    await gate;
    return call();
  });
  release();
  return Promise.allSettled(results);
}

describe("work-item observed-version concurrency", () => {
  it.each(["Action", "Goal", "Proposal", "Tension"] as const)(
    "allows only one %s content write from two callers holding one observed version",
    async (kind) => {
      const { workspaceId, userId, actor } = await fixture();
      const item = await createItem(kind, workspaceId, userId);
      const observedVersion = item.version;
      const results = await startTogether([
        () => editTitle(kind, actor, workspaceId, item.id, "Editor A", observedVersion),
        () => editTitle(kind, actor, workspaceId, item.id, "Editor B", observedVersion),
      ]);
      const winners = results.filter((result) => result.status === "fulfilled");
      const losers = results.filter((result) => result.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ reason: { status: 409, code: "VERSION_CONFLICT" } });

      const stored = await readItem(kind, item.id);
      expect(stored.title).toBe(winners[0].value.title);
      expect(stored.version).toBe(observedVersion + 1);
      expect(await prisma.workItemVersion.count({ where: { entityType: kind, entityId: item.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityType: kind, entityId: item.id, action: `${kind.toLowerCase()}.updated` } })).toBe(1);
      expect(await prisma.event.count({ where: { aggregateType: kind, aggregateId: item.id, type: `${kind.toLowerCase()}.updated` } })).toBe(1);

      await expect(editTitle(kind, actor, workspaceId, item.id, "Missing version"))
        .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      await expect(editTitle(kind, actor, workspaceId, item.id, "Stale version", observedVersion))
        .rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
      expect(await readItem(kind, item.id)).toMatchObject({ title: stored.title, version: stored.version });
      expect(await prisma.workItemVersion.count({ where: { entityType: kind, entityId: item.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityType: kind, entityId: item.id, action: `${kind.toLowerCase()}.updated` } })).toBe(1);
      expect(await prisma.event.count({ where: { aggregateType: kind, aggregateId: item.id, type: `${kind.toLowerCase()}.updated` } })).toBe(1);
    },
  );
});
