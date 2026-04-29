import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  defaultModelGatewayMock,
  sendSlackMessageMock,
  updateSlackMessageMock,
  validateSlackPostTargetMock,
  fetchSlackThreadMessagesMock,
  extractMeetingInsightsMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    auditLog: { create: vi.fn() },
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
    user: { findUnique: vi.fn() },
    member: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    meetingInsight: { findMany: vi.fn() },
  },
  defaultModelGatewayMock: {
    extract: vi.fn(),
  },
  sendSlackMessageMock: vi.fn(),
  updateSlackMessageMock: vi.fn(),
  validateSlackPostTargetMock: vi.fn(),
  fetchSlackThreadMessagesMock: vi.fn(),
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
  updateSlackMessage: updateSlackMessageMock,
  validateSlackPostTarget: validateSlackPostTargetMock,
  fetchSlackThreadMessages: fetchSlackThreadMessagesMock,
}));

vi.mock("./meeting-intelligence", () => ({
  extractMeetingInsights: extractMeetingInsightsMock,
}));

describe("meeting facilitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "slack-1",
      settings: {
        defaultAgendaChannelId: "C123",
        agendaTimezone: "UTC",
      },
    });
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    validateSlackPostTargetMock.mockResolvedValue({
      ok: true,
      channelId: "C123",
      channelName: "agenda",
    });
    fetchSlackThreadMessagesMock.mockResolvedValue([]);
  });

  it("validates and stores Slack agenda channel metadata", async () => {
    prismaMock.communicationInstallation.update.mockResolvedValue({ id: "slack-1" });

    const { updateSlackAgendaSettings } = await import("./meeting-facilitation");
    await expect(updateSlackAgendaSettings({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      defaultAgendaChannelId: "C123",
      agendaTimezone: "America/Los_Angeles",
    })).resolves.toEqual({ id: "slack-1" });

    expect(validateSlackPostTargetMock).toHaveBeenCalledWith("slack-1", "C123");
    expect(prismaMock.communicationInstallation.update).toHaveBeenCalledWith({
      where: { id: "slack-1" },
      data: {
        settings: {
          defaultAgendaChannelId: "C123",
          defaultAgendaChannelName: "agenda",
          agendaTimezone: "America/Los_Angeles",
        },
      },
    });
  });

  it("rejects Slack agenda channels where Corgtex is not present", async () => {
    validateSlackPostTargetMock.mockResolvedValueOnce({
      ok: false,
      code: "SLACK_CHANNEL_NOT_JOINED",
      message: "Invite Corgtex to this channel first, then save agenda posting again.",
    });

    const { updateSlackAgendaSettings } = await import("./meeting-facilitation");
    await expect(updateSlackAgendaSettings({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      defaultAgendaChannelId: "C123",
      agendaTimezone: "UTC",
    })).rejects.toMatchObject({
      status: 400,
      code: "SLACK_CHANNEL_NOT_JOINED",
    });

    expect(prismaMock.communicationInstallation.update).not.toHaveBeenCalled();
  });

  it("skips agenda posting without regenerating when the saved Slack channel is invalid", async () => {
    validateSlackPostTargetMock.mockResolvedValueOnce({
      ok: false,
      code: "SLACK_CHANNEL_NOT_JOINED",
      message: "Invite Corgtex to this channel first, then save agenda posting again.",
    });

    const { runMeetingAgendaPreparation } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaPreparation({ workspaceId: "workspace-1" })).resolves.toEqual({
      skipped: true,
      reason: "SLACK_CHANNEL_NOT_JOINED",
    });

    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(prismaMock.meeting.findMany).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("builds agenda context from published attendee-scoped work", async () => {
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      seriesId: "series-1",
      participantIds: ["user-1"],
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
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { id: { in: ["user-1"] } },
          { userId: { in: ["user-1"] } },
          { user: { email: { in: ["jan@example.com"] } } },
        ]),
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

  it("edits agenda thread parent messages from concrete Slack requests", async () => {
    const currentAgenda = {
      title: "Weekly Tactical",
      intro: "Discuss current work.",
      sections: [
        {
          title: "Action items",
          items: [{ text: "Review launch plan", owner: "Jan" }],
        },
      ],
    };
    const updatedAgenda = {
      title: "Weekly Tactical",
      intro: "Discuss current work.",
      sections: [
        {
          title: "Action items",
          items: [{ text: "Review launch plan with Bob's rollout detail", owner: "Jan" }],
        },
      ],
    };
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "jan@example.com",
      displayName: "Jan",
      globalRole: "USER",
    });
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({
        id: "meeting-1",
        title: "Weekly Tactical",
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T17:30:00.000Z"),
        agendaJson: currentAgenda,
        agendaChannelId: "C123",
        agendaMessageTs: "1710000000.000100",
      })
      .mockResolvedValueOnce({
        id: "meeting-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        seriesId: "series-1",
        participantIds: ["user-1"],
        participantEmails: ["jan@example.com"],
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        archivedAt: null,
        series: null,
      })
      .mockResolvedValueOnce(null);
    prismaMock.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        user: { displayName: "Jan", email: "jan@example.com" },
        roleAssignments: [],
      },
    ]);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.meetingInsight.findMany.mockResolvedValue([]);
    prismaMock.communicationExternalUser.findMany.mockResolvedValue([]);
    defaultModelGatewayMock.extract.mockResolvedValue({
      output: {
        action: "update",
        changeSummary: "Added Bob's rollout detail to action items.",
        agenda: updatedAgenda,
      },
    });
    updateSlackMessageMock.mockResolvedValue({ ok: true });
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1710000002.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });

    const { runMeetingAgendaThreadEdit } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaThreadEdit({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      actorUserId: "user-1",
      installationId: "slack-1",
      channelId: "C123",
      threadTs: "1710000000.000100",
      messageTs: "1710000001.000100",
      messageText: "add Bob's detail to action item 1",
      workflowJobId: "job-1",
    })).resolves.toEqual({
      edited: true,
      changeSummary: "Added Bob's rollout detail to action items.",
    });

    expect(updateSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      ts: "1710000000.000100",
    }, expect.any(Array));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      threadTs: "1710000000.000100",
    }, expect.any(Array));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "meeting.agenda.edited",
        entityId: "meeting-1",
        actorUserId: "user-1",
      }),
    }));
  });

  it("asks for clarification without mutating ambiguous agenda edit requests", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "jan@example.com",
      displayName: "Jan",
      globalRole: "USER",
    });
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "meeting-1",
      title: "Weekly Tactical",
      recordedAt: new Date("2026-04-30T17:00:00.000Z"),
      scheduledEndAt: null,
      agendaJson: {
        title: "Weekly Tactical",
        sections: [{ title: "Check-in", items: [{ text: "Round" }] }],
      },
      agendaChannelId: "C123",
      agendaMessageTs: "1710000000.000100",
    });
    defaultModelGatewayMock.extract.mockResolvedValue({
      output: {
        action: "clarify",
        clarification: "Please tell me which agenda item to update.",
      },
    });
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1710000002.000100" });

    const { runMeetingAgendaThreadEdit } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaThreadEdit({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      actorUserId: "user-1",
      installationId: "slack-1",
      channelId: "C123",
      threadTs: "1710000000.000100",
      messageTs: "1710000001.000100",
      messageText: "make it better",
    })).resolves.toEqual({
      edited: false,
      reason: "clarification_requested",
    });

    expect(updateSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      threadTs: "1710000000.000100",
    }, expect.any(Array));
  });
});
