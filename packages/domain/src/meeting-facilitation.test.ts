import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, defaultModelGatewayMock, sendSlackMessageMock, extractMeetingInsightsMock } = vi.hoisted(() => ({
  prismaMock: {
    communicationExternalUser: { findMany: vi.fn() },
    communicationInstallation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    workflowJob: { upsert: vi.fn() },
    meeting: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    member: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    meetingInsight: { findMany: vi.fn() },
  },
  defaultModelGatewayMock: {
    extract: vi.fn(),
  },
  sendSlackMessageMock: vi.fn(),
  extractMeetingInsightsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: defaultModelGatewayMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("./communication", () => ({
  sendSlackMessage: sendSlackMessageMock,
}));

vi.mock("./meeting-intelligence", () => ({
  extractMeetingInsights: extractMeetingInsightsMock,
}));

describe("meeting facilitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "slack-1",
      settings: {
        defaultAgendaChannelId: "C123",
        agendaTimezone: "UTC",
      },
    });
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
  });

  it("builds agenda context from published attendee-scoped work", async () => {
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      seriesId: "series-1",
      participantIds: ["member-1"],
      participantEmails: ["jan@example.com"],
      recordedAt: new Date("2026-04-30T17:00:00.000Z"),
      archivedAt: null,
      series: null,
    };
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce(meeting)
      .mockResolvedValueOnce({ id: "previous-meeting" });
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        user: { displayName: "Jan", email: "jan@example.com" },
        roleAssignments: [
          { role: { circleId: "circle-1", circle: { name: "Ops" } } },
        ],
      },
    ]);
    prismaMock.tension.findMany.mockResolvedValue([
      {
        id: "tension-1",
        title: "Clarify discount authority",
        priority: 3,
        upvotes: [{ id: "vote-1" }],
        circle: { name: "Ops" },
        assigneeMember: null,
        raisedByMember: { user: { displayName: "Jan", email: "jan@example.com" } },
      },
    ]);
    prismaMock.action.findMany.mockResolvedValue([
      {
        id: "action-1",
        title: "Draft policy",
        status: "OPEN",
        dueAt: null,
        circle: { name: "Ops" },
        assigneeMember: { user: { displayName: "Jan", email: "jan@example.com" } },
      },
    ]);
    prismaMock.meetingInsight.findMany.mockResolvedValue([
      {
        id: "follow-up-1",
        title: "Review prior decision",
        bodyMd: "Bring back to next meeting.",
        assigneeHint: "Jan",
      },
    ]);

    const { buildMeetingAgendaContext } = await import("./meeting-facilitation");
    await expect(buildMeetingAgendaContext("workspace-1", "meeting-1")).resolves.toMatchObject({
      attendees: [{ memberId: "member-1", name: "Jan" }],
      tensions: [{ id: "tension-1", upvotes: 1 }],
      actions: [{ id: "action-1" }],
      followUps: [{ id: "follow-up-1" }],
    });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: { not: null },
      }),
    }));
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN", "IN_PROGRESS"] },
        isPrivate: false,
        publishedAt: { not: null },
      }),
    }));
  });

  it("posts meeting summaries as replies to agenda threads once", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      summaryMd: "Summary text",
      agendaChannelId: "C123",
      agendaMessageTs: "1710000000.000100",
      summaryPostedAt: null,
    });
    prismaMock.meetingInsight.findMany.mockResolvedValue([
      { type: "DECISION", title: "Decision made", bodyMd: "Decision body" },
      { type: "ACTION_ITEM", title: "Do the thing", bodyMd: "Action body" },
    ]);
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1710000001.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { postMeetingSummaryToAgendaThread } = await import("./meeting-facilitation");
    await expect(postMeetingSummaryToAgendaThread({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toEqual({ posted: true });

    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      threadTs: "1710000000.000100",
    }, expect.any(Array));
    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: { summaryPostedAt: expect.any(Date) },
    });
  });
});
