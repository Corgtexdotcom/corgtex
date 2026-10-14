import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { mcpCredentialVersion } from "../../shared/src/mcp-context";
import { runWithSupportOrigin } from "../../shared/src/support-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureArtifactPermissionEpochs,
  isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage, type LineageInput, type LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";

beforeEach(async () => { await runWithSupportOrigin(undefined, truncateAllTables); });
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic parent epochs", slug: `parent-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic other workspace", slug: `parent-other-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `parent-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `parent-other-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: other.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } };
  const otherActor: AppActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } };
  return { workspace, foreign, user, other, member, actor, otherActor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function original(f: Fixture, input: LineageInput, row: object) {
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
    artifact: input, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
}
async function preserveChild(f: Fixture, input: LineageInput) {
  return prisma.$transaction(async tx => {
    const snapshot = await captureArtifactInputSnapshotProof(f.actor, f.workspace.id, input, tx);
    const epochs = await captureArtifactPermissionEpochs(f.actor, f.workspace.id, snapshot, tx);
    const source = await tx.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "ARTICLE", tier: 2,
      title: "Synthetic derived child", content: "Only the actual independent child input is copied" } });
    const manifest = await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "DERIVED", inputs: [], inheritedRoots: snapshot });
    const output = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: source.id }], tx);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, snapshot, tx)).toBe(true);
    return { snapshot, epochs, source, manifest, output };
  });
}
async function stale(f: Fixture, receipt: Awaited<ReturnType<typeof preserveChild>>) {
  expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, receipt.epochs)).toBe(false);
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, receipt.snapshot)).toBe(false);
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, receipt.output)).toBe(false);
  await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: receipt.source.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  expect(await prisma.brainSource.findUnique({ where: { id: receipt.source.id } })).toEqual(receipt.source);
}

describe("parent governors captured by actual source receipts", () => {
  it.each(["Goal", "Action", "BrainArticle", "ApprovalSubject"] as const)("keeps a %s child's snapshot and generated output stale after privacy/archive restoration", async family => {
    const f = await fixture();
    let child: LineageInput;
    let parent: LineageInput;
    let revoke: () => Promise<unknown>;
    let restore: () => Promise<unknown>;
    if (family === "Goal") {
      const row = await prisma.goal.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id, title: "Synthetic parent goal" } });
      const key = await prisma.keyResult.create({ data: { goalId: row.id, title: "Independent child result" } });
      parent = { kind: "Goal", id: row.id }; child = { kind: "KeyResult", id: key.id };
      await original(f, child, key);
      revoke = () => prisma.goal.update({ where: { id: row.id }, data: { archivedAt: new Date(), isPrivate: true } });
      restore = () => prisma.goal.update({ where: { id: row.id }, data: { archivedAt: null, isPrivate: false, updatedAt: row.updatedAt } });
    } else if (family === "BrainArticle") {
      const row = await prisma.brainArticle.create({ data: { workspaceId: f.workspace.id, slug: "synthetic-parent", title: "Synthetic parent article", type: "PROCESS", bodyMd: "Parent body never copied", sourceIds: [] } });
      const version = await prisma.brainArticleVersion.create({ data: { articleId: row.id, version: 1, bodyMd: "Independent historical child", accessEnvelopeJson: { isPrivate: false, ownerMemberId: null } } });
      parent = { kind: "BrainArticle", id: row.id }; child = { kind: "BrainArticleVersion", id: version.id };
      await original(f, child, version);
      revoke = () => prisma.brainArticle.update({ where: { id: row.id }, data: { archivedAt: new Date(), isPrivate: true } });
      restore = () => prisma.brainArticle.update({ where: { id: row.id }, data: { archivedAt: null, isPrivate: false, updatedAt: row.updatedAt } });
    } else {
      const row = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id, title: "Synthetic parent action" } });
      parent = { kind: "Action", id: row.id };
      if (family === "ApprovalSubject") {
        const flow = await prisma.approvalFlow.create({ data: { workspaceId: f.workspace.id, subjectType: "ACTION", subjectId: row.id, mode: "SINGLE" } });
        const decision = await prisma.approvalDecision.create({ data: { flowId: flow.id, memberId: f.member.id, choice: "APPROVE", rationale: "Independent human decision" } });
        child = { kind: "ApprovalDecision", id: decision.id }; await original(f, child, decision);
      } else {
        const checklist = await prisma.actionChecklistItem.create({ data: { workspaceId: f.workspace.id, actionId: row.id, title: "Independent child checklist" } });
        child = { kind: "ActionChecklistItem", id: checklist.id }; await original(f, child, checklist);
      }
      revoke = () => prisma.action.update({ where: { id: row.id }, data: { archivedAt: new Date(), isPrivate: true } });
      restore = () => prisma.action.update({ where: { id: row.id }, data: { archivedAt: null, isPrivate: false, updatedAt: row.updatedAt } });
    }
    const receipt = await preserveChild(f, child);
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining(parent));
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining(child));
    await expect(isArtifactInputProofReadable(f.otherActor, f.workspace.id, receipt.output)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(await isArtifactInputProofReadable(f.otherActor, f.foreign.id, receipt.output)).toBe(false);
    await revoke(); await stale(f, receipt);
    await restore(); await stale(f, receipt);
    const freshOriginal = await captureArtifactInputProof(f.actor, f.workspace.id, [child]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, freshOriginal)).toBe(true);
  });

  it.each(["inactive member", "archived role", "archived circle"] as const)("refuses fresh RoleAssignment capture with an %s", async governor => {
    const f = await fixture();
    const assignee = await prisma.member.create({ data: { workspaceId: f.workspace.id, userId: f.other.id, role: "CONTRIBUTOR" } });
    const circle = await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "Synthetic live circle" } });
    const role = await prisma.role.create({ data: { circleId: circle.id, name: "Synthetic live role", accountabilities: [], artifacts: [] } });
    const assignment = await prisma.roleAssignment.create({ data: { roleId: role.id, memberId: assignee.id } });
    const input = { kind: "RoleAssignment" as const, id: assignment.id };
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [input]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    if (governor === "inactive member") await prisma.member.update({ where: { id: assignee.id }, data: { isActive: false } });
    else if (governor === "archived role") await prisma.role.update({ where: { id: role.id }, data: { archivedAt: new Date() } });
    else await prisma.circle.update({ where: { id: circle.id }, data: { archivedAt: new Date() } });
    // The caller remains a current administrator; the related holder/role/circle
    // grant, not cached caller membership, makes the fresh native capture fail.
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [input])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
    expect(await prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(assignment);
  });

  it("captures permission parents without copying or requiring their unproved body", async () => {
    const f = await fixture();
    const goal = await prisma.goal.create({ data: { workspaceId: f.workspace.id, title: "Unproved parent body never consumed" } });
    const result = await prisma.keyResult.create({ data: { goalId: goal.id, title: "Independent original child" } });
    await original(f, { kind: "KeyResult", id: result.id }, result);
    const receipt = await preserveChild(f, { kind: "KeyResult", id: result.id });
    await prisma.goal.update({ where: { id: goal.id }, data: { title: "Changed unconsumed parent title", descriptionMd: "New unconsumed parent body" } });
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, receipt.epochs)).toBe(true);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, receipt.output)).toBe(true);
    const snapshot = await prisma.artifactInputSnapshot.findUniqueOrThrow({ where: { id: receipt.snapshot[0].id } });
    expect(JSON.stringify(snapshot.contentJson)).not.toContain("Unproved parent body");
    expect(JSON.stringify(snapshot.rootsJson)).not.toContain(goal.id);
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Goal", id: goal.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("invalidates a governing child FK rebind and restoration even when both parents remain permitted", async () => {
    const f = await fixture();
    const first = await prisma.goal.create({ data: { workspaceId: f.workspace.id, title: "First permitted parent" } });
    const second = await prisma.goal.create({ data: { workspaceId: f.workspace.id, title: "Second permitted parent" } });
    const result = await prisma.keyResult.create({ data: { goalId: first.id, title: "Stable child" } });
    await original(f, { kind: "KeyResult", id: result.id }, result);
    const receipt = await preserveChild(f, { kind: "KeyResult", id: result.id });
    await prisma.keyResult.update({ where: { id: result.id }, data: { goalId: second.id } });
    await stale(f, receipt);
    await prisma.keyResult.update({ where: { id: result.id }, data: { goalId: first.id, updatedAt: result.updatedAt } });
    expect(await prisma.keyResult.findUnique({ where: { id: result.id } })).toEqual(result);
    await stale(f, receipt);
  });

  it("binds MeetingAgenda to the actual Meeting archive governor", async () => {
    const f = await fixture();
    const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, source: "synthetic", recordedAt: new Date(), participantIds: [], agendaJson: { items: ["Independent human agenda"] } } });
    const agenda = { id: meeting.id, workspaceId: meeting.workspaceId, agendaJson: meeting.agendaJson, archivedAt: meeting.archivedAt, createdAt: meeting.createdAt };
    await original(f, { kind: "MeetingAgenda", id: meeting.id }, agenda);
    const receipt = await preserveChild(f, { kind: "MeetingAgenda", id: meeting.id });
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining({ kind: "Meeting", id: meeting.id }));
    await prisma.meeting.update({ where: { id: meeting.id }, data: { archivedAt: new Date() } });
    await stale(f, receipt);
    await prisma.meeting.update({ where: { id: meeting.id }, data: { archivedAt: null, updatedAt: meeting.updatedAt } });
    await stale(f, receipt);
  });

  it("follows CRM message, conversation and account permission parents through account archive restoration", async () => {
    const f = await fixture();
    const account = await prisma.crmAccount.create({ data: { workspaceId: f.workspace.id, slug: "synthetic-parent", name: "Synthetic account" } });
    const conversation = await prisma.crmConversation.create({ data: { workspaceId: f.workspace.id, accountId: account.id, subject: "Unconsumed conversation title" } });
    const message = await prisma.crmConversationMessage.create({ data: { conversationId: conversation.id, senderType: "ADMIN", senderUserId: f.user.id, bodyMd: "Independent original child message" } });
    await original(f, { kind: "CrmConversationMessage", id: message.id }, message);
    const receipt = await preserveChild(f, { kind: "CrmConversationMessage", id: message.id });
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining({ kind: "CrmConversation", id: conversation.id }));
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining({ kind: "CrmAccount", id: account.id }));
    await prisma.crmAccount.update({ where: { id: account.id }, data: { archivedAt: new Date() } });
    await stale(f, receipt);
    await prisma.crmAccount.update({ where: { id: account.id }, data: { archivedAt: null, updatedAt: account.updatedAt } });
    await stale(f, receipt);
  });

  it.each(["membership", "support-role", "support-recreate"] as const)("keeps foreign prospect receipts stale through target-workspace %s restoration", async change => runWithSupportOrigin(undefined, async () => {
    const f = await fixture();
    const targetMember = await prisma.member.create({ data: { workspaceId: f.foreign.id, userId: f.user.id, role: "ADMIN" } });
    const support = change === "membership" ? null : await prisma.workspaceSupportGrant.create({ data: {
      workspaceId: f.foreign.id, userId: f.user.id, grantedByUserId: f.user.id, role: "FULL" } });
    const lead = await prisma.demoLead.create({ data: { workspaceId: f.workspace.id, email: "synthetic-prospect@example.test" } });
    const prospect = await prisma.crmProspectWorkspace.create({ data: { crmWorkspaceId: f.workspace.id,
      targetWorkspaceId: f.foreign.id, demoLeadId: lead.id, adminEmail: "synthetic-prospect@example.test" } });
    await original(f, { kind: "CrmProspectWorkspace", id: prospect.id }, prospect);
    const receipt = await preserveChild(f, { kind: "CrmProspectWorkspace", id: prospect.id });
    expect(receipt.epochs.entries).toContainEqual(expect.objectContaining({ kind: "CrmProspectTargetAccessPolicy", id: f.foreign.id }));
    if (change === "membership") {
      await prisma.member.update({ where: { id: targetMember.id }, data: { isActive: false } });
      await stale(f, receipt);
      await prisma.member.update({ where: { id: targetMember.id }, data: { isActive: true } });
    } else if (change === "support-role") {
      await prisma.workspaceSupportGrant.update({ where: { id: support!.id }, data: { role: "SETUP" } });
      await stale(f, receipt);
      await prisma.workspaceSupportGrant.update({ where: { id: support!.id }, data: { role: "FULL", updatedAt: support!.updatedAt } });
    } else {
      await prisma.workspaceSupportGrant.delete({ where: { id: support!.id } });
      await stale(f, receipt);
      const replacement = await prisma.workspaceSupportGrant.create({ data: { workspaceId: f.foreign.id, userId: f.user.id, grantedByUserId: f.user.id, role: "FULL" } });
      expect(replacement.id).not.toBe(support!.id);
    }
    expect(await prisma.crmProspectWorkspace.findUnique({ where: { id: prospect.id } })).toEqual(prospect);
    await stale(f, receipt);
  }));

  it("can capture write-output governors without granting a write-only credential content read scope", async () => {
    const f = await fixture();
    const credential = await prisma.agentCredential.create({ data: { workspaceId: f.workspace.id,
      label: "Synthetic write only", tokenHash: randomUUID(), scopes: ["actions:write"] } });
    const actor: AppActor = { kind: "agent", authProvider: "credential", credentialId: credential.id,
      credentialVersion: mcpCredentialVersion(credential.tokenHash), label: credential.label, scopes: credential.scopes, workspaceIds: [f.workspace.id] };
    const output = await prisma.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id, title: "Public write output" } });
    const root: LineageRoot = { kind: "Action", id: output.id, fingerprint: lineageContentFingerprint("Action", output) };
    const epochs = await prisma.$transaction(tx => captureArtifactPermissionEpochs(actor, f.workspace.id, [root], tx));
    expect(epochs.entries).toContainEqual(expect.objectContaining({ kind: "Action", id: output.id }));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, epochs)).toBe(true);
    await original(f, { kind: "Action", id: output.id }, output);
    await expect(captureArtifactInputProof(actor, f.workspace.id, [{ kind: "Action", id: output.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
});
