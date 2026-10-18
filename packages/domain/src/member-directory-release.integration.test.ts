import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, captureMcpOAuthGrantEpoch, mcpScopesHash, runWithMcpOrigin, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import * as lineage from "./source-lineage";
import { listMembersEnriched, updateMember } from "./members";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic directory", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Caller" } });
  const caller = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", joinedAt: new Date("2026-01-01") } });
  const profile = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Original member", bio: "Original biography", avatarUrl: "https://example.test/avatar", linkedinUrl: "https://example.test/linkedin", websiteUrl: "https://example.test/site" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: profile.id, role: "CONTRIBUTOR", joinedAt: new Date("2026-01-02") } });
  const actor: AppActor = { kind: "user", user };
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Original circle" } });
  const role = await prisma.role.create({ data: { circleId: circle.id, name: "Original role", accountabilities: [], artifacts: [] } });
  const assignment = await prisma.roleAssignment.create({ data: { roleId: role.id, memberId: member.id } });
  for (const [kind, row] of [["Circle", circle], ["Role", role]] as const) await prisma.$transaction(tx => lineage.recordArtifactInputLineage({
    tx, actor, workspaceId: workspace.id, artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [],
  }));
  return { workspaceId: workspace.id, actor, caller, profile, member, circle, role, assignment };
}

// Exercise the same late joined-authorization boundary before and after the fix.
function afterCircleAdmission(change: () => Promise<void>) {
  let changed = false;
  let completed = false;
  const mutate = async () => { if (!changed) { changed = true; await change(); completed = true; } };
  const ids = lineage.readableArtifactIds;
  const proof = lineage.captureArtifactInputProof;
  vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
    const result = await ids(...args);
    if (args[2] === "Circle") await mutate();
    return result;
  });
  vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
    const result = await proof(...args);
    if (args[2].some(input => input.kind === "Circle")) await mutate();
    return result;
  });
  return () => expect(completed).toBe(true);
}

describe("member directory original read release", () => {
  it("preserves ordered public directory profiles and joined assignments without foreign members", async () => {
    const f = await fixture();
    const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
    await prisma.member.create({ data: { workspaceId: foreign.id, userId: f.profile.id, role: "ADMIN" } });
    const rows = await listMembersEnriched(f.actor, f.workspaceId);
    expect(rows.map(row => row.id)).toEqual([f.caller.id, f.member.id]);
    expect(rows[1].user).toEqual({ id: f.profile.id, email: f.profile.email, displayName: f.profile.displayName,
      bio: f.profile.bio, avatarUrl: f.profile.avatarUrl, linkedinUrl: f.profile.linkedinUrl, websiteUrl: f.profile.websiteUrl });
    expect(rows[1].roleAssignments).toMatchObject([{ id: f.assignment.id, role: { id: f.role.id, name: f.role.name, circle: { id: f.circle.id, name: f.circle.name } } }]);
    expect(rows[0].roleAssignments).toEqual([]);
  });

  it.each(["caller loss", "caller restore", "member loss", "member restore", "profile change", "role head", "circle head", "assignment restore"] as const)("rejects original directory after late %s", async mutation => {
    const f = await fixture();
    const changed = afterCircleAdmission(async () => {
      if (mutation.startsWith("caller") || mutation.startsWith("member")) {
        const id = mutation.startsWith("caller") ? f.caller.id : f.member.id;
        await prisma.member.update({ where: { id }, data: { isActive: false } });
        if (mutation.endsWith("restore")) await prisma.member.update({ where: { id }, data: { isActive: true } });
      } else if (mutation === "profile change") {
        await prisma.user.update({ where: { id: f.profile.id }, data: { bio: "Changed biography" } });
      } else if (mutation === "assignment restore") {
        await prisma.roleAssignment.delete({ where: { id: f.assignment.id } });
        await prisma.roleAssignment.create({ data: f.assignment });
      } else {
        const kind = mutation === "role head" ? "Role" : "Circle";
        const id = mutation === "role head" ? f.role.id : f.circle.id;
        const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, artifactType: kind, artifactId: id }, orderBy: { revision: "desc" } });
        await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" (id,"workspaceId","artifactType","artifactId",revision,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson")
          SELECT ${randomUUID()},"workspaceId","artifactType","artifactId",revision+1,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson" FROM "ArtifactInputLineage" WHERE id=${head.id}`;
        expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspaceId, artifactType: kind, artifactId: id } })).toBe(2);
      }
    });
    await expect(listMembersEnriched(f.actor, f.workspaceId)).rejects.toThrow();
    changed();
  });

  it.each(["Member", "User"] as const)("withholds a profile with denied original %s provenance", async kind => {
    const f = await fixture();
    const row = kind === "Member" ? await prisma.member.findUniqueOrThrow({ where: { id: f.member.id }, include: { user: { select: { id: true, email: true, displayName: true } } } }) : f.profile;
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
    await prisma.artifactInputLineage.updateMany({ where: { workspaceId: f.workspaceId, artifactType: kind, artifactId: row.id }, data: { origin: "UNKNOWN" } });
    expect((await listMembersEnriched(f.actor, f.workspaceId)).map(member => member.id)).toEqual([f.caller.id]);
  });

  it("preserves the admin inactive-management DTO and reactivation workflow", async () => {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    const rows = await listMembersEnriched(f.actor, f.workspaceId, { includeInactive: true });
    expect(rows.map(row => row.id)).toEqual([f.caller.id, f.member.id]);
    expect(rows[1]).toMatchObject({ isActive: false, user: { email: f.profile.email, bio: f.profile.bio },
      roleAssignments: [{ id: f.assignment.id, role: { name: f.role.name, circle: { name: f.circle.name } } }] });
    await expect(lineage.captureArtifactInputProof(f.actor, f.workspaceId, [{ kind: "Member", id: f.member.id }])).rejects.toThrow();
    await expect(lineage.captureArtifactInputProof(f.actor, f.workspaceId, [{ kind: "User", id: f.profile.id }])).rejects.toThrow();
    await updateMember(f.actor, { workspaceId: f.workspaceId, memberId: f.member.id, isActive: true });
    expect((await listMembersEnriched(f.actor, f.workspaceId)).find(row => row.id === f.member.id)).toMatchObject({ isActive: true });
  });

  it.each(["reader", "agent"] as const)("denies inactive management metadata to %s", async caller => {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    if (caller === "reader") await prisma.member.update({ where: { id: f.caller.id }, data: { role: "CONTRIBUTOR" } });
    const actor: AppActor = caller === "reader" ? f.actor : { kind: "agent", authProvider: "bootstrap", label: "Synthetic directory", workspaceIds: [f.workspaceId] };
    const rows = await listMembersEnriched(actor, f.workspaceId, { includeInactive: true });
    expect(rows.some(row => row.id === f.member.id)).toBe(false);
  });

  it.each(["admin restore", "target restore", "profile", "new head", "assignment restore"] as const)("fences inactive management metadata after late %s", async mutation => {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    const changed = afterCircleAdmission(async () => {
      if (mutation === "admin restore") {
        await prisma.member.update({ where: { id: f.caller.id }, data: { role: "CONTRIBUTOR" } });
        await prisma.member.update({ where: { id: f.caller.id }, data: { role: "ADMIN" } });
      } else if (mutation === "target restore") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      } else if (mutation === "profile") {
        await prisma.user.update({ where: { id: f.profile.id }, data: { bio: "Changed inactive biography" } });
      } else if (mutation === "new head") {
        await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspaceId, artifactType: "User", artifactId: f.profile.id,
          revision: 1, origin: "UNKNOWN", contentHash: lineage.lineageContentFingerprint("User", f.profile), inputsJson: [], rootsJson: [] } });
      } else {
        await prisma.roleAssignment.delete({ where: { id: f.assignment.id } });
        await prisma.roleAssignment.create({ data: f.assignment });
      }
    });
    await expect(listMembersEnriched(f.actor, f.workspaceId, { includeInactive: true })).rejects.toThrow();
    changed();
    if (mutation === "new head") expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspaceId, artifactType: "User", artifactId: f.profile.id } })).toBe(1);
  });

  it("withholds inactive metadata with unknown provenance even from an admin", async () => {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspaceId, artifactType: "User", artifactId: f.profile.id,
      revision: 1, origin: "UNKNOWN", contentHash: lineage.lineageContentFingerprint("User", f.profile), inputsJson: [], rootsJson: [] } });
    expect((await listMembersEnriched(f.actor, f.workspaceId, { includeInactive: true })).map(row => row.id)).toEqual([f.caller.id]);
  });
  it("retains the existing human FULL-support admin management scope", async () => {
    const f = await fixture();
    await prisma.workspaceSupportGrant.create({ data: { workspaceId: f.workspaceId, userId: f.actor.user.id,
      role: "FULL", grantedByUserId: f.actor.user.id } });
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    expect((await listMembersEnriched(f.actor, f.workspaceId, { includeInactive: true })).find(row => row.id === f.member.id))
      .toMatchObject({ isActive: false, user: { email: f.profile.email } });
  });

  it.each([true, false])("requires members:read in the human admin OAuth grant (granted=%s)", async granted => {
    const f = await fixture();
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    const scopes = granted ? ["members:read", "circles:read", "roles:read"] : ["circles:read", "roles:read"];
    const client = await prisma.mcpOAuthClient.create({ data: { clientId: randomUUID(), name: "Synthetic directory",
      redirectUris: ["https://example.test/callback"], scopes } });
    const token = await prisma.mcpOAuthAccessToken.create({ data: { workspaceId: f.workspaceId, userId: f.actor.user.id,
      clientId: client.id, instanceSlug: "selfserve", tokenHash: randomUUID(), scopes,
      expiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 3_600_000) } });
    const epoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, f.workspaceId, token.id));
    const read = () => runWithMcpOrigin({ kind: "oauth", id: token.id, workspaceId: f.workspaceId,
      scopeHash: mcpScopesHash(scopes), grantEpoch: epoch }, () => listMembersEnriched(f.actor, f.workspaceId, { includeInactive: true }));
    if (granted) expect((await read()).find(row => row.id === f.member.id)).toMatchObject({ isActive: false });
    else await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

});
