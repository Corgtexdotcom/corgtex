import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, createAction, publishAction, updateAction, requireWorkspaceMembership } = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(), $queryRaw: vi.fn(),
    meeting: { findFirst: vi.fn() },
    communicationChannel: { findFirst: vi.fn() },
    communicationInstallation: { findFirst: vi.fn() },
    member: { findMany: vi.fn(), findFirst: vi.fn() },
    meetingFollowUpReview: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    meetingInsight: { findFirst: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    workspaceFeatureFlag: { findUnique: vi.fn() },
    communicationMessage: { findUnique: vi.fn() },
    communicationEntityLink: { create: vi.fn(), upsert: vi.fn() },
  },
  createAction: vi.fn(),
  publishAction: vi.fn(),
  updateAction: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: db, env: { APP_URL: "https://example.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./actions", () => ({ createAction, publishAction, updateAction, meetingInsightActionSourcePayload: (insight: unknown) => insight }));
vi.mock("./auth", () => ({ requireWorkspaceMembership }));

const lineage = vi.hoisted(() => ({ capture: vi.fn(), snapshot: vi.fn(), public: vi.fn(), prepare: vi.fn(), finish: vi.fn() }));
vi.mock("./source-lineage", () => ({ captureArtifactInputProof: lineage.capture,
  captureArtifactInputSnapshotProof: lineage.snapshot, isArtifactInputProofPubliclyShareable: lineage.public,
  lineageContentFingerprint: vi.fn(() => "a".repeat(64)) }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: lineage.prepare, finishProducerLineage: lineage.finish }));

import { confirmSlackMeetingActionReviewProposal, refreshSlackMeetingActionReviewAfterWebApply } from "./meeting-action-review";
import { DuplicateGuardMatchError } from "./duplicate-guard";
import { humanMemberIdentityWhere, isHumanMemberIdentity } from "./member-identity";

const actor = { kind: "user" as const, user: { id: "user-1", email: "reviewer@example.test", displayName: "Reviewer" } };
const params = { workspaceId: "ws-1", installationId: "installation-1", externalUserId: "slack-user", reviewId: "review-1", insightId: "insight-1" };

describe("Slack meeting action assignee eligibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async (fn) => fn(db));
    lineage.capture.mockImplementation(async (_actor, _ws, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    lineage.snapshot.mockResolvedValue([{ kind: "ArtifactInputSnapshot", id: "review-snapshot", fingerprint: "a".repeat(64) }]);
    lineage.public.mockResolvedValue(true);
    lineage.prepare.mockResolvedValue({ mode: "DERIVED", inputs: [], roots: [] });
    lineage.finish.mockResolvedValue(undefined);
    db.meetingFollowUpReview.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));

    requireWorkspaceMembership.mockResolvedValue({ id: "reviewer-member" });
    db.meetingFollowUpReview.findFirst.mockResolvedValue({
      id: "review-1", workspaceId: "ws-1", meetingId: "meeting-1", status: "OPEN",
      expiresAt: new Date(Date.now() + 60_000), messageTs: "123.456", channelId: "channel-1",
      meeting: { id: "meeting-1", workspaceId: "ws-1", title: "Weekly sync", recordedAt: new Date(), series: null },
    });
    db.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    db.meetingInsight.findFirst.mockResolvedValue({
      id: "insight-1", status: "SUGGESTED", title: "Follow up", bodyMd: "Milan will follow up.", assigneeHint: "Milan", dueAt: null,
    });
    db.meetingInsight.findMany.mockResolvedValue([]);
    db.meetingInsight.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
    db.meetingInsight.count.mockResolvedValue(0);
    db.communicationMessage.findUnique.mockResolvedValue(null);
    createAction.mockResolvedValue({ id: "action-1", status: "OPEN" });
    publishAction.mockResolvedValue({ id: "action-1" });
  });

  it.each(["Milan", "mil"])("selects an active human for exact/fuzzy hint %s without historical or system attribution", async (hint) => {
    db.meetingInsight.findFirst.mockResolvedValue({ id: "insight-1", status: "SUGGESTED", title: "Follow up", bodyMd: "Follow up.", assigneeHint: hint });
    const candidates = [
      { id: "old", workspaceId: "ws-1", isActive: false, kind: "HUMAN" as const, user: { displayName: "Milan", email: "old@example.test" } },
      { id: "system", workspaceId: "ws-1", isActive: true, kind: "SYSTEM" as const, user: { displayName: "Milan", email: "machine@example.test" } },
      { id: "legacy-system", workspaceId: "ws-1", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "support+milan@example.test" } },
      { id: "foreign", workspaceId: "ws-2", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "foreign@example.test" } },
      { id: "active", workspaceId: "ws-1", isActive: true, kind: "HUMAN" as const, user: { displayName: "Milan", email: "milan@example.test" } },
    ];
    db.member.findMany.mockImplementation(async ({ where }) => candidates.filter((member) =>
      member.workspaceId === where.workspaceId
      && (where.isActive !== true || member.isActive)
      && (!where.NOT || isHumanMemberIdentity(member))
    ));

    await confirmSlackMeetingActionReviewProposal(actor, params);

    expect(lineage.snapshot).toHaveBeenCalledWith(actor, "ws-1", {
      kind: "MeetingInsight", id: "insight-1", fingerprint: "a".repeat(64),
    }, db);
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      lineageRoots: expect.arrayContaining([
        expect.objectContaining({ kind: "ArtifactInputSnapshot" }),
        expect.objectContaining({ kind: "Meeting", id: "meeting-1" }),
        expect.objectContaining({ kind: "Member", id: "active" }),
      ]),
    }));
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(db.member.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", isActive: true, ...humanMemberIdentityWhere() }, include: { user: true } });
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1", assigneeMemberId: "active", isPrivate: false,
      source: { type: "MEETING_INSIGHT", id: "insight-1", groupId: "meeting-1" },
    }));
    expect(publishAction).not.toHaveBeenCalled();
    expect(db.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED", reviewedByUserId: "user-1" }) }));
  });

  it("opens a legacy claimed private draft before marking the Slack insight applied", async () => {
    db.member.findMany.mockResolvedValue([{ id: "active", user: { displayName: "Milan", email: "milan@example.test" } }]);
    createAction.mockResolvedValueOnce({ id: "legacy-action", status: "DRAFT", assigneeMemberId: null, version: 4 });
    publishAction.mockResolvedValueOnce({ id: "legacy-action", status: "OPEN" });
    await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(updateAction).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "legacy-action", assigneeMemberId: "active", expectedVersion: 4 });
    expect(updateAction.mock.invocationCallOrder[0]).toBeLessThan(publishAction.mock.invocationCallOrder[0]);
    expect(publishAction).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "legacy-action" });
    expect(db.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "APPLIED", appliedEntityId: "legacy-action" }),
    }));
  });

  it("preserves the owner of a reused Slack review draft", async () => {
    db.member.findMany.mockResolvedValue([{ id: "active", user: { displayName: "Milan", email: "milan@example.test" } }]);
    db.member.findFirst.mockResolvedValue({ id: "existing-owner" });
    createAction.mockResolvedValueOnce({ id: "owned-action", status: "DRAFT", assigneeMemberId: "existing-owner" });
    publishAction.mockResolvedValueOnce({ id: "owned-action", status: "OPEN" });

    await confirmSlackMeetingActionReviewProposal(actor, params);

    expect(updateAction).not.toHaveBeenCalled();
    expect(publishAction).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "owned-action" });
  });

  it.each(["inactive-owner", "system-owner"])('repairs a reused Slack review draft with an ineligible %s', async (ownerId) => {
    db.member.findMany.mockResolvedValue([{ id: "active", user: { displayName: "Milan", email: "milan@example.test" } }]);
    db.member.findFirst.mockResolvedValue(null);
    createAction.mockResolvedValueOnce({ id: "stale-draft", status: "DRAFT", assigneeMemberId: ownerId, version: 7 });
    publishAction.mockResolvedValueOnce({ id: "stale-draft", status: "OPEN" });

    await confirmSlackMeetingActionReviewProposal(actor, params);

    expect(db.member.findFirst).toHaveBeenCalledWith({
      where: { id: ownerId, workspaceId: "ws-1", isActive: true, ...humanMemberIdentityWhere() },
      select: { id: true },
    });
    expect(updateAction).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "stale-draft", assigneeMemberId: "active", expectedVersion: 7 });
    expect(updateAction.mock.invocationCallOrder[0]).toBeLessThan(publishAction.mock.invocationCallOrder[0]);
  });

  it("leaves an inactive-only hint pending for human assignment", async () => {
    db.member.findMany.mockImplementation(async ({ where }) => where.isActive === true ? [] : [{ id: "old", user: { displayName: "Milan", email: "old@example.test" } }]);
    const result = await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(result.responseText).toContain("Assign an active human owner");
    expect(createAction).not.toHaveBeenCalled();
    expect(db.meetingInsight.update).not.toHaveBeenCalled();
  });

  it("keeps a matching Slack proposal pending and directs review to Corgtex", async () => {
    db.member.findMany.mockResolvedValue([{ id: "active", user: { displayName: "Milan", email: "milan@example.test" } }]);
    createAction.mockRejectedValueOnce(new DuplicateGuardMatchError({
      entityType: "Action", entityId: "action-existing", title: "Similar Action", excerpt: null,
      score: 0.88, matchKind: "likely", reasons: ["similar title"], status: "OPEN",
      createdAt: null, updatedAt: null, archivedAt: null,
    }));
    const result = await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(result.responseText).toContain("Review this follow-up in Corgtex");
    expect(db.meetingInsight.update).not.toHaveBeenCalled();
    expect(publishAction).not.toHaveBeenCalled();
  });

  it("closes and renders a Slack review after the insight is applied in Corgtex", async () => {
    db.meetingInsight.findFirst.mockResolvedValueOnce({ meetingId: "meeting-1", status: "APPLIED" });
    db.meetingFollowUpReview.findFirst.mockResolvedValueOnce({
      id: "review-1", installationId: "installation-1", messageTs: "123.456",
    });
    const result = await refreshSlackMeetingActionReviewAfterWebApply(actor, { workspaceId: "ws-1", insightId: "insight-1" });
    expect(db.meetingFollowUpReview.update).toHaveBeenCalledWith({
      where: { id: "review-1" }, data: { status: "CLOSED", closedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ installationId: "installation-1", update: { channelId: "channel-1", messageTs: "123.456" } });
  });

  it("refreshes a closed Slack message when an applied proposal is clicked again", async () => {
    db.meetingFollowUpReview.findFirst.mockResolvedValue({
      id: "review-1", workspaceId: "ws-1", meetingId: "meeting-1", status: "CLOSED",
      expiresAt: new Date(Date.now() - 60_000), messageTs: "123.456", channelId: "channel-1",
      meeting: { id: "meeting-1", workspaceId: "ws-1", title: "Weekly sync", recordedAt: new Date(), series: null },
    });
    db.meetingInsight.findFirst.mockResolvedValue({ id: "insight-1", status: "APPLIED" });
    const result = await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(result.responseText).toContain("already confirmed");
    expect(db.meetingFollowUpReview.update).toHaveBeenCalledWith({
      where: { id: "review-1" }, data: { status: "CLOSED", closedAt: expect.any(Date) },
    });
    expect(createAction).not.toHaveBeenCalled();
  });
  it("filters unknown and restricted insights before the proposal limit", async () => {
    const { AppError } = await import("./errors");
    const rows = [{ id: "unknown" }, { id: "private" }, { id: "permitted" }, { id: "later" }];
    db.meetingInsight.findMany.mockResolvedValue(rows);
    lineage.capture.mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs[0].id === "unknown") throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown");
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    lineage.public.mockImplementation(async (_actor, _ws, roots) => roots[0].id !== "private");
    const { listMeetingFollowUpProposals } = await import("./meeting-action-review");
    await expect(listMeetingFollowUpProposals(actor, { workspaceId: "ws-1", meetingId: "meeting-1", maxProposals: 1 }))
      .resolves.toEqual([{ id: "permitted" }]);
    expect(db.meetingInsight.findMany.mock.calls[0][0]).not.toHaveProperty("take");
    expect(lineage.capture).toHaveBeenCalledWith(actor, "ws-1", [{ kind: "MeetingInsight", id: "permitted", snapshot: rows[2] }]);
  });

  it("refuses unknown meeting summaries before creating a configured review", async () => {
    db.meeting.findFirst.mockResolvedValue({ id: "meeting-1", workspaceId: "ws-1", summaryMd: "Old summary",
      series: { externalId: "series-1" } });
    db.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true, config: { channelId: "C1", meetingSeriesExternalId: "series-1" } });
    db.communicationInstallation.findFirst.mockResolvedValue({ id: "installation-1" });
    const { AppError } = await import("./errors");
    lineage.capture.mockRejectedValue(new AppError(409, "UNKNOWN_LINEAGE", "Unknown"));
    const { prepareSlackMeetingActionReviewPost } = await import("./meeting-action-review");
    await expect(prepareSlackMeetingActionReviewPost(actor, { workspaceId: "ws-1", meetingId: "meeting-1" }))
      .resolves.toEqual({ configured: true, skipped: true, reason: "summary_inputs_unavailable" });
    expect(db.meetingFollowUpReview.upsert).not.toHaveBeenCalled();
  });

  it("records review expiry sources atomically and returns exact rendered receipts", async () => {
    const meeting = { id: "meeting-1", workspaceId: "ws-1", title: "Meeting", summaryMd: "Current summary",
      recordedAt: new Date(), seriesId: "series-1", series: { externalId: "series-1" } };
    const nextMeeting = { id: "next-meeting", recordedAt: new Date(Date.now() + 60_000) };
    db.meeting.findFirst.mockResolvedValueOnce(meeting).mockResolvedValueOnce(nextMeeting);
    db.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true, config: { channelId: "C1", meetingSeriesExternalId: "series-1" } });
    db.communicationInstallation.findFirst.mockResolvedValue({ id: "installation-1" });
    db.meetingFollowUpReview.upsert.mockImplementation(async ({ create }) => ({ id: "review-1", ...create }));
    db.meetingInsight.findMany.mockResolvedValue([{ id: "insight-1", title: "Action", bodyMd: "Body", status: "SUGGESTED" }]);
    const { prepareSlackMeetingActionReviewPost } = await import("./meeting-action-review");
    const result = await prepareSlackMeetingActionReviewPost(actor, { workspaceId: "ws-1", meetingId: "meeting-1" });
    expect(result).toMatchObject({ configured: true, skipped: false, lineageRoots: expect.arrayContaining([
      expect.objectContaining({ kind: "Meeting", id: "meeting-1" }),
      expect.objectContaining({ kind: "ArtifactInputSnapshot", id: "review-snapshot" }),
      expect.objectContaining({ kind: "MeetingInsight", id: "insight-1" }),
    ]) });
    expect(lineage.prepare).toHaveBeenCalledWith(expect.objectContaining({ tx: db, capture: {
      lineageRoots: expect.arrayContaining([
        expect.objectContaining({ kind: "MeetingTranscript", id: "meeting-1" }),
        expect.objectContaining({ kind: "MeetingTranscript", id: "next-meeting" }),
      ]),
    } }));
    expect(lineage.finish).toHaveBeenCalledWith(expect.objectContaining({ tx: db,
      artifact: { kind: "MeetingFollowUpReview", id: "review-1" }, content: expect.objectContaining({ expiresAt: nextMeeting.recordedAt }) }));
  });

  it("includes the stored review receipt in refreshed content", async () => {
    db.meetingInsight.findFirst.mockResolvedValue({ id: "insight-1", status: "APPLIED" });
    const result = await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(result.lineageRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Meeting", id: "meeting-1" }),
      expect.objectContaining({ kind: "MeetingFollowUpReview", id: "review-1" }),
    ]));
    expect(lineage.prepare).toHaveBeenCalledWith(expect.objectContaining({ tx: db,
      artifact: { kind: "MeetingFollowUpReview", id: "review-1" }, before: expect.anything(), allowSystemTransition: true }));
  });

});
