import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  SOURCE_PERMISSION_POLICY_VERSION, type PermissionEpochIdentity, type PermissionEpochProof } from "./source-permission-epochs";

// Real migration triggers and epoch APIs; all records are synthetic, with no provider calls.
beforeEach(async () => { await truncateAllTables(); });
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic governor epochs", slug: `governors-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `governor-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `governor-other-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const otherMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "CONTRIBUTOR" } });
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Synthetic circle" } });
  const otherCircle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Synthetic other circle" } });
  return { workspace, user, other, member, otherMember, circle, otherCircle };
}
const capture = (workspaceId: string, identities: PermissionEpochIdentity[]) => prisma.$transaction(tx => capturePermissionEpochs(tx, workspaceId, identities));
function epoch(proof: PermissionEpochProof, identity: PermissionEpochIdentity) {
  const entry = proof.entries.find(row => row.kind === identity.kind && row.id === identity.id);
  expect(entry).toBeDefined(); return BigInt(entry!.epoch);
}
async function cycle(workspaceId: string, identities: PermissionEpochIdentity[], revoke: () => Promise<unknown>, restore: () => Promise<unknown>) {
  const before = await capture(workspaceId, identities);
  expect(await isArtifactPermissionEpochProofCurrent(workspaceId, before)).toBe(true);
  await revoke(); const revoked = await capture(workspaceId, identities);
  await restore(); const restored = await capture(workspaceId, identities);
  for (const identity of identities) {
    expect(epoch(revoked, identity)).toBeGreaterThan(epoch(before, identity));
    expect(epoch(restored, identity)).toBeGreaterThan(epoch(revoked, identity));
  }
  expect(await isArtifactPermissionEpochProofCurrent(workspaceId, before)).toBe(false);
  expect(await isArtifactPermissionEpochProofCurrent(workspaceId, revoked)).toBe(false);
  expect(await isArtifactPermissionEpochProofCurrent(workspaceId, restored)).toBe(true);
  return { before, revoked, restored };
}
async function roleFixture() {
  const f = await fixture();
  const role = await prisma.role.create({ data: { circleId: f.circle.id, name: "Synthetic role", accountabilities: [], artifacts: [] } });
  return { ...f, role };
}
async function adviceFixture() {
  const f = await roleFixture();
  const action = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id, title: "Synthetic advice subject" } });
  const process = await prisma.adviceProcess.create({ data: { workspaceId: f.workspace.id, authorMemberId: f.member.id,
    subjectType: "ACTION", subjectId: action.id } });
  const request = await prisma.adviceRequest.create({ data: { workspaceId: f.workspace.id, processId: process.id,
    requestedByUserId: f.user.id, audienceType: "CIRCLE", targetCircleId: f.circle.id, messageMd: "Synthetic request" } });
  return { ...f, request };
}
async function communicationFixture() {
  const f = await fixture();
  const installation = await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id,
    provider: "SLACK", externalWorkspaceId: `synthetic-${randomUUID()}` } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: "synthetic-public", kind: "PUBLIC" } });
  const message = await prisma.communicationMessage.create({ data: { workspaceId: f.workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: channel.externalChannelId, externalMessageId: "synthetic-message", text: "Synthetic message" } });
  return { ...f, installation, channel, message };
}

describe("complete permission governor SQL transitions", () => {
  it("keeps producer content metadata separate from permission-bearing document rebinding", async () => {
    const f = await fixture();
    const source = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id,
      sourceType: "FILE_UPLOAD", tier: 3, title: "Synthetic file", content: "Original content", authorMemberId: f.member.id,
      metadata: { documentId: "synthetic-document-one", contentHash: "original", fileHash: "original" } } });
    const identities = [{ kind: "BrainSource", id: source.id }];
    const before = await capture(f.workspace.id, identities);
    await prisma.brainSource.update({ where: { id: source.id }, data: {
      content: "Replacement content", metadata: { documentId: "synthetic-document-one",
        contentHash: "replacement", fileHash: "replacement", extractionProgress: "completed" },
    } });
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(true);
    await cycle(f.workspace.id, identities,
      () => prisma.brainSource.update({ where: { id: source.id }, data: { metadata: { documentId: "synthetic-document-two" } } }),
      () => prisma.brainSource.update({ where: { id: source.id }, data: { metadata: { documentId: "synthetic-document-one" } } }));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
  });

  it("resolves Role workspace through Circle and invalidates archive/restoration governors", async () => {
    const f = await roleFixture();
    await cycle(f.workspace.id, [{ kind: "Role", id: f.role.id }, { kind: "CircleRolePolicy", id: f.circle.id }, { kind: "ModulePolicy", id: "finance" }],
      () => prisma.role.update({ where: { id: f.role.id }, data: { archivedAt: new Date() } }),
      () => prisma.role.update({ where: { id: f.role.id }, data: { archivedAt: null } }));
  });

  it("bumps both circles when a role leaves and returns", async () => {
    const f = await roleFixture();
    await cycle(f.workspace.id, [{ kind: "Role", id: f.role.id }, { kind: "CircleRolePolicy", id: f.circle.id }, { kind: "CircleRolePolicy", id: f.otherCircle.id }],
      () => prisma.role.update({ where: { id: f.role.id }, data: { circleId: f.otherCircle.id } }),
      () => prisma.role.update({ where: { id: f.role.id }, data: { circleId: f.circle.id } }));
  });

  it.each(["audienceType", "targetCircleId", "requestedByUserId"] as const)("keeps AdviceRequest %s restoration from redeeming prior receipts", async field => {
    const f = await adviceFixture();
    const ids = artifactPermissionEpochIdentities("AdviceRequest", f.request);
    expect(ids).toContainEqual({ kind: "AdviceRequestRecipientsPolicy", id: f.request.id });
    expect(ids).toContainEqual({ kind: "CircleRolePolicy", id: f.circle.id });
    expect(ids).toContainEqual({ kind: "MemberUserPolicy", id: f.user.id });
    const change = field === "audienceType" ? { audienceType: "WORKSPACE" as const }
      : field === "targetCircleId" ? { targetCircleId: f.otherCircle.id } : { requestedByUserId: f.other.id };
    const restore = field === "audienceType" ? { audienceType: "CIRCLE" as const }
      : field === "targetCircleId" ? { targetCircleId: f.circle.id } : { requestedByUserId: f.user.id };
    await cycle(f.workspace.id, [{ kind: "AdviceRequest", id: f.request.id }],
      () => prisma.adviceRequest.update({ where: { id: f.request.id }, data: change }),
      () => prisma.adviceRequest.update({ where: { id: f.request.id }, data: restore }));
  });

  it("keeps a stable advice-recipient policy across deletion and recreation with a new row ID", async () => {
    const f = await adviceFixture();
    const recipient = await prisma.adviceRequestRecipient.create({ data: { requestId: f.request.id, memberId: f.otherMember.id } });
    let replacementId = "";
    await cycle(f.workspace.id, [{ kind: "AdviceRequestRecipientsPolicy", id: f.request.id }],
      () => prisma.adviceRequestRecipient.delete({ where: { id: recipient.id } }),
      async () => { replacementId = (await prisma.adviceRequestRecipient.create({ data: { requestId: f.request.id, memberId: f.otherMember.id } })).id; });
    expect(replacementId).not.toBe(recipient.id);
  });

  it("binds circle advice to membership assignment expiry and delete/recreate transitions", async () => {
    const f = await adviceFixture();
    const assignment = await prisma.roleAssignment.create({ data: { roleId: f.role.id, memberId: f.otherMember.id } });
    const identity = { kind: "CircleRolePolicy", id: f.circle.id };
    expect(artifactPermissionEpochIdentities("AdviceRequest", f.request)).toContainEqual(identity);
    const ids = [identity, { kind: "MemberRolePolicy", id: f.otherMember.id }, { kind: "ModulePolicy", id: "finance" }];
    await cycle(f.workspace.id, ids,
      () => prisma.roleAssignment.update({ where: { id: assignment.id }, data: { expiresAt: new Date(0) } }),
      () => prisma.roleAssignment.update({ where: { id: assignment.id }, data: { expiresAt: null } }));
    await cycle(f.workspace.id, ids,
      () => prisma.roleAssignment.delete({ where: { id: assignment.id } }),
      () => prisma.roleAssignment.create({ data: { roleId: f.role.id, memberId: f.otherMember.id } }));
  });

  it("invalidates external-user deletion/restoration even when the mapped principal returns unchanged", async () => {
    const f = await communicationFixture();
    const external = await prisma.communicationExternalUser.create({ data: { workspaceId: f.workspace.id, installationId: f.installation.id,
      provider: "SLACK", externalUserId: "synthetic-external-user", userId: f.user.id, memberId: f.member.id } });
    await cycle(f.workspace.id, [{ kind: "CommunicationExternalUser", id: external.id }],
      () => prisma.communicationExternalUser.update({ where: { id: external.id }, data: { isDeleted: true } }),
      () => prisma.communicationExternalUser.update({ where: { id: external.id }, data: { isDeleted: false } }));
  });

  it("invalidates entity-link message rebinding and tracks the unchanged link's parent message epoch", async () => {
    const f = await communicationFixture();
    const other = await prisma.communicationMessage.create({ data: { workspaceId: f.workspace.id, installationId: f.installation.id,
      provider: "SLACK", externalChannelId: f.channel.externalChannelId, externalMessageId: "other-message", text: "Other synthetic message" } });
    const action = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id, title: "Synthetic linked action" } });
    const link = await prisma.communicationEntityLink.create({ data: { workspaceId: f.workspace.id, installationId: f.installation.id,
      provider: "SLACK", messageId: f.message.id, entityType: "Action", entityId: action.id, action: "created" } });
    await cycle(f.workspace.id, [{ kind: "CommunicationEntityLink", id: link.id }],
      () => prisma.communicationEntityLink.update({ where: { id: link.id }, data: { messageId: other.id } }),
      () => prisma.communicationEntityLink.update({ where: { id: link.id }, data: { messageId: f.message.id } }));
    const ids = artifactPermissionEpochIdentities("CommunicationEntityLink", link);
    expect(ids).toContainEqual({ kind: "CommunicationMessage", id: f.message.id });
    const before = await capture(f.workspace.id, ids);
    await cycle(f.workspace.id, [{ kind: "CommunicationMessage", id: f.message.id }],
      () => prisma.communicationMessage.update({ where: { id: f.message.id }, data: { isHidden: true } }),
      () => prisma.communicationMessage.update({ where: { id: f.message.id }, data: { isHidden: false } }));
    expect(await prisma.communicationEntityLink.findUnique({ where: { id: link.id } })).toEqual(link);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
  });

  it.each(["classification", "publicEnabledAt", "publicRevokedAt", "publicTokenHash"] as const)("invalidates BuildArtifact %s round trips", async field => {
    const f = await fixture(); const enabled = new Date("2026-10-13T00:00:00Z");
    const artifact = await prisma.buildArtifact.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.user.id,
      repositoryOwner: "synthetic", repositoryName: "epoch-fixture", title: "Synthetic public review", classification: "OPEN_CORE",
      visibility: "PUBLIC_REVIEW", publicEnabledAt: enabled, publicTokenHash: `synthetic-${randomUUID()}` } });
    const changed = field === "classification" ? { classification: "CLIENT_PRIVATE" as const }
      : field === "publicEnabledAt" ? { publicEnabledAt: null }
        : field === "publicRevokedAt" ? { publicRevokedAt: new Date() } : { publicTokenHash: `rotated-${randomUUID()}` };
    const restored = field === "classification" ? { classification: "OPEN_CORE" as const }
      : field === "publicEnabledAt" ? { publicEnabledAt: enabled }
        : field === "publicRevokedAt" ? { publicRevokedAt: null } : { publicTokenHash: artifact.publicTokenHash };
    await cycle(f.workspace.id, [{ kind: "BuildArtifact", id: artifact.id }],
      () => prisma.buildArtifact.update({ where: { id: artifact.id }, data: changed }),
      () => prisma.buildArtifact.update({ where: { id: artifact.id }, data: restored }));
  });

  it("invalidates finance config changes despite an unchanged enabled flag and stable policy ID", async () => {
    const f = await fixture(); const allowed = { financeAllMemberWrite: true, reportImports: true };
    const flag = await prisma.workspaceFeatureFlag.create({ data: { workspaceId: f.workspace.id, flag: "FINANCE", enabled: true, config: allowed } });
    const identity = { kind: "FeaturePolicy", id: "FINANCE" };
    expect(artifactPermissionEpochIdentities("BrainSource", { id: "synthetic-finance-source", workspaceId: f.workspace.id, accessDomain: "FINANCE" })).toContainEqual(identity);
    await cycle(f.workspace.id, [identity],
      () => prisma.workspaceFeatureFlag.update({ where: { id: flag.id }, data: { config: { financeAllMemberWrite: false, reportImports: false } } }),
      () => prisma.workspaceFeatureFlag.update({ where: { id: flag.id }, data: { config: allowed } }));
    expect((await prisma.workspaceFeatureFlag.findUniqueOrThrow({ where: { id: flag.id } })).enabled).toBe(true);
  });

  it("permanently rejects incomplete v1 policy vectors even when their recorded counters still match", async () => {
    const f = await fixture(); const fresh = await capture(f.workspace.id, [{ kind: "Workspace", id: f.workspace.id }]);
    expect(fresh.policyVersion).toBe(SOURCE_PERMISSION_POLICY_VERSION);
    expect(SOURCE_PERMISSION_POLICY_VERSION).toBe("pun68-permissions-v3");
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, { ...fresh, policyVersion: "pun68-permissions-v1" })).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, fresh)).toBe(true);
  });
});
