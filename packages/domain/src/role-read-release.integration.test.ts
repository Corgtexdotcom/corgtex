import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import * as lineage from "./source-lineage";
import { listCircleTree } from "./circles";
import { getRole, listRoles, listRoleAssignments } from "./roles";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic role release", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Original holder", bio: "Original profile" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" }, include: { user: true } });
  const actor: AppActor = { kind: "user", user };
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Original circle", purposeMd: "Circle purpose" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Original role", purposeMd: "Role purpose", accountabilities: [], artifacts: [] } });
  const assignment = await prisma.roleAssignment.create({ data: { roleId: role.id, memberId: member.id } });
  for (const [kind, row] of [["Circle", circle], ["Role", role]] as const) await prisma.$transaction(tx => lineage.recordArtifactInputLineage({
    tx, actor, workspaceId: workspace.id, artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [],
  }));
  return { workspaceId: workspace.id, actor, user, member, circle, role, assignment };
}
async function read(f: Awaited<ReturnType<typeof fixture>>, endpoint: "list" | "detail" | "assignments") {
  return endpoint === "list" ? listRoles(f.actor, f.workspaceId)
    : endpoint === "detail" ? getRole(f.actor, { workspaceId: f.workspaceId, roleId: f.role.id })
      : listRoleAssignments(f.actor, f.workspaceId);
}
function afterAdmission(kind: lineage.LineageKind, change: () => Promise<void>) {
  let changed = false;
  const mutate = async () => { if (!changed) { changed = true; await change(); } };
  const ids = lineage.readableArtifactIds;
  const proof = lineage.captureArtifactInputProof;
  vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
    const result = await ids(...args);
    if (args[2] === kind) await mutate();
    return result;
  });
  vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
    const result = await proof(...args);
    if (args[2].some(input => input.kind === kind)) await mutate();
    return result;
  });
  return () => expect(changed).toBe(true);
}

describe("role read release", () => {
  it.each(["list", "detail", "assignments"] as const)("fences original role head after later Circle admission in %s", async endpoint => {
    const f = await fixture();
    const changed = afterAdmission("Circle", async () => {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, artifactType: "Role", artifactId: f.role.id }, orderBy: { revision: "desc" } });
      await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" (id,"workspaceId","artifactType","artifactId",revision,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson")
        SELECT ${randomUUID()},"workspaceId","artifactType","artifactId",revision+1,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson" FROM "ArtifactInputLineage" WHERE id=${head.id}`;
    });
    await expect(read(f, endpoint)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    changed();
  });
  it("preserves list/detail/assignment DTOs and tenant isolation", async () => {
    const f = await fixture();
    expect(await listRoles(f.actor, f.workspaceId)).toMatchObject([{ id: f.role.id, name: "Original role", circle: { id: f.circle.id, name: "Original circle" } }]);
    const detail = await getRole(f.actor, { workspaceId: f.workspaceId, roleId: f.role.id });
    expect(detail.assignments).toHaveLength(1);
    expect(detail.assignments[0].member.user).toMatchObject({ displayName: "Original holder", bio: "Original profile" });
    const assignments = await listRoleAssignments(f.actor, f.workspaceId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].member.user).not.toHaveProperty("bio");
    const other = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
    await prisma.member.create({ data: { workspaceId: other.id, userId: f.user.id, role: "ADMIN" } });
    expect(await listRoles(f.actor, other.id)).toEqual([]);
    await expect(getRole(f.actor, { workspaceId: other.id, roleId: f.role.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["list", "detail", "assignments"] as const)("fences caller revoke-and-restore after Circle admission in %s", async endpoint => {
    const f = await fixture();
    const changed = afterAdmission("Circle", async () => {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    });
    await expect(read(f, endpoint)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    changed();
  });

  it.each(["Circle", "RoleAssignment", "Member", "User"] as const)("retains original %s contributor through final profile admission", async kind => {
    const f = await fixture();
    const changed = afterAdmission("User", async () => {
      if (kind === "Circle") {
        await prisma.circle.update({ where: { id: f.circle.id }, data: { archivedAt: new Date() } });
        await prisma.circle.update({ where: { id: f.circle.id }, data: { archivedAt: null, updatedAt: f.circle.updatedAt } });
      } else if (kind === "RoleAssignment") {
        await prisma.roleAssignment.delete({ where: { id: f.assignment.id } });
        await prisma.roleAssignment.create({ data: f.assignment });
      } else if (kind === "Member") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else {
        await prisma.user.update({ where: { id: f.user.id }, data: { bio: "Changed profile" } });
      }
    });
    await expect(getRole(f.actor, { workspaceId: f.workspaceId, roleId: f.role.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    changed();
  });

  it("omits denied original roles and inactive holders before counting", async () => {
    const f = await fixture();
    const holder = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    const inactive = await prisma.member.create({ data: { workspaceId: f.workspaceId, userId: holder.id, role: "CONTRIBUTOR", isActive: false } });
    await prisma.roleAssignment.create({ data: { roleId: f.role.id, memberId: inactive.id } });
    expect((await getRole(f.actor, { workspaceId: f.workspaceId, roleId: f.role.id })).assignments.map(row => row.id)).toEqual([f.assignment.id]);
    await prisma.artifactInputLineage.updateMany({ where: { workspaceId: f.workspaceId, artifactType: "Role", artifactId: f.role.id }, data: { origin: "UNKNOWN" } });
    expect(await listRoles(f.actor, f.workspaceId)).toEqual([]);
    await expect(getRole(f.actor, { workspaceId: f.workspaceId, roleId: f.role.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fences an unassigned tree role during another role's profile admission", async () => {
    const f = await fixture();
    const unassigned = await prisma.role.create({ data: { circleId: f.circle.id, name: "Unassigned original", accountabilities: [], artifacts: [] } });
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Role", id: unassigned.id }, content: unassigned, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const changed = afterAdmission("User", async () => {
      await prisma.artifactInputLineage.updateMany({ where: { workspaceId: f.workspaceId, artifactType: "Role", artifactId: unassigned.id }, data: { origin: "UNKNOWN" } });
    });
    await expect(listCircleTree(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    changed();
  });

  it("preserves readable tree circles, unassigned roles and holder profiles", async () => {
    const f = await fixture();
    const unassigned = await prisma.role.create({ data: { circleId: f.circle.id, name: "Unassigned original", accountabilities: [], artifacts: [] } });
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Role", id: unassigned.id }, content: unassigned, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const tree = await listCircleTree(f.actor, f.workspaceId);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: f.circle.id, name: "Original circle", childCircles: [] });
    expect(tree[0].roles.map(role => role.id)).toEqual([f.role.id, unassigned.id]);
    expect(tree[0].roles[0].assignments).toHaveLength(1);
    expect(tree[0].roles[0].assignments[0].member.user).toMatchObject({ displayName: "Original holder", bio: "Original profile" });
    expect(tree[0].roles[1].assignments).toEqual([]);
  });

});
