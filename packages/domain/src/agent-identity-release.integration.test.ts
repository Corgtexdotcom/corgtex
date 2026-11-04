import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getAgentIdentity, listAgentIdentities, updateAgentIdentity, resolveAgentBehaviorContext } from "./agent-identity";
import * as lineage from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic identity release", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@identity.test`, passwordHash: "synthetic", displayName: "Original creator" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, title: "Private original", slug: randomUUID(), type: "PROJECT", authority: "DRAFT", bodyMd: "Private identity input", isPrivate: true, ownerMemberId: member.id } });
  const identity = await prisma.agentIdentity.create({ data: { workspaceId: workspace.id, agentKey: "synthetic-agent", displayName: "Original identity", purposeMd: "Private purpose", behaviorMd: "Private behavior", createdByUserId: user.id, maxRunsPerDay: 7 } });
  await prisma.$transaction(async tx => {
    await lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "BrainArticle", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "AgentIdentity", id: identity.id }, content: identity, origin: "DERIVED", inputs: [{ kind: "BrainArticle", id: source.id }] });
  });
  return { workspace, user, member, actor, source, identity };
}

describe("agent identity original joined release", () => {
  it.each(["list", "detail"] as const)("withholds %s after source revocation during author capture", async mode => {
    const f = await fixture();
    const original = lineage.captureArtifactInputProof;
    let changed = 0;
    vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[2].some(input => input.kind === "User") && !changed) {
        await prisma.brainArticle.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
        changed++;
      }
      return result;
    });
    await expect(mode === "list" ? listAgentIdentities(f.actor, f.workspace.id) : getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).rejects.toThrow();
    expect(changed).toBe(1);
    expect((await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.source.id } })).archivedAt).not.toBeNull();
  });

  it("keeps a proven inactive identity administrable and re-enableable", async () => {
    const f = await fixture();
    expect(await updateAgentIdentity(f.actor, { workspaceId: f.workspace.id, agentIdentityId: f.identity.id, isActive: false })).toMatchObject({ id: f.identity.id, isActive: false });
    expect(await listAgentIdentities(f.actor, f.workspace.id)).toEqual([expect.objectContaining({ id: f.identity.id, isActive: false })]);
    expect(await getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).toMatchObject({ id: f.identity.id, isActive: false, purposeMd: "Private purpose" });
    expect(await updateAgentIdentity(f.actor, { workspaceId: f.workspace.id, agentIdentityId: f.identity.id, isActive: true })).toMatchObject({ isActive: true });
  });
});


it.each(["list", "detail"] as const)("retains original %s authority across joined reads", async mode => {
  const f = await fixture();
  const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "Original circle" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Original role", accountabilities: [], artifacts: [] } });
  await prisma.$transaction(async tx => {
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "Circle", id: circle.id }, content: circle, origin: "HUMAN_ORIGINAL", inputs: [] });
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "Role", id: role.id }, content: role, origin: "HUMAN_ORIGINAL", inputs: [] });
  });
  const assignment = await prisma.circleAgentAssignment.create({ data: { circleId: circle.id, roleId: role.id, agentIdentityId: f.identity.id } });
  const result = mode === "list" ? (await listAgentIdentities(f.actor, f.workspace.id))[0] : await getAgentIdentity(f.actor, f.workspace.id, f.identity.id);
  expect(result).toMatchObject({ id: f.identity.id, displayName: "Original identity", purposeMd: "Private purpose", behaviorMd: "Private behavior", maxRunsPerDay: 7, createdByUserId: f.user.id, circleAssignments: [{ circle: { id: circle.id, name: "Original circle" }, role: { id: role.id, name: "Original role" } }] });
  if (mode === "detail") expect(result).toMatchObject({ createdByUser: { id: f.user.id, displayName: "Original creator" } });
  expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, "CircleAgentAssignment", [assignment])).toEqual(new Set([assignment.id]));
  await updateAgentIdentity(f.actor, { workspaceId: f.workspace.id, agentIdentityId: f.identity.id, isActive: false });
  expect(await getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).toMatchObject({ isActive: false });
  const currentAssignment = await prisma.circleAgentAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
  expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, "CircleAgentAssignment", [currentAssignment])).toEqual(new Set());
});

it.each(["caller", "caller-restore", "identity", "author"] as const)("withholds original detail after %s changes during final author capture", async change => {
  const f = await fixture();
  const original = lineage.captureArtifactInputProof;
  let changed = 0;
  vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
    const proof = await original(...args);
    if (args[2].some(input => input.kind === "User") && !changed) {
      if (change === "caller" || change === "caller-restore") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        if (change === "caller-restore") await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else if (change === "identity") await prisma.agentIdentity.update({ where: { id: f.identity.id }, data: { purposeMd: "New purpose" } });
      else await prisma.user.update({ where: { id: f.user.id }, data: { displayName: "Changed creator" } });
      changed++;
    }
    return proof;
  });
  await expect(getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).rejects.toThrow();
  expect(changed).toBe(1);
});

it("limits inactive read access to human admins and retains provenance restrictions", async () => {
  const f = await fixture();
  const inactive = await prisma.agentIdentity.create({ data: { workspaceId: f.workspace.id, agentKey: "inactive-public", displayName: "Inactive public", isActive: false } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "AgentIdentity", id: inactive.id }, content: inactive, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@identity.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  const readerActor: AppActor = { kind: "user", user: reader };
  expect(await getAgentIdentity(f.actor, f.workspace.id, inactive.id)).toMatchObject({ isActive: false });
  expect(await lineage.readableArtifactIds(readerActor, f.workspace.id, "AgentIdentity", [inactive])).toEqual(new Set());
  await expect(getAgentIdentity(readerActor, f.workspace.id, inactive.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await updateAgentIdentity(f.actor, { workspaceId: f.workspace.id, agentIdentityId: f.identity.id, isActive: false });
  expect(await getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).toMatchObject({ isActive: false });
  await prisma.brainArticle.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
  await expect(getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const unknown = await prisma.agentIdentity.create({ data: { workspaceId: f.workspace.id, agentKey: "unknown-inactive", displayName: "Unknown", isActive: false } });
  await expect(getAgentIdentity(f.actor, f.workspace.id, unknown.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await prisma.agentIdentity.update({ where: { id: inactive.id }, data: { archivedAt: new Date() } });
  await expect(getAgentIdentity(f.actor, f.workspace.id, inactive.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("keeps inactive behavior out of runtime context while preserving workspace policy", async () => {
  const f = await fixture();
  await updateAgentIdentity(f.actor, { workspaceId: f.workspace.id, agentIdentityId: f.identity.id, isActive: false });
  expect(await getAgentIdentity(f.actor, f.workspace.id, f.identity.id)).toMatchObject({ isActive: false });
  const policy = await prisma.agentIdentity.create({ data: { workspaceId: f.workspace.id, agentKey: "__workspace__", displayName: "Policy", isActive: false, behaviorMd: "Workspace instruction" } });
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact: { kind: "AgentIdentity", id: policy.id }, content: policy, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const context = await resolveAgentBehaviorContext(f.workspace.id, f.identity.agentKey, f.actor);
  expect(context).toContain("Workspace instruction");
  expect(context).not.toContain("Private behavior");
});
