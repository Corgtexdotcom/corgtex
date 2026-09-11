import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, createAction, publishAction, requireWorkspaceMembership } = vi.hoisted(() => ({
  db: {
    member: { findMany: vi.fn() },
    meetingFollowUpReview: { findFirst: vi.fn(), update: vi.fn() },
    meetingInsight: { findFirst: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    workspaceFeatureFlag: { findUnique: vi.fn() },
    communicationMessage: { findUnique: vi.fn() },
    communicationEntityLink: { create: vi.fn() },
  },
  createAction: vi.fn(),
  publishAction: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: db, env: { APP_URL: "https://example.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./actions", () => ({ createAction, publishAction }));
vi.mock("./auth", () => ({ requireWorkspaceMembership }));

import { confirmSlackMeetingActionReviewProposal } from "./meeting-action-review";
import { humanMemberIdentityWhere, isHumanMemberIdentity } from "./member-identity";

const actor = { kind: "user" as const, user: { id: "user-1", email: "reviewer@example.test", displayName: "Reviewer" } };
const params = { workspaceId: "ws-1", installationId: "installation-1", externalUserId: "slack-user", reviewId: "review-1", insightId: "insight-1" };

describe("Slack meeting action assignee eligibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    db.meetingInsight.count.mockResolvedValue(0);
    db.communicationMessage.findUnique.mockResolvedValue(null);
    createAction.mockResolvedValue({ id: "action-1" });
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

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(db.member.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", isActive: true, ...humanMemberIdentityWhere() }, include: { user: true } });
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({ workspaceId: "ws-1", assigneeMemberId: "active" }));
    expect(publishAction).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "action-1" });
    expect(db.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED", reviewedByUserId: "user-1" }) }));
  });

  it("leaves an inactive-only hint unassigned", async () => {
    db.member.findMany.mockImplementation(async ({ where }) => where.isActive === true ? [] : [{ id: "old", user: { displayName: "Milan", email: "old@example.test" } }]);
    await confirmSlackMeetingActionReviewProposal(actor, params);
    expect(createAction).toHaveBeenCalledWith(actor, expect.objectContaining({ assigneeMemberId: null }));
  });
});
