import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import * as lineage from "./source-lineage";
import { publishProposal, submitProposal, returnProposalToDraft } from "./proposals";
import { meetingAgendaInputProjection, meetingTranscriptInputProjection } from "./meeting-intelligence-context";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(options: { raceFullSupport?: boolean } = {}) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic governed epoch", slug: `epoch-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `epoch-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `epoch-reader-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  if (options.raceFullSupport) {
    // Missing Finance/support rows intentionally take Workspace FOR UPDATE,
    // serializing lineage INSERTs through the Workspace FK. This supported
    // explicit policy fixture instead exercises the late unique-revision CAS.
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "FINANCE", enabled: false } });
    await prisma.workspaceSupportGrant.create({ data: { workspaceId: workspace.id, userId: owner.id,
      grantedByUserId: owner.id, role: "FULL", isActive: true } });
  }
  const actor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null } };
  const otherActor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: null } };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1, title: "Public original", content: "Public source body", authorMemberId: member.id } });
  const proposal = await prisma.proposal.create({ data: { workspaceId: workspace.id, authorUserId: owner.id, ownerMemberId: member.id,
    title: "Derived draft", bodyMd: "Derived from the public original", isPrivate: true } });
  await prisma.$transaction(async tx => {
    await lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Proposal", id: proposal.id }, content: proposal,
      origin: "DERIVED", inputs: [{ kind: "BrainSource", id: source.id }] });
  });
  return { workspace, owner, member, actor, otherActor, source, proposal };
}
async function manifest(id: string) {
  return prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Proposal", artifactId: id }, orderBy: { revision: "desc" } });
}
describe("governed artifact epoch advancement", () => {
  it("publishes a derived private proposal without losing its ordinary-reader visibility", async () => {
    const f = await fixture(); const before = await manifest(f.proposal.id);
    expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, "Proposal", [f.proposal])).toEqual(new Set([f.proposal.id]));
    const result = await publishProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.proposal.id });
    expect(result.isPrivate).toBe(false);
    expect(await lineage.readableArtifactIds(f.otherActor, f.workspace.id, "Proposal", [result])).toEqual(new Set([result.id]));
    const after = await manifest(f.proposal.id);
    expect(after.rootsJson).toEqual(before.rootsJson); expect(after.inputsJson).toEqual(before.inputsJson);
    const saved = before.permissionEpochsJson as { entries: Array<{ kind: string; id: string; epoch: string }> };
    const next = after.permissionEpochsJson as typeof saved;
    expect(next.entries.filter(entry => entry.kind !== "Proposal" || entry.id !== f.proposal.id))
      .toEqual(saved.entries.filter(entry => entry.kind !== "Proposal" || entry.id !== f.proposal.id));
    expect(next.entries.find(entry => entry.kind === "Proposal" && entry.id === f.proposal.id)?.epoch)
      .not.toBe(saved.entries.find(entry => entry.kind === "Proposal" && entry.id === f.proposal.id)?.epoch);
    expect(await prisma.artifactInputLineage.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });
});


it("carries a derived proposal through submit and return-to-private draft", async () => {
  const f = await fixture();
  await prisma.approvalPolicy.create({ data: { workspaceId: f.workspace.id, subjectType: "PROPOSAL", mode: "CONSENT", decisionWindowHours: 168 } });
  await submitProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.proposal.id });
  const opened = await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal.id } });
  expect(opened.status).toBe("OPEN");
  expect(await lineage.readableArtifactIds(f.otherActor, f.workspace.id, "Proposal", [opened])).toEqual(new Set([opened.id]));
  await returnProposalToDraft(f.actor, { workspaceId: f.workspace.id, proposalId: f.proposal.id });
  const draft = await prisma.proposal.findUniqueOrThrow({ where: { id: opened.id } });
  expect(draft.isPrivate).toBe(true);
  expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, "Proposal", [draft])).toEqual(new Set([draft.id]));
  expect(await lineage.readableArtifactIds(f.otherActor, f.workspace.id, "Proposal", [draft])).toEqual(new Set());
});

it.each(["own-aba", "upstream-aba", "malformed"] as const)("does not revive a preexisting %s proof", async mode => {
  const f = await fixture(); const before = await manifest(f.proposal.id);
  if (mode === "own-aba") {
    await prisma.proposal.update({ where: { id: f.proposal.id }, data: { isPrivate: false } });
    await prisma.proposal.update({ where: { id: f.proposal.id }, data: { isPrivate: true } });
  } else if (mode === "upstream-aba") {
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
  } else await prisma.artifactInputLineage.update({ where: { id: before.id }, data: { permissionEpochsJson: {} } });
  await expect(publishProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.proposal.id }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).isPrivate).toBe(true);
  expect((await manifest(f.proposal.id)).revision).toBe(before.revision);
});

it.each(["forged", "missing", "other-actor", "other-artifact", "reuse", "caller-withdrawal", "upstream-aba", "new-circle"] as const)(
  "rolls back a governed edit with %s", async mode => {
    const f = await fixture(); const beforeManifest = await manifest(f.proposal.id);
    const circle = mode === "new-circle" ? await prisma.circle.create({ data: { workspaceId: f.workspace.id, name: "New governor" } }) : null;
    await expect(prisma.$transaction(async tx => {
      const artifact = { kind: "Proposal" as const, id: f.proposal.id };
      const admission = await lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal });
      expect(admission).toBeDefined();
      if (mode === "caller-withdrawal") await tx.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      if (mode === "upstream-aba") {
        await tx.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
        await tx.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: null } });
      }
      const after = await tx.proposal.update({ where: { id: artifact.id }, data: { isPrivate: false, ...(circle ? { circleId: circle.id } : {}) } });
      const args = { tx, actor: mode === "other-actor" ? f.otherActor : f.actor, workspaceId: f.workspace.id,
        artifact: mode === "other-artifact" ? { ...artifact, id: "different-artifact" } : artifact, before: f.proposal, after,
        admission: mode === "forged" ? Object.freeze({}) : mode === "missing" ? undefined : admission };
      await lineage.advanceHumanArtifactInputLineage(args);
      if (mode === "reuse") await lineage.advanceHumanArtifactInputLineage(args);
    })).rejects.toMatchObject({ code: mode === "caller-withdrawal" ? "NOT_A_MEMBER"
      : ["upstream-aba", "new-circle"].includes(mode) ? "SOURCE_RESTRICTED" : "SOURCE_CHANGED" });
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).isPrivate).toBe(true);
    expect((await manifest(f.proposal.id)).revision).toBe(beforeManifest.revision);
  },
);

it("rejects a receipt moved to a later transaction", async () => {
  const f = await fixture(); const artifact = { kind: "Proposal" as const, id: f.proposal.id };
  const admission = await prisma.$transaction(tx => lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal }));
  expect(admission).toBeDefined();
  await expect(prisma.$transaction(async tx => {
    const after = await tx.proposal.update({ where: { id: artifact.id }, data: { isPrivate: false } });
    await lineage.advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal, after, admission });
  })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it("rolls back if a manifest-only writer wins the original revision during final insertion", async () => {
  const f = await fixture({ raceFullSupport: true }); const original = await manifest(f.proposal.id);
  await expect(prisma.$transaction(async rawTx => {
    let externalInserted = false;
    const create = rawTx.artifactInputLineage.create.bind(rawTx.artifactInputLineage);
    const delegate = new Proxy(rawTx.artifactInputLineage, { get(target, property) {
      if (property !== "create") return Reflect.get(target, property);
      return async (args: Parameters<typeof create>[0]) => {
        expect(externalInserted).toBe(false);
        // Intercept before constructing Prisma's lazy insertion promise.
        expect(await rawTx.artifactInputLineage.count({ where: { artifactType: "Proposal", artifactId: f.proposal.id, revision: original.revision + 1 } })).toBe(0);
        await prisma.$executeRaw(Prisma.sql`INSERT INTO "ArtifactInputLineage"
          (id,"workspaceId","artifactType","artifactId",revision,origin,"contentHash","inputsJson","rootsJson","epochProofVersion","permissionEpochsJson")
          VALUES (${randomUUID()},${original.workspaceId},${original.artifactType},${original.artifactId},${original.revision + 1},${original.origin},
          ${original.contentHash},${JSON.stringify(original.inputsJson)}::jsonb,${JSON.stringify(original.rootsJson)}::jsonb,
          ${original.epochProofVersion},${JSON.stringify(original.permissionEpochsJson)}::jsonb)`);
        externalInserted = true;
        return create(args);
      };
    } });
    const tx = new Proxy(rawTx, { get(target, property) {
      return property === "artifactInputLineage" ? delegate : Reflect.get(target, property);
    } });
    const artifact = { kind: "Proposal" as const, id: f.proposal.id };
    const admission = await lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal });
    expect(admission).toBeDefined();
    const after = await tx.proposal.update({ where: { id: artifact.id }, data: { isPrivate: false } });
    await lineage.advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal, after, admission });
  }, { timeout: 10000 })).rejects.toMatchObject({ code: "P2002" });
  expect((await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).isPrivate).toBe(true);
  const winner = await manifest(f.proposal.id);
  expect(winner.revision).toBe(original.revision + 1);
  expect(winner.contentHash).toBe(original.contentHash);
  expect(winner.permissionEpochsJson).toEqual(original.permissionEpochsJson);
});

it.each(["MeetingTranscript", "MeetingAgenda"] as const)("uses the physical Meeting own epoch for %s", async kind => {
  const f = await fixture();
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, source: "manual", recordedAt: new Date(),
    title: "Synthetic meeting", transcript: "Synthetic transcript", participantIds: [], agendaJson: { items: [] } } });
  const artifact = { kind, id: meeting.id };
  const project = kind === "MeetingTranscript" ? meetingTranscriptInputProjection : meetingAgendaInputProjection;
  const content = project(meeting);
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, content,
    origin: "DERIVED", inputs: [{ kind: "BrainSource", id: f.source.id }] }));
  const before = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: kind, artifactId: meeting.id }, orderBy: { revision: "desc" } });
  expect(await lineage.readableArtifactIds(f.actor, f.workspace.id, kind, [content as { id: string }])).toEqual(new Set([meeting.id]));
  await prisma.$transaction(async tx => {
    const admission = await lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: content });
    expect(admission).toBeDefined();
    // A real governed transition bumps the aliased physical key twice, not +1.
    await tx.meeting.update({ where: { id: meeting.id }, data: { archivedAt: new Date() } });
    const after = await tx.meeting.update({ where: { id: meeting.id }, data: { archivedAt: null } });
    await lineage.advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: content, after: project(after), admission });
  });
  const after = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: kind, artifactId: meeting.id }, orderBy: { revision: "desc" } });
  expect(after.rootsJson).toEqual(before.rootsJson);
  const epochs = after.permissionEpochsJson as { entries: Array<{ kind: string; id: string; epoch: string }> };
  expect(epochs.entries.some(row => row.kind === "Meeting" && row.id === meeting.id)).toBe(true);
  expect(await lineage.readableArtifactIds(f.otherActor, f.workspace.id, kind, [project(await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })) as { id: string }])).toEqual(new Set([meeting.id]));
});

it("retains an aliased own epoch inside an inherited snapshot and rejects its revocation", async () => {
  const f = await fixture();
  const meeting = await prisma.meeting.create({ data: { workspaceId: f.workspace.id, source: "manual", recordedAt: new Date(),
    transcript: "Synthetic derived transcript", participantIds: [], agendaJson: { items: ["Human original"] } } });
  const agenda = meetingAgendaInputProjection(meeting);
  const transcript = meetingTranscriptInputProjection(meeting);
  await prisma.$transaction(async tx => {
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "MeetingAgenda", id: meeting.id }, content: agenda, origin: "HUMAN_ORIGINAL", inputs: [] });
    const inheritedRoots = await lineage.captureArtifactInputSnapshotProof(f.actor, f.workspace.id, { kind: "MeetingAgenda", id: meeting.id }, tx);
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content: transcript, origin: "DERIVED", inputs: [], inheritedRoots });
  });
  const original = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "MeetingTranscript", artifactId: meeting.id } });
  await expect(prisma.$transaction(async tx => {
    const artifact = { kind: "MeetingTranscript" as const, id: meeting.id };
    const admission = await lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: transcript });
    expect(admission).toBeDefined();
    await tx.meeting.update({ where: { id: meeting.id }, data: { archivedAt: new Date() } });
    const after = await tx.meeting.update({ where: { id: meeting.id }, data: { archivedAt: null } });
    await lineage.advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact,
      before: transcript, after: meetingTranscriptInputProjection(after), admission });
  })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
  expect(await prisma.artifactInputLineage.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
});

it("rejects a same-body head replacement between admission and content advancement", async () => {
  const f = await fixture(); const original = await manifest(f.proposal.id);
  await expect(prisma.$transaction(async tx => {
    const artifact = { kind: "Proposal" as const, id: f.proposal.id };
    const admission = await lineage.captureHumanArtifactInputAdvance({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal });
    await tx.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: "Proposal", artifactId: artifact.id,
      revision: original.revision + 1, origin: "DERIVED", contentHash: original.contentHash,
      inputsJson: original.inputsJson as Prisma.InputJsonValue, rootsJson: original.rootsJson as Prisma.InputJsonValue,
      epochProofVersion: original.epochProofVersion, permissionEpochsJson: original.permissionEpochsJson as Prisma.InputJsonValue } });
    const after = await tx.proposal.update({ where: { id: artifact.id }, data: { isPrivate: false } });
    await lineage.advanceHumanArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id, artifact, before: f.proposal, after, admission });
  })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect((await manifest(f.proposal.id)).revision).toBe(original.revision);
});
