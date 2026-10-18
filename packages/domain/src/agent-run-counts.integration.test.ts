import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getAgentRunOperationalCounts } from "./agent-runs";
import * as auth from "./auth";
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic operational counts", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor = { kind: "user", user } as AppActor;
  return { workspace, member, actor };
}
it("groups a 5001-run unproved backlog without reading bodies, child histories or another tenant", async () => {
  const f = await fixture();
  const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
  await prisma.agentRun.createMany({ data: Array.from({ length: 5001 }, () => ({ workspaceId: f.workspace.id,
    agentKey: "backlog", triggerType: "EVENT" as const, status: "WAITING_APPROVAL" as const, goal: "PRIVATE BODY CANARY",
    contextJson: { secret: "PRIVATE CONTEXT CANARY" }, createdAt: new Date("2020-01-01") })) });
  await prisma.agentRun.createMany({ data: [
    { workspaceId: f.workspace.id, agentKey: "new", triggerType: "EVENT", status: "WAITING_APPROVAL", goal: "Private" },
    { workspaceId: f.workspace.id, agentKey: "new", triggerType: "EVENT", status: "COMPLETED", goal: "Private" },
    { workspaceId: foreign.id, agentKey: "foreign", triggerType: "EVENT", status: "WAITING_APPROVAL", goal: "FOREIGN BODY CANARY" },
  ] });
  const first = await prisma.agentRun.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
  await prisma.agentStep.create({ data: { agentRunId: first.id, name: "CHILD BODY CANARY", outputJson: { secret: true } } });
  const result = await getAgentRunOperationalCounts(f.actor, f.workspace.id);
  expect(result.pendingApprovalCountsByAgent.sort((a, b) => a.agentKey.localeCompare(b.agentKey))).toEqual([
    { agentKey: "backlog", count: 5001 }, { agentKey: "new", count: 1 },
  ]);
  expect(result.runCountsByAgent).toEqual([{ agentKey: "new", count: 2 }]);
  expect(JSON.stringify(result)).not.toMatch(/CANARY|foreign/);
  await expect(getAgentRunOperationalCounts(f.actor, foreign.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});
it("withholds grouped operational metadata when the caller is revoked during the query", async () => {
  const f = await fixture();
  const membership = auth.requireWorkspaceMembership;
  let calls = 0;
  let changed = false;
  vi.spyOn(auth, "requireWorkspaceMembership").mockImplementation(async args => {
    if (++calls === 2) {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      changed = true;
    }
    return membership(args);
  });
  await expect(getAgentRunOperationalCounts(f.actor, f.workspace.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  expect(changed).toBe(true);
});
