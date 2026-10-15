import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  defaultModelGatewayMock,
  sendSlackMessageMock,
  updateSlackMessageMock,
  validateSlackPostTargetMock,
  fetchSlackThreadMessagesMock,
  extractMeetingInsightsMock,
  ensureMeetingSeriesOccurrencesMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    workspaceFeatureFlag: { findUnique: vi.fn() },
    communicationExternalUser: { findMany: vi.fn() },
    communicationChannel: { findFirst: vi.fn() },
    communicationInstallation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    communicationMessage: { upsert: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    communicationEntityLink: { create: vi.fn() },
    workflowJob: { findFirst: vi.fn(), upsert: vi.fn() },
    meetingFollowUpReview: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    meeting: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    member: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    proposal: { findMany: vi.fn() },
    meetingInsight: { findMany: vi.fn() },
    knowledgeChunk: { findMany: vi.fn() },
    deliberationEntry: { findMany: vi.fn() },
  },
  defaultModelGatewayMock: {
    extract: vi.fn(),
  },
  sendSlackMessageMock: vi.fn(),
  updateSlackMessageMock: vi.fn(),
  validateSlackPostTargetMock: vi.fn(),
  fetchSlackThreadMessagesMock: vi.fn(),
  extractMeetingInsightsMock: vi.fn(),
  ensureMeetingSeriesOccurrencesMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
  env: { APP_URL: "https://app.example.test" },
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: defaultModelGatewayMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn(),
}));

const receiptMocks = vi.hoisted(() => ({ capture: vi.fn(), snapshot: vi.fn(), public: vi.fn(), readable: vi.fn(), prepare: vi.fn(), finish: vi.fn() }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: receiptMocks.prepare, finishProducerLineage: receiptMocks.finish }));
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: receiptMocks.capture,
  captureArtifactInputSnapshotProof: receiptMocks.snapshot,
  isArtifactInputProofReadable: receiptMocks.readable,
  isArtifactInputProofPubliclyShareable: receiptMocks.public,
  lineageContentFingerprint: vi.fn((_kind, row) => row?.stateHash ?? "fingerprint"),
  recordArtifactInputLineage: vi.fn(),
  readableArtifactIds: vi.fn(async (_actor: unknown, _workspaceId: string, _kind: string,
    rows: Array<{ id: string }>) => new Set(rows.map((row) => row.id))),
}));

// Provider/transaction fencing has its own real PostgreSQL integration coverage.
// Keep this orchestration fixture on the same explicit readable-proof boundary.
vi.mock("./artifact-commit-preflight", () => ({
  prepareArtifactCommitPreflight: vi.fn(async () => ({})),
  withArtifactCommitPreflight: async (_actor: unknown, _ws: string, _tx: unknown, _roots: unknown, _token: unknown, work: () => Promise<unknown>) => {
    if (!await receiptMocks.readable()) throw new Error("Fixture inputs changed.");
    return work();
  },
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

vi.mock("./meetings", () => ({
  ensureMeetingSeriesOccurrences: ensureMeetingSeriesOccurrencesMock,
}));

describe("meeting facilitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    receiptMocks.capture.mockReset().mockImplementation(async (_actor, _workspace, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "fingerprint" })));
    receiptMocks.snapshot.mockReset().mockResolvedValue([{ kind: "ArtifactInputSnapshot", id: "prior-agenda", fingerprint: "fingerprint" }]);
    receiptMocks.readable.mockReset().mockResolvedValue(true);
    receiptMocks.public.mockReset().mockResolvedValue(true);
    prismaMock.communicationChannel.findFirst.mockReset().mockResolvedValue({ id: "channel-1", externalChannelId: "C123", kind: "PUBLIC" });
    receiptMocks.prepare.mockReset().mockImplementation(async ({ capture }) => ({ mode: "DERIVED", inputs: [], roots: capture?.lineageRoots ?? [] }));
    receiptMocks.finish.mockReset().mockResolvedValue(undefined);
    prismaMock.meeting.findFirst.mockReset().mockResolvedValue({ id: "meeting-1", workspaceId: "workspace-1" });
    prismaMock.communicationMessage.findMany.mockReset().mockResolvedValue([]);
    prismaMock.meeting.findMany.mockReset().mockResolvedValue([]);
    prismaMock.workspaceFeatureFlag.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.member.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationExternalUser.findMany.mockReset().mockResolvedValue([]);
    prismaMock.tension.findMany.mockReset().mockResolvedValue([]);
    prismaMock.action.findMany.mockReset().mockResolvedValue([]);
    prismaMock.proposal.findMany.mockReset().mockResolvedValue([]);
    prismaMock.meetingInsight.findMany.mockReset().mockResolvedValue([]);
    prismaMock.knowledgeChunk.findMany.mockReset().mockResolvedValue([]);
    prismaMock.deliberationEntry.findMany.mockReset().mockResolvedValue([]);
    prismaMock.meetingFollowUpReview.findFirst.mockReset().mockResolvedValue({ id: "review-1", workspaceId: "workspace-1", meetingId: "meeting-1", installationId: "slack-1", channelId: "C999" });
    prismaMock.meetingFollowUpReview.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.meetingFollowUpReview.upsert.mockReset().mockResolvedValue({ id: "review-1" });
    prismaMock.meetingFollowUpReview.update.mockReset().mockResolvedValue({ id: "review-1" });
    prismaMock.communicationMessage.upsert.mockReset().mockResolvedValue({ id: "message-1" });
    prismaMock.communicationMessage.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.communicationEntityLink.create.mockReset().mockResolvedValue({ id: "link-1" });
    prismaMock.$transaction.mockImplementation(async (operations: unknown) => typeof operations === "function"
      ? operations(prismaMock) : Promise.all(operations as unknown[]));
    defaultModelGatewayMock.extract.mockReset();
    sendSlackMessageMock.mockReset();
    updateSlackMessageMock.mockReset();
    prismaMock.communicationInstallation.findFirst.mockResolvedValue({
      id: "slack-1",
      settings: {
        defaultAgendaChannelId: "C123",
        agendaTimezone: "UTC",
      },
    });
    prismaMock.workflowJob.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    validateSlackPostTargetMock.mockReset();
    validateSlackPostTargetMock.mockResolvedValue({
      ok: true,
      channelId: "C123",
      channelName: "agenda",
    });
    fetchSlackThreadMessagesMock.mockReset();
    fetchSlackThreadMessagesMock.mockResolvedValue([]);
    ensureMeetingSeriesOccurrencesMock.mockReset().mockResolvedValue({ meetingCount: 0, createdCount: 0 });
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
    expect(ensureMeetingSeriesOccurrencesMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      from: expect.any(Date),
      to: expect.any(Date),
      reason: "meeting-agenda-preparation",
    });
    expect(prismaMock.meeting.findMany).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("reposts an existing agenda without regenerating when Slack metadata is missing", async () => {
    const existingAgenda = {
      templateKey: "regular_update_v1",
      version: 1,
      generationMode: "deterministic",
      title: "Weekly update",
      generatedAt: "2026-06-22T17:00:00.000Z",
      participantOrder: [],
      sections: [],
    };
    prismaMock.meeting.findMany
      .mockResolvedValueOnce([
        {
          id: "meeting-1",
          workspaceId: "workspace-1",
          title: "Weekly update",
          status: "SCHEDULED",
          recordedAt: new Date("2026-06-23T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
          agendaJson: existingAgenda,
          agendaChannelId: null,
          agendaMessageTs: null,
          agendaPostedAt: null,
          seriesId: "series-1",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
      ])
      .mockResolvedValue([]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      status: "SCHEDULED",
      title: "Weekly update",
      source: "internal",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: existingAgenda,
      ingestionGuidanceMd: null,
      seriesId: "series-1",
      participantIds: [],
      participantEmails: [],
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      archivedAt: null,
      series: { title: "Weekly update", recurrenceRule: "FREQ=WEEKLY" },
    });
    sendSlackMessageMock.mockResolvedValue({ ok: true, channel: "C123", ts: "1710000001.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { runMeetingAgendaPreparation } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaPreparation({
      workspaceId: "workspace-1",
      targetDateISO: "2026-06-23",
    })).resolves.toMatchObject({
      posted: 1,
      meetingIds: ["meeting-1"],
    });

    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(ensureMeetingSeriesOccurrencesMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      from: new Date("2026-06-23T00:00:00.000Z"),
      to: new Date("2026-06-24T00:00:00.000Z"),
      reason: "meeting-agenda-preparation",
    });
    expect(ensureMeetingSeriesOccurrencesMock.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.meeting.findMany.mock.invocationCallOrder[0],
    );
    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: {
        agendaChannelId: "C123",
        agendaMessageTs: "1710000001.000100",
        agendaPostedAt: expect.any(Date),
      },
    });
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalled();
  });

  it("reports degraded agenda readiness when the next regular call has no agenda or pending job", async () => {
    prismaMock.meeting.findMany
      .mockResolvedValueOnce([
        {
          id: "meeting-1",
          workspaceId: "workspace-1",
          title: "Weekly update",
          status: "SCHEDULED",
          recordedAt: new Date("2026-06-23T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
          agendaJson: null,
          agendaChannelId: null,
          agendaMessageTs: null,
          agendaPostedAt: null,
          seriesId: "series-1",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
      ]);
    prismaMock.workflowJob.findFirst.mockResolvedValue(null);

    const { getMeetingAgendaReadiness } = await import("./meeting-facilitation");
    await expect(getMeetingAgendaReadiness("workspace-1", new Date("2026-06-22T18:00:00.000Z"))).resolves.toMatchObject({
      status: "degraded",
      ready: false,
      configured: true,
      failedChecks: [
        expect.objectContaining({
          key: "next_agenda",
        }),
      ],
    });
  });

  it("processes remaining agenda meetings and schedules the next scan when one post fails", async () => {
    const existingAgenda = {
      templateKey: "regular_update_v1",
      version: 1,
      generationMode: "deterministic",
      title: "Weekly update",
      generatedAt: "2026-06-22T17:00:00.000Z",
      participantOrder: [],
      sections: [],
    };
    prismaMock.meeting.findMany
      .mockResolvedValueOnce([
        {
          id: "meeting-fails",
          workspaceId: "workspace-1",
          title: "Weekly update",
          status: "SCHEDULED",
          recordedAt: new Date("2026-06-23T17:00:00.000Z"),
          scheduledEndAt: null,
          agendaJson: existingAgenda,
          agendaChannelId: null,
          agendaMessageTs: null,
          agendaPostedAt: null,
          seriesId: "series-1",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
        {
          id: "meeting-posts",
          workspaceId: "workspace-1",
          title: "Leadership sync",
          status: "SCHEDULED",
          recordedAt: new Date("2026-06-23T19:00:00.000Z"),
          scheduledEndAt: null,
          agendaJson: existingAgenda,
          agendaChannelId: null,
          agendaMessageTs: null,
          agendaPostedAt: null,
          seriesId: "series-2",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
      ])
      .mockResolvedValue([]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-context",
      workspaceId: "workspace-1",
      status: "SCHEDULED",
      title: "Weekly update",
      source: "internal",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: existingAgenda,
      ingestionGuidanceMd: null,
      seriesId: "series-1",
      participantIds: [],
      participantEmails: [],
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: null,
      archivedAt: null,
      series: { title: "Weekly update", recurrenceRule: "FREQ=WEEKLY" },
    });
    sendSlackMessageMock
      .mockRejectedValueOnce(new Error("Slack post failed"))
      .mockResolvedValueOnce({ ok: true, channel: "C123", ts: "1710000002.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-posts" });

    const { runMeetingAgendaPreparation } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaPreparation({
      workspaceId: "workspace-1",
      targetDateISO: "2026-06-23",
    })).rejects.toMatchObject({
      code: "MEETING_AGENDA_PREPARATION_PARTIAL_FAILURE",
    });

    expect(sendSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-posts" },
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalled();
  });

  it("persists a deterministic agenda before Slack delivery failure", async () => {
    prismaMock.meeting.findMany
      .mockResolvedValueOnce([
        {
          id: "meeting-fails",
          workspaceId: "workspace-1",
          title: "Weekly update",
          status: "SCHEDULED",
          recordedAt: new Date("2026-06-23T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
          agendaJson: null,
          agendaChannelId: null,
          agendaMessageTs: null,
          agendaPostedAt: null,
          seriesId: "series-1",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
      ])
      .mockResolvedValue([]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-fails",
      workspaceId: "workspace-1",
      status: "SCHEDULED",
      title: "Weekly update",
      source: "internal",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: null,
      ingestionGuidanceMd: null,
      seriesId: "series-1",
      participantIds: [],
      participantEmails: [],
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      archivedAt: null,
      series: { title: "Weekly update", recurrenceRule: "FREQ=WEEKLY" },
    });
    sendSlackMessageMock.mockRejectedValueOnce(new Error("Slack post failed"));
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-fails" });

    const { runMeetingAgendaPreparation } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaPreparation({
      workspaceId: "workspace-1",
      targetDateISO: "2026-06-23",
    })).rejects.toMatchObject({
      code: "MEETING_AGENDA_PREPARATION_PARTIAL_FAILURE",
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-fails" },
      data: { agendaJson: expect.objectContaining({ templateKey: "regular_update_v1" }) },
      select: expect.objectContaining({ agendaJson: true }),
    });
    expect(prismaMock.meeting.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agendaPostedAt: expect.any(Date) }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalled();
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
    prismaMock.meeting.findFirst.mockResolvedValueOnce(meeting);
    prismaMock.meeting.findMany.mockResolvedValueOnce([
      {
        id: "previous-meeting",
        title: "Weekly Tactical",
        recordedAt: new Date("2026-04-23T17:00:00.000Z"),
        summaryMd: "Previous summary",
        decisionsJson: { items: [] },
      },
    ]);
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
        type: "FOLLOW_UP",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Review prior decision",
        meetingId: "previous-meeting",
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
        status: { in: ["OPEN"] },
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
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ recordedAt: "desc" }, { id: "asc" }],
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
      { id: "insight-decision", type: "DECISION", title: "Decision made", bodyMd: "Decision body" },
      { id: "insight-action", type: "ACTION_ITEM", title: "Do the thing", bodyMd: "Action body" },
    ]);
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1710000001.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { postMeetingSummaryToAgendaThread } = await import("./meeting-facilitation");
    await expect(postMeetingSummaryToAgendaThread({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toEqual({ posted: true });

    expect(receiptMocks.capture).toHaveBeenCalledWith(expect.anything(), "workspace-1", [
      expect.objectContaining({ kind: "Meeting", id: "meeting-1", snapshot: expect.objectContaining({ summaryMd: "Summary text" }) }),
      expect.objectContaining({ kind: "MeetingInsight", id: "insight-decision" }),
      expect.objectContaining({ kind: "MeetingInsight", id: "insight-action" }),
    ]);
    expect(receiptMocks.public).toHaveBeenCalledWith(expect.anything(), "workspace-1", expect.arrayContaining([
      expect.objectContaining({ kind: "Meeting", id: "meeting-1" }),
      expect.objectContaining({ kind: "MeetingInsight", id: "insight-decision" }),
      expect.objectContaining({ kind: "MeetingInsight", id: "insight-action" }),
      expect.objectContaining({ kind: "CommunicationChannel", id: "channel-1" }),
    ]));
    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      threadTs: "1710000000.000100",
    }, expect.any(Array));
    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: { summaryPostedAt: expect.any(Date) },
      });
  });

  it.each(["unknown", "restricted", "destination"])("withholds summary publication for %s inputs", async (failure) => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1", workspaceId: "workspace-1", title: "Weekly Tactical", summaryMd: "Summary text",
      agendaChannelId: "C123", agendaMessageTs: "1710000000.000100", summaryPostedAt: null,
    });
    prismaMock.meetingInsight.findMany.mockResolvedValue([
      { id: "insight-1", type: "DECISION", title: "Decision", bodyMd: "Decision body" },
    ]);
    if (failure === "unknown") {
      const { AppError } = await import("./errors");
      receiptMocks.capture.mockRejectedValueOnce(new AppError(403, "UNKNOWN_LINEAGE", "Unknown inputs"));
    }
    if (failure === "restricted") receiptMocks.public.mockResolvedValue(false);
    if (failure === "destination") prismaMock.communicationChannel.findFirst.mockResolvedValue(null);
    const { postMeetingSummaryToAgendaThread } = await import("./meeting-facilitation");
    await expect(postMeetingSummaryToAgendaThread({ workspaceId: "workspace-1", meetingId: "meeting-1" }))
      .resolves.toEqual({ skipped: true, reason: "summary_inputs_unavailable" });
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
  });

  it("prepares deterministic regular update agendas for recurring meetings without model extraction", async () => {
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "meeting-1",
      workspaceId: "workspace-1",
      status: "SCHEDULED",
      title: "Weekly update",
      source: "internal",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: null,
      ingestionGuidanceMd: null,
      seriesId: "series-1",
      participantIds: ["user-1"],
      participantEmails: ["jan@example.com"],
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      archivedAt: null,
      series: { title: "Weekly update", recurrenceRule: "FREQ=WEEKLY" },
    });
    prismaMock.meeting.findMany.mockResolvedValueOnce([
      {
        id: "previous-meeting",
        title: "Weekly update",
        recordedAt: new Date("2026-06-16T17:00:00.000Z"),
        summaryMd: "Previous summary",
        decisionsJson: { items: [{ title: "Decision made", bodyMd: "Decision details." }] },
      },
    ]);
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
        status: "OPEN",
        priority: 3,
        bodyMd: "Tension body.",
        upvotes: [],
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
        dueAt: new Date("2026-06-22T12:00:00.000Z"),
        bodyMd: "Action body.",
        circle: { name: "Ops" },
        assigneeMember: { user: { displayName: "Jan", email: "jan@example.com" } },
      },
    ]);
    prismaMock.proposal.findMany.mockResolvedValue([
      {
        id: "proposal-1",
        title: "Pricing proposal",
        status: "OPEN",
        summary: "Proposal summary.",
        bodyMd: "Proposal body.",
        circle: { name: "Ops" },
        author: { displayName: "Jan", email: "jan@example.com" },
        tensions: [],
        actions: [],
      },
    ]);
    prismaMock.meetingInsight.findMany.mockResolvedValue([
      {
        id: "follow-up-1",
        meetingId: "previous-meeting",
        type: "FOLLOW_UP",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Review prior decision",
        bodyMd: "Bring back to next meeting.",
        assigneeHint: "Jan",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: null,
        appliedEntityId: null,
      },
      {
        id: "created-action",
        meetingId: "previous-meeting",
        type: "ACTION_ITEM",
        operation: "CREATE",
        status: "APPLIED",
        title: "Draft policy",
        bodyMd: "Action body.",
        assigneeHint: "Jan",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: "Action",
        appliedEntityId: "action-1",
      },
      {
        id: "resolved-tension",
        meetingId: "previous-meeting",
        type: "TENSION",
        operation: "RESOLVE",
        status: "APPLIED",
        title: "Resolved old tension",
        bodyMd: "Resolved in prior meeting.",
        assigneeHint: null,
        targetEntityType: "Tension",
        targetEntityId: "old-tension",
        appliedEntityType: "Tension",
        appliedEntityId: "old-tension",
      },
    ]);
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { prepareAgendaForMeeting } = await import("./meeting-facilitation");
    const result = await prepareAgendaForMeeting({ workspaceId: "workspace-1", meetingId: "meeting-1" });

    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(result.agenda).toMatchObject({
      templateKey: "regular_update_v1",
      generationMode: "deterministic",
      sections: [
        expect.objectContaining({ key: "check_in" }),
        expect.objectContaining({ key: "last_meeting_recap" }),
        expect.objectContaining({ key: "circle_updates" }),
        expect.objectContaining({ key: "work_queue" }),
        expect.objectContaining({ key: "checkout" }),
      ],
    });
    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: { agendaJson: expect.objectContaining({ templateKey: "regular_update_v1" }) },
      select: expect.objectContaining({ agendaJson: true }),
    });
  });

  it("persists a baseline agenda when model generation fails", async () => {
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "meeting-1",
      workspaceId: "workspace-1",
      status: "SCHEDULED",
      title: "Planning session",
      source: "internal",
      transcript: null,
      summaryMd: null,
      blocksJson: null,
      agendaJson: null,
      ingestionGuidanceMd: null,
      seriesId: null,
      participantIds: [],
      participantEmails: [],
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      archivedAt: null,
      series: null,
    });
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.member.findMany.mockResolvedValue([]);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.meetingInsight.findMany.mockResolvedValue([]);
    prismaMock.deliberationEntry.findMany.mockResolvedValue([]);
    defaultModelGatewayMock.extract.mockRejectedValueOnce(new Error("model unavailable"));
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { prepareAgendaForMeeting } = await import("./meeting-facilitation");
    await expect(prepareAgendaForMeeting({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toMatchObject({
      fallbackReason: "model_generation_failed",
      agenda: {
        title: "Planning session",
        sections: expect.any(Array),
      },
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: {
        agendaJson: expect.objectContaining({
          title: "Planning session",
        }),
      },
      select: expect.objectContaining({ agendaJson: true }),
    });
  });

  it("rechecks complete public proof before configured review overflow messages", async () => {
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true,
      config: { meetingSeriesExternalId: "series", channelId: "C999" } });
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "meeting-1", workspaceId: "workspace-1", title: "Review", summaryMd: "content ".repeat(25000),
      recordedAt: new Date(), summaryPostedAt: null, seriesId: null, series: { externalId: "series" },
    });
    let destinationChecks = 0;
    receiptMocks.public.mockImplementation(async (_actor, _ws, roots) => {
      if (roots.some((root: { kind: string }) => root.kind === "CommunicationChannel")) {
        destinationChecks += 1;
        return destinationChecks === 1;
      }
      return true;
    });
    sendSlackMessageMock.mockResolvedValue({ ts: "123.456" });
    const { postMeetingSummaryToAgendaThread } = await import("./meeting-facilitation");
    await expect(postMeetingSummaryToAgendaThread({ workspaceId: "workspace-1", meetingId: "meeting-1" }))
      .rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(sendSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(destinationChecks).toBe(2);
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
  });

  it("posts configured customer meeting reviews with summary context and action proposals", async () => {
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({
      enabled: true,
      config: {
        meetingSeriesExternalId: "ops:weekly-progress-review",
        channelId: "C999",
        maxProposals: 5,
        expiresAfterHours: 48,
        timezone: "America/Los_Angeles",
      },
    });
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({
        id: "meeting-1",
        workspaceId: "workspace-1",
        title: "Customer weekly progress review",
        summaryMd: "Full generated summary for the customer meeting.",
        summaryPostedAt: null,
        recordedAt: new Date("2026-05-20T16:00:00.000Z"),
        seriesId: "series-1",
        series: { externalId: "ops:weekly-progress-review" },
      })
      .mockResolvedValueOnce(null);
    prismaMock.meetingInsight.findMany.mockResolvedValue([
      {
        id: "insight-1",
        title: "Milan to confirm rollout channel",
        bodyMd: "Milan will confirm the approved Slack channel before rollout.",
        assigneeHint: "Milan",
        dueAt: new Date("2026-05-22T12:00:00.000Z"),
        confidence: 0.91,
        sourceQuote: "Milan will confirm the channel.",
        status: "SUGGESTED",
        appliedEntityId: null,
      },
    ]);
    sendSlackMessageMock.mockResolvedValue({ ok: true, ts: "1710000001.000100" });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1" });

    const { postMeetingSummaryToAgendaThread } = await import("./meeting-facilitation");
    await expect(postMeetingSummaryToAgendaThread({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toEqual({ posted: true, mode: "slack_meeting_action_review" });

    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C999",
      threadTs: undefined,
    }, expect.any(Array));
    const postedBlocks = JSON.stringify(sendSlackMessageMock.mock.calls[0]?.[2]);
    expect(postedBlocks).toContain("Full generated summary for the customer meeting.");
    expect(postedBlocks).toContain("Milan to confirm rollout channel");
    expect(prismaMock.meetingFollowUpReview.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        channelId: "C999",
        status: "OPEN",
      }),
    }));
    expect(prismaMock.communicationEntityLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Meeting",
        entityId: "meeting-1",
        action: "meeting_follow_up_review_posted",
      }),
    }));
    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: { id: "meeting-1" },
      data: { summaryPostedAt: expect.any(Date) },
    });
  });

  it("does not mutate regular update agendas from Slack thread edit requests", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "jan@example.com",
      displayName: "Jan",
      globalRole: "USER",
    });
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "meeting-1",
      title: "Weekly update",
      recordedAt: new Date("2026-06-23T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-23T18:00:00.000Z"),
      agendaJson: {
        templateKey: "regular_update_v1",
        version: 1,
        generationMode: "deterministic",
        title: "Weekly update",
        generatedAt: "2026-06-22T17:00:00.000Z",
        sections: [],
      },
      agendaChannelId: "C123",
      agendaMessageTs: "1710000000.000100",
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
      messageText: "add one item",
      workflowJobId: "job-1",
    })).resolves.toEqual({
      edited: false,
      reason: "read_only_regular_agenda",
    });

    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(updateSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).toHaveBeenCalledWith("slack-1", {
      channel: "C123",
      threadTs: "1710000000.000100",
    }, expect.any(Array));
  });

  it("edits agenda thread parent messages from concrete Slack requests", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValue([{ id: "stored-request", externalMessageId: "1710000001.000100", threadExternalId: "1710000000.000100", text: "add Bob's detail to action item 1" }]);
    fetchSlackThreadMessagesMock.mockResolvedValue([{ ts: "1710000000.000100", threadTs: "1710000000.000100", user: "bot", text: "Unpersisted bot agenda copy" }]);
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

    expect(JSON.parse(defaultModelGatewayMock.extract.mock.calls[0][0].input).threadMessages).toEqual([]);
    expect(receiptMocks.capture.mock.invocationCallOrder[0]).toBeLessThan(defaultModelGatewayMock.extract.mock.invocationCallOrder[0]);
    expect(receiptMocks.finish.mock.invocationCallOrder[0]).toBeLessThan(updateSlackMessageMock.mock.invocationCallOrder[0]);
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
    prismaMock.communicationMessage.findMany.mockResolvedValue([{ id: "stored-request", externalMessageId: "1710000001.000100", threadExternalId: "1710000000.000100", text: 'make it better' }]);
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
        scheduledEndAt: null,
        agendaJson: {
          title: "Weekly Tactical",
          sections: [{ title: "Check-in", items: [{ text: "Round" }] }],
        },
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
  function provenAgendaMeeting() {
    return { id: "meeting-1", workspaceId: "workspace-1", status: "SCHEDULED", title: "Planning",
      source: "internal", transcript: null, summaryMd: null, blocksJson: null, agendaJson: null,
      ingestionGuidanceMd: null, seriesId: null, series: null, participantIds: [], participantEmails: [],
      recordedAt: new Date("2026-06-23T17:00:00Z"), scheduledEndAt: null, archivedAt: null };
  }

  it("does not generate or persist an agenda without a current complete context receipt", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue(provenAgendaMeeting());
    receiptMocks.readable.mockResolvedValue(false);
    const { prepareAgendaForMeeting } = await import("./meeting-facilitation");
    await expect(prepareAgendaForMeeting({ workspaceId: "workspace-1", meetingId: "meeting-1" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a meeting changed during model generation before writing its agenda", async () => {
    prismaMock.meeting.findFirst.mockResolvedValueOnce({ ...provenAgendaMeeting(), stateHash: "before" })
      .mockResolvedValue({ ...provenAgendaMeeting(), stateHash: "after" });
    defaultModelGatewayMock.extract.mockResolvedValue({ output: { title: "Planning", sections: [] } });
    const { prepareAgendaForMeeting } = await import("./meeting-facilitation");
    await expect(prepareAgendaForMeeting({ workspaceId: "workspace-1", meetingId: "meeting-1" }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(defaultModelGatewayMock.extract).toHaveBeenCalledOnce();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(receiptMocks.finish).not.toHaveBeenCalled();
  });

  it("records the complete agenda receipt atomically and omits receipt internals from model input", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue(provenAgendaMeeting());
    prismaMock.meeting.update.mockResolvedValue({ ...provenAgendaMeeting(), agendaJson: { title: "Planning" } });
    defaultModelGatewayMock.extract.mockResolvedValue({ output: { title: "Planning", sections: [] } });
    const { prepareAgendaForMeeting } = await import("./meeting-facilitation");
    await prepareAgendaForMeeting({ workspaceId: "workspace-1", meetingId: "meeting-1" });
    const input = JSON.parse(defaultModelGatewayMock.extract.mock.calls[0][0].input);
    expect(input).not.toHaveProperty("lineageRoots");
    expect(input).not.toHaveProperty("sourceStateHash");
    expect(receiptMocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock, capture: { lineageRoots: expect.arrayContaining([expect.objectContaining({ kind: "MeetingTranscript", id: "meeting-1" })]) },
    }));
    expect(receiptMocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock, artifact: { kind: "MeetingAgenda", id: "meeting-1" },
      receipt: expect.objectContaining({ mode: "DERIVED" }),
    }));
  });

  it("rejects unreceipted Slack edit text before model invocation or publication", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-1", email: "jan@example.com", displayName: "Jan", globalRole: "USER" });
    prismaMock.meeting.findFirst.mockResolvedValue({ ...provenAgendaMeeting(),
      agendaJson: { title: "Planning", sections: [{ title: "Discussion", items: [{ text: "Plan" }] }] },
      agendaChannelId: "C123", agendaMessageTs: "1710000000.000100",
    });
    const { runMeetingAgendaThreadEdit } = await import("./meeting-facilitation");
    await expect(runMeetingAgendaThreadEdit({ workspaceId: "workspace-1", meetingId: "meeting-1", actorUserId: "user-1",
      installationId: "slack-1", channelId: "C123", threadTs: "1710000000.000100", messageTs: "1710000001.000100", messageText: "Secret edit" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(defaultModelGatewayMock.extract).not.toHaveBeenCalled();
    expect(updateSlackMessageMock).not.toHaveBeenCalled();
    expect(sendSlackMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
  });

});
