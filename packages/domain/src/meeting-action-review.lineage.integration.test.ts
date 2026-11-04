import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, readableArtifactIds, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import { createMeeting } from "./meetings";
import { markSlackMeetingActionReviewPosted } from "./meeting-action-review";

const target = vi.hoisted(() => ({ validate: vi.fn(async () => ({ ok: true })) }));
vi.mock("./communication", async original => ({ ...await original<typeof import("./communication")>(), validateSlackPostTarget: target.validate }));
beforeEach(async () => { await truncateAllTables(); target.validate.mockReset().mockResolvedValue({ ok: true }); });
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Slack review", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const peerUser = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: peerUser.id, role: "CONTRIBUTOR" } });
  const peer: AppActor = { kind: "user", user: peerUser };
  const installation = await prisma.communicationInstallation.create({ data: { workspaceId: workspace.id, provider: "SLACK", externalWorkspaceId: randomUUID() } });
  const channel = await prisma.communicationChannel.create({ data: { workspaceId: workspace.id, installationId: installation.id,
    provider: "SLACK", externalChannelId: "synthetic-channel", kind: "PUBLIC" } });
  const meeting = await createMeeting(actor, { workspaceId: workspace.id, source: "WEB_REQUEST", recordedAt: new Date(),
    transcript: "Original synthetic meeting", title: "Synthetic meeting" });
  const review = await prisma.meetingFollowUpReview.create({ data: { workspaceId: workspace.id, meetingId: meeting.id,
    installationId: installation.id, channelId: channel.externalChannelId, expiresAt: new Date(Date.now() + 60_000) } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "MeetingFollowUpReview", id: review.id }, content: review, origin: "DERIVED",
    inputs: [{ kind: "MeetingTranscript", id: meeting.id }] }));
  const worker: AppActor = { kind: "agent", authProvider: "bootstrap", label: "meeting-agenda", workspaceIds: [workspace.id] };
  const lineageRoots = [
    ...await captureArtifactInputProof(worker, workspace.id, [{ kind: "MeetingTranscript", id: meeting.id }]),
    ...await prisma.$transaction(tx => captureArtifactInputSnapshotProof(worker, workspace.id,
      { kind: "MeetingFollowUpReview", id: review.id, fingerprint: lineageContentFingerprint("MeetingFollowUpReview", review) }, tx)),
  ];
  const params = { workspaceId: workspace.id, meetingId: meeting.id, reviewId: review.id, reviewFingerprint: lineageContentFingerprint("MeetingFollowUpReview", review), installationId: installation.id,
    channelId: channel.externalChannelId, messageTs: "1792000000.000001", threadTs: null,
    text: "Synthetic approved meeting review", lineageRoots };
  return { actor, peer, worker, meeting, review, channel, params };
}

it("stores an ordinary Slack agenda worker's approved message with current member-readable lineage", async () => {
  const f = await fixture();
  await markSlackMeetingActionReviewPosted(f.worker, f.params);
  const message = await prisma.communicationMessage.findFirstOrThrow({ where: { workspaceId: f.params.workspaceId } });
  expect(message).toMatchObject({ text: f.params.text, isBot: true });
  expect(await readableArtifactIds(f.peer, f.params.workspaceId, "CommunicationMessage", [message])).toEqual(new Set([message.id]));
  expect(await prisma.artifactInputLineage.findFirst({ where: { artifactType: "CommunicationMessage", artifactId: message.id } })).toMatchObject({ origin: "DERIVED" });
  expect(await prisma.meetingFollowUpReview.findUnique({ where: { id: f.review.id } })).toMatchObject({ messageTs: f.params.messageTs });
  expect(await prisma.communicationEntityLink.count({ where: { messageId: message.id } })).toBe(1);
  await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: new Date() } });
  expect(await readableArtifactIds(f.peer, f.params.workspaceId, "CommunicationMessage", [message])).toEqual(new Set());
});

it("rejects original proof revocation during destination validation before creating any posted state", async () => {
  const f = await fixture();
  target.validate.mockImplementationOnce(async () => {
    await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: new Date() } });
    return { ok: true };
  });
  await expect(markSlackMeetingActionReviewPosted(f.worker, f.params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
  expect(await prisma.communicationMessage.count()).toBe(0);
  expect(await prisma.communicationEntityLink.count()).toBe(0);
  expect(await prisma.meetingFollowUpReview.findUnique({ where: { id: f.review.id } })).toMatchObject({ messageTs: null });
});

it("rolls back the message and its proof if the final entity-link write fails", async () => {
  const f = await fixture();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION synthetic_review_link_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic final-link failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER synthetic_review_link_failure BEFORE INSERT ON "CommunicationEntityLink" FOR EACH ROW EXECUTE FUNCTION synthetic_review_link_failure()`);
  try {
    await expect(markSlackMeetingActionReviewPosted(f.worker, f.params)).rejects.toThrow("Synthetic final-link failure");
    expect(await prisma.communicationMessage.count()).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { artifactType: "CommunicationMessage" } })).toBe(0);
    expect(await prisma.meetingFollowUpReview.findUnique({ where: { id: f.review.id } })).toMatchObject({ messageTs: null });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER synthetic_review_link_failure ON "CommunicationEntityLink"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION synthetic_review_link_failure()`);
  }
});

it("rejects changed review destinations without persisting a message", async () => {
  const f = await fixture();
  await prisma.meetingFollowUpReview.update({ where: { id: f.review.id }, data: { channelId: "other-channel" } });
  await expect(markSlackMeetingActionReviewPosted(f.worker, f.params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(await prisma.communicationMessage.count()).toBe(0);
});

it.each([{threadTs: "other-thread"}, {status: "CLOSED" as const}, {expiresAt: new Date("2025-01-01")}])("rejects a same-channel prepared review change %j", async change => {
  const f = await fixture();
  await prisma.meetingFollowUpReview.update({where: {id: f.review.id}, data: change});
  await expect(markSlackMeetingActionReviewPosted(f.worker, f.params)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(await prisma.communicationMessage.count()).toBe(0);
  expect(await prisma.communicationEntityLink.count()).toBe(0);
});
