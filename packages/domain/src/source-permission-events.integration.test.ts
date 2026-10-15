import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { planSourceLineageRebuild } from "./source-lineage-rebuild";

beforeEach(async () => { await truncateAllTables(); });

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic permission events", slug: `events-${randomUUID()}` } });
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1,
    title: "Synthetic private label", content: "Synthetic content must never enter the event", accessDomain: "WORKSPACE" } });
  return { workspace, source };
}
const events = () => prisma.event.findMany({ where: { type: "source-permission.changed" }, orderBy: { createdAt: "asc" } });

describe("durable permission change events", () => {
  it("invalidates category authority and schedules rebuilding on restriction and restoration", async () => {
    const f = await fixture();
    const policy = await prisma.informationCategoryPolicy.create({ data: {
      workspaceId: f.workspace.id, category: "SALARY", isRestricted: false,
    } });
    const epoch = async () => (await prisma.sourcePermissionEpoch.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, sourceKind: "InformationCategoryPolicy", sourceId: "SALARY",
    } })).epoch;
    const initialEpoch = await epoch();
    await prisma.event.deleteMany();
    await prisma.informationCategoryPolicy.update({ where: { id: policy.id }, data: { updatedAt: new Date(Date.now() + 60_000) } });
    expect(await events()).toEqual([]);
    expect(await epoch()).toBe(initialEpoch);
    for (const isRestricted of [true, false]) {
      const before = await epoch();
      await prisma.informationCategoryPolicy.update({ where: { id: policy.id }, data: { isRestricted } });
      expect(await epoch()).toBe(before + 1n);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ version: 1, governors: [{ kind: "InformationCategoryPolicy", id: "SALARY" }] });
      expect(planSourceLineageRebuild(rows[0])).toHaveLength(4);
      await prisma.event.deleteMany();
    }
  });

  it("schedules category role/circle changes and both identities on a policy move", async () => {
    const f = await fixture();
    const other = await prisma.workspace.create({ data: { name: "Synthetic category destination", slug: `category-move-${randomUUID()}` } });
    const policy = await prisma.informationCategoryPolicy.create({ data: { workspaceId: f.workspace.id, category: "HR" } });
    await prisma.event.deleteMany();
    for (const data of [{ allowedRoleIds: ["synthetic-role"] }, { allowedCircleIds: ["synthetic-circle"] }]) {
      await prisma.informationCategoryPolicy.update({ where: { id: policy.id }, data });
      expect((await events())[0].payload).toEqual({ version: 1, governors: [{ kind: "InformationCategoryPolicy", id: "HR" }] });
      await prisma.event.deleteMany();
    }
    await prisma.informationCategoryPolicy.update({ where: { id: policy.id }, data: { workspaceId: other.id, category: "PEOPLE" } });
    expect((await events()).map(row => ({ workspaceId: row.workspaceId, payload: row.payload }))).toEqual(expect.arrayContaining([
      { workspaceId: f.workspace.id, payload: { version: 1, governors: [{ kind: "InformationCategoryPolicy", id: "HR" }] } },
      { workspaceId: other.id, payload: { version: 1, governors: [{ kind: "InformationCategoryPolicy", id: "PEOPLE" }] } },
    ]));
    expect(await events()).toHaveLength(2);
    await prisma.event.deleteMany();
    await prisma.informationCategoryPolicy.delete({ where: { id: policy.id } });
    expect((await events())[0].payload).toEqual({ version: 1, governors: [{ kind: "InformationCategoryPolicy", id: "PEOPLE" }] });
  });

  it("rolls category epoch and rebuild scheduling back with the policy transaction", async () => {
    const f = await fixture();
    const policy = await prisma.informationCategoryPolicy.create({ data: { workspaceId: f.workspace.id, category: "HR" } });
    await prisma.event.deleteMany();
    const before = await prisma.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id } });
    await expect(prisma.$transaction(async tx => {
      await tx.informationCategoryPolicy.update({ where: { id: policy.id }, data: { isRestricted: true } });
      expect(await tx.event.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      throw new Error("Synthetic category rollback");
    })).rejects.toThrow("Synthetic category rollback");
    expect(await events()).toEqual([]);
    expect(await prisma.informationCategoryPolicy.findUniqueOrThrow({ where: { id: policy.id } })).toEqual(policy);
    expect(await prisma.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id } })).toEqual(before);
  });

  it("coalesces every permission transition into one metadata-only event per workspace transaction", async () => {
    const f = await fixture();
    const second = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "ARTICLE", tier: 1,
      title: "Second synthetic label", content: "Second synthetic body" } });
    await prisma.$transaction(async tx => {
      await tx.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
      await tx.brainSource.update({ where: { id: second.id }, data: { accessDomain: "FINANCE" } });
      await tx.brainSource.delete({ where: { id: second.id } });
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: f.workspace.id, aggregateType: "SourcePermissionEpoch",
      aggregateId: f.workspace.id, status: "PENDING", payload: { version: 1, governors: expect.any(Array) } });
    const payload = rows[0].payload as { version: number; governors: Array<{ kind: string; id: string }> };
    expect(Object.keys(payload).sort()).toEqual(["governors", "version"]);
    expect(payload.governors).toEqual(expect.arrayContaining([
      { kind: "BrainSource", id: f.source.id }, { kind: "BrainSource", id: second.id },
    ]));
    for (const governor of payload.governors) {
      expect(Object.keys(governor).sort()).toEqual(["id", "kind"]);
      expect(governor.kind).toBe("BrainSource");
      expect([f.source.id, second.id]).toContain(governor.id);
    }
    expect(JSON.stringify(payload)).not.toContain("Synthetic");
    const recipes = planSourceLineageRebuild(rows[0]);
    expect(recipes).toHaveLength(4);
    expect(recipes.every(recipe => recipe.workspaceId === f.workspace.id && recipe.eventId === rows[0].id)).toBe(true);
    expect(new Set(recipes.map(recipe => recipe.dedupeKey)).size).toBe(4);
    expect(planSourceLineageRebuild(rows[0])).toEqual(recipes);
    expect(JSON.stringify(recipes)).not.toContain(f.source.id);
  });

  it("keeps old and new identities in their actual workspaces when a source moves", async () => {
    const f = await fixture();
    const other = await prisma.workspace.create({ data: { name: "Synthetic destination", slug: `events-other-${randomUUID()}` } });
    const nextId = randomUUID();
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { id: nextId, workspaceId: other.id } });
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.workspaceId === f.workspace.id)?.payload).toEqual({ version: 1, governors: [{ kind: "BrainSource", id: f.source.id }] });
    expect(rows.find(row => row.workspaceId === other.id)?.payload).toEqual({ version: 1, governors: [{ kind: "BrainSource", id: nextId }] });
    for (const row of rows) expect(planSourceLineageRebuild(row).every(recipe => recipe.workspaceId === row.workspaceId)).toBe(true);
  });

  it("creates distinct rebuild identities for separate permission transactions", async () => {
    const f = await fixture();
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "WORKSPACE" } });
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    const first = new Set(planSourceLineageRebuild(rows[0]).map(recipe => recipe.dedupeKey));
    expect(planSourceLineageRebuild(rows[1]).every(recipe => !first.has(recipe.dedupeKey))).toBe(true);
  });

  it("emits grant INSERTs for all allowed policy families in one transaction", async () => {
    const f = await fixture();
    const user = await prisma.user.create({ data: { email: `events-${randomUUID()}@example.test`, passwordHash: "Synthetic secret must not enter event" } });
    const member = await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: user.id } });
    const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "Synthetic grant circle" } });
    const role = await prisma.role.create({ data: { circleId: circle.id, name: "Synthetic grant role", accountabilities: [], artifacts: [] } });
    const agent = await prisma.agentIdentity.create({ data: { workspaceId: f.workspace.id, agentKey: "synthetic-events", displayName: "Synthetic grant agent" } });
    const action = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: user.id, title: "Synthetic advice subject" } });
    const process = await prisma.adviceProcess.create({ data: { workspaceId: f.workspace.id, authorMemberId: member.id, subjectType: "ACTION", subjectId: action.id } });
    const request = await prisma.adviceRequest.create({ data: { workspaceId: f.workspace.id, processId: process.id,
      requestedByUserId: user.id, audienceType: "CIRCLE", targetCircleId: circle.id, messageMd: "Synthetic advice body" } });
    expect(await events()).toEqual([]);
    const inserted = await prisma.$transaction(async tx => {
      const grants = [
        ["WorkspaceModuleGrant", await tx.workspaceModuleGrant.create({ data: { workspaceId: f.workspace.id, moduleKey: "finance", principalType: "MEMBER", principalId: member.id, accessLevel: "READ" } })],
        ["WorkspaceFeatureFlag", await tx.workspaceFeatureFlag.create({ data: { workspaceId: f.workspace.id, flag: "FINANCE", enabled: true, config: { syntheticSecret: "never-copy" } } })],
        ["WorkspaceSupportGrant", await tx.workspaceSupportGrant.create({ data: { workspaceId: f.workspace.id, userId: user.id, grantedByUserId: user.id } })],
        ["WorkspaceIntegrationBinding", await tx.workspaceIntegrationBinding.create({ data: { workspaceId: f.workspace.id, provider: "SLACK", externalWorkspaceId: `synthetic-${randomUUID()}` } })],
        ["RoleAssignment", await tx.roleAssignment.create({ data: { roleId: role.id, memberId: member.id } })],
        ["CircleAgentAssignment", await tx.circleAgentAssignment.create({ data: { circleId: circle.id, agentIdentityId: agent.id } })],
        ["AdviceRequestRecipient", await tx.adviceRequestRecipient.create({ data: { requestId: request.id, memberId: member.id } })],
      ] as const;
      return grants.map(([kind, row]) => ({ kind, id: row.id }));
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ version: 1, governors: expect.arrayContaining(inserted) });
    expect((rows[0].payload as { governors: unknown[] }).governors).toHaveLength(inserted.length);
    expect(JSON.stringify(rows[0].payload)).not.toContain("never-copy");
  });

  it("rolls back the source change, epoch bumps and event atomically", async () => {
    const f = await fixture();
    const before = await prisma.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id }, orderBy: [{ sourceKind: "asc" }, { sourceId: "asc" }] });
    await expect(prisma.$transaction(async tx => {
      await tx.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
      expect(await tx.event.count({ where: { type: "source-permission.changed", workspaceId: f.workspace.id } })).toBe(1);
      throw new Error("Synthetic rollback");
    })).rejects.toThrow("Synthetic rollback");
    expect(await events()).toEqual([]);
    expect(await prisma.brainSource.findUnique({ where: { id: f.source.id } })).toEqual(f.source);
    expect(await prisma.sourcePermissionEpoch.findMany({ where: { workspaceId: f.workspace.id }, orderBy: [{ sourceKind: "asc" }, { sourceId: "asc" }] })).toEqual(before);
  });

  it("does not schedule rebuilds for generated inserts or non-permission progress updates", async () => {
    const f = await fixture();
    await prisma.$transaction(async tx => {
      const source = await tx.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Team", title: "Synthetic generated team", createdByType: "agent" } });
      const target = await tx.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Goal", title: "Synthetic generated goal", createdByType: "agent" } });
      await tx.contextGraphRelationship.create({ data: { workspaceId: f.workspace.id, sourceObjectId: source.id, targetObjectId: target.id, relationshipType: "supports", createdByType: "agent" } });
      await tx.contextGraphEvidenceRef.create({ data: { workspaceId: f.workspace.id, objectId: source.id, sourceType: "BrainSource", sourceId: f.source.id, quote: "Synthetic generated evidence" } });
      const diff = await tx.contextGraphProposedDiff.create({ data: { workspaceId: f.workspace.id, proposedByType: "agent", diffJson: { operations: [] } } });
      await tx.contextGraphProposedDiff.update({ where: { id: diff.id }, data: { status: "approved" } });
      await tx.contextGraphObject.update({ where: { id: source.id }, data: { status: "approved", summary: "Synthetic progress" } });
      await tx.brainSource.update({ where: { id: f.source.id }, data: { title: "Synthetic edited body label", content: "Synthetic edited content" } });
    });
    expect(await events()).toEqual([]);
    expect(await prisma.sourcePermissionEpoch.count({ where: { workspaceId: f.workspace.id, sourceKind: "ContextGraphObject" } })).toBe(2);
  });
});
