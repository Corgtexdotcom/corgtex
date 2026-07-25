import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    meeting: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    meetingSeries: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
    meetingInsight: {
      deleteMany: vi.fn(),
    },
    meetingTranscriptSourceRecord: {
      updateMany: vi.fn(),
    },
    meetingTranscriptProcessingProgress: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
    },
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return {
    prismaMock: prisma,
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

describe("meetings domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingTranscriptSourceRecord.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingTranscriptProcessingProgress.findUnique.mockResolvedValue(null);
    prismaMock.meetingTranscriptProcessingProgress.upsert.mockResolvedValue({ id: "progress-1" });
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.meetingSeries.findMany.mockResolvedValue([]);
    prismaMock.meetingSeries.findFirst.mockResolvedValue(null);
    prismaMock.meetingSeries.findUnique.mockResolvedValue(null);
    prismaMock.meetingSeries.update.mockResolvedValue({});
    prismaMock.meeting.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "operator-1",
      role: "ADMIN",
      isActive: true,
    });
  });

  it("listMeetings returns meetings newest first", async () => {
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);

    const { listMeetings } = await import("./meetings");
    await expect(listMeetings("workspace-1")).resolves.toEqual([{ id: "meeting-1" }]);
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", archivedAt: null },
      orderBy: { recordedAt: "desc" },
    });
  });

  it("listMeetings matches multiple members through participant ids and emails", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { id: "member-1", userId: "user-1", user: { id: "user-1", email: "one@example.test" } },
      { id: "member-2", userId: "user-2", user: { id: "user-2", email: "two@example.test" } },
    ]);
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);

    const { listMeetings } = await import("./meetings");
    await expect(listMeetings("workspace-1", { memberIds: ["member-1", "member-2", "member-1"] })).resolves.toEqual([{ id: "meeting-1" }]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["member-1", "member-2"] },
        workspaceId: "workspace-1",
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        OR: [
          { participantIds: { hasSome: ["member-1", "member-2", "user-1", "user-2"] } },
          { participantEmails: { hasSome: ["one@example.test", "two@example.test"] } },
        ],
        archivedAt: null,
      },
      orderBy: { recordedAt: "desc" },
    });
  });

  it("getMeeting returns a meeting with related records", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      insights: [
        {
          status: "APPLIED",
          type: "ACTION_ITEM",
          operation: "CREATE",
          appliedEntityType: "Action",
          appliedEntityId: "action-1",
        },
        {
          status: "APPLIED",
          type: "ACTION_ITEM",
          operation: "RESOLVE",
          appliedEntityType: "Action",
          appliedEntityId: "existing-action",
        },
      ],
    });
    prismaMock.action.findMany.mockResolvedValue([{ id: "action-1", title: "Follow up" }]);

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "meeting-1")).resolves.toEqual(expect.objectContaining({
      id: "meeting-1",
      raisedActions: [{ id: "action-1", title: "Follow up" }],
    }));
    expect(prismaMock.meeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        insights: {
          orderBy: [
            { sourceRecordedAt: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
          ],
        },
      }),
    }));
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        id: { in: ["action-1"] },
      }),
    }));
  });

  it("getMeeting returns null when not found", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue(null);

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "missing-meeting")).resolves.toBeNull();
    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
  });

  it("createMeeting creates a meeting and event", async () => {
    const recordedAt = new Date("2026-04-24T12:00:00.000Z");
    prismaMock.meeting.create.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly",
      source: "zoom",
      recordedAt,
    });

    const { createMeeting } = await import("./meetings");
    await expect(createMeeting(actor, {
      workspaceId: "workspace-1",
      title: " Weekly ",
      source: " zoom ",
      recordedAt,
      participantIds: [" user-1 ", ""],
      ingestionGuidanceMd: " Highlight revenue follow-ups. ",
    })).resolves.toMatchObject({ id: "meeting-1" });

    expect(prismaMock.meeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Weekly",
        source: "zoom",
        recordedAt,
        participantIds: ["user-1"],
        ingestionGuidanceMd: "Highlight revenue follow-ups.",
      }),
    });
  });

  it("createMeeting marks summary-only duplicate updates as completed", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    const scheduledAt = new Date("2026-04-30T17:00:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValueOnce([
      {
        id: "scheduled-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        source: "internal",
        status: "SCHEDULED",
        recordedAt: scheduledAt,
        participantEmails: ["jan@example.com"],
        archivedAt: null,
        createdAt: scheduledAt,
        updatedAt: scheduledAt,
      },
    ]);
    prismaMock.meeting.findFirst.mockResolvedValueOnce({
      id: "scheduled-1",
      title: "Weekly Tactical",
      source: "internal",
      externalId: null,
      calendarExternalId: null,
      meetingUrl: null,
      meetingUrlHash: null,
      recordedAt: scheduledAt,
      scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: ["jan@example.com"],
    });
    prismaMock.meeting.update.mockResolvedValueOnce({
      id: "scheduled-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "internal",
      status: "COMPLETED",
      recordedAt,
      summaryMd: "Summary text",
    });

    const { createMeeting } = await import("./meetings");
    await expect(createMeeting(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "manual",
      recordedAt,
      summaryMd: "Summary text",
      participantEmails: ["jan@example.com"],
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "scheduled-1",
      },
    })).resolves.toMatchObject({
      id: "scheduled-1",
      status: "COMPLETED",
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "scheduled-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        recordedAt,
        summaryMd: "Summary text",
      }),
    }));
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("createMeeting rejects a missing source", async () => {
    const { createMeeting } = await import("./meetings");
    await expect(createMeeting(actor, {
      workspaceId: "workspace-1",
      source: " ",
      recordedAt: new Date("2026-04-24T12:00:00.000Z"),
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("createScheduledMeeting stores a scheduled meeting URL and hash", async () => {
    const startsAt = new Date("2026-04-30T17:00:00.000Z");
    const scheduledEndAt = new Date("2026-04-30T17:30:00.000Z");
    prismaMock.meeting.create.mockResolvedValue({
      id: "meeting-1",
      title: "Manual Teams call",
      source: "manual-recorder",
      status: "SCHEDULED",
      recordedAt: startsAt,
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    });

    const { createScheduledMeeting } = await import("./meetings");
    await expect(createScheduledMeeting(actor, {
      workspaceId: "workspace-1",
      title: " Manual Teams call ",
      startsAt,
      scheduledEndAt,
      meetingUrl: "https://TEAMS.microsoft.com/l/meetup-join/abc#ignored",
      participantEmails: [" Member@Example.com "],
      source: "manual-recorder",
    })).resolves.toMatchObject({ id: "meeting-1" });

    expect(prismaMock.meeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        status: "SCHEDULED",
        title: "Manual Teams call",
        source: "manual-recorder",
        recordedAt: startsAt,
        scheduledEndAt,
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        meetingUrlHash: expect.any(String),
        participantEmails: ["member@example.com"],
      }),
    });
  });

  it("createMeetingSeries materializes recurring scheduled meetings", async () => {
    const startsAt = new Date("2026-04-30T17:00:00.000Z");
    const scheduledEndAt = new Date("2026-04-30T18:00:00.000Z");
    prismaMock.meetingSeries.create.mockResolvedValue({
      id: "series-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      description: null,
      source: "internal",
      externalId: null,
      recurrenceRule: "FREQ=WEEKLY;COUNT=2",
      startsAt,
      defaultDurationMinutes: 60,
      participantIds: [],
      participantEmails: ["jan@example.com"],
    });
    prismaMock.meeting.findUnique.mockImplementation(async (args: any) => ({
      id: `meeting-${prismaMock.meeting.findUnique.mock.calls.length}`,
      workspaceId: "workspace-1",
      seriesId: "series-1",
      status: "SCHEDULED",
      title: "Weekly Tactical",
      source: "internal",
      externalId: args.where.externalId,
      participantEmails: ["jan@example.com"],
    }));

    const { createMeetingSeries } = await import("./meetings");
    await expect(createMeetingSeries(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      startsAt,
      scheduledEndAt,
      recurrenceRule: "FREQ=WEEKLY;COUNT=2",
      participantEmails: [" Jan@Example.com "],
    })).resolves.toMatchObject({
      series: { id: "series-1" },
      meetings: expect.arrayContaining([
        expect.objectContaining({ status: "SCHEDULED" }),
      ]),
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("createMeetingSeries stores a supported recorder URL for inherited occurrences", async () => {
    const startsAt = new Date("2026-04-30T17:00:00.000Z");
    const scheduledEndAt = new Date("2026-04-30T18:00:00.000Z");
    prismaMock.meetingSeries.create.mockResolvedValue({
      id: "series-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      description: null,
      source: "internal",
      externalId: null,
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      meetingUrlHash: "hash-1",
      startsAt,
      defaultDurationMinutes: 60,
      participantIds: [],
      participantEmails: [],
    });
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      seriesId: "series-1",
      status: "SCHEDULED",
      title: "Weekly Tactical",
      source: "internal",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
    });

    const { createMeetingSeries } = await import("./meetings");
    await expect(createMeetingSeries(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      startsAt,
      scheduledEndAt,
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      meetingUrl: "https://TEAMS.microsoft.com/meet/12345678901234?p=abc#ignored",
    })).resolves.toMatchObject({
      series: { id: "series-1", meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc" },
      meetings: [expect.objectContaining({ meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc" })],
    });

    expect(prismaMock.meetingSeries.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        meetingUrlHash: expect.any(String),
      }),
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("setMeetingSeriesRecorderUrl updates only future empty scheduled occurrences", async () => {
    const now = new Date("2026-04-30T16:00:00.000Z");
    prismaMock.meetingSeries.findFirst.mockResolvedValue({
      id: "series-1",
      title: "Weekly Tactical",
      meetingUrlHash: "old-hash",
    });
    prismaMock.meetingSeries.update.mockResolvedValue({
      id: "series-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      meetingUrlHash: "new-hash",
    });
    prismaMock.meeting.updateMany.mockResolvedValue({ count: 2 });

    const { setMeetingSeriesRecorderUrl } = await import("./meetings");
    await expect(setMeetingSeriesRecorderUrl(actor, {
      workspaceId: "workspace-1",
      seriesId: "series-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      now,
    })).resolves.toMatchObject({
      updatedFutureScheduledMeetings: 2,
    });

    expect(prismaMock.meeting.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        seriesId: "series-1",
        status: "SCHEDULED",
        archivedAt: null,
        recordedAt: { gte: now },
        transcript: null,
        summaryMd: null,
        OR: [{ meetingUrl: null }, { meetingUrlHash: "old-hash" }],
      }),
      data: expect.objectContaining({
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        meetingUrlHash: expect.any(String),
      }),
    });
  });

  it("importMeetingInvite parses .ics attendees and dedupes by external IDs", async () => {
    prismaMock.meetingSeries.upsert.mockResolvedValue({
      id: "series-ics",
      workspaceId: "workspace-1",
      title: "Imported Tactical",
      description: "Discuss agenda",
      source: "ics",
      externalId: "ics-series:workspace-1:invite-1",
      recurrenceRule: "FREQ=WEEKLY;COUNT=2",
      startsAt: new Date("2026-04-30T17:00:00.000Z"),
      defaultDurationMinutes: 60,
      participantIds: [],
      participantEmails: ["jan@example.com"],
    });
    prismaMock.meeting.findUnique.mockImplementation(async (args: any) => ({
      id: `meeting-${prismaMock.meeting.findUnique.mock.calls.length}`,
      workspaceId: "workspace-1",
      seriesId: "series-ics",
      status: "SCHEDULED",
      title: "Imported Tactical",
      source: "ics",
      externalId: args.where.externalId,
      participantEmails: ["jan@example.com"],
    }));

    const icsText = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:invite-1",
      "DTSTART:20260430T170000Z",
      "DTEND:20260430T180000Z",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "SUMMARY:Imported Tactical",
      "DESCRIPTION:Discuss agenda",
      "ATTENDEE;CN=Jan:mailto:Jan@Example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const { importMeetingInvite } = await import("./meetings");
    await expect(importMeetingInvite(actor, {
      workspaceId: "workspace-1",
      icsText,
    })).resolves.toEqual([{ seriesId: "series-ics", meetings: expect.any(Array) }]);

    expect(prismaMock.meetingSeries.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalId: "ics-series:workspace-1:invite-1" },
      create: expect.objectContaining({
        participantEmails: ["jan@example.com"],
        recurrenceRule: "FREQ=WEEKLY;COUNT=2",
      }),
    }));
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("importMeetingInvite refreshes future inherited occurrences when an ICS link changes", async () => {
    prismaMock.meetingSeries.findUnique.mockResolvedValue({ meetingUrlHash: "old-hash" });
    prismaMock.meetingSeries.upsert.mockResolvedValue({
      id: "series-ics",
      workspaceId: "workspace-1",
      title: "Imported Tactical",
      description: "Join https://teams.microsoft.com/meet/12345678901234?p=newcode",
      source: "ics",
      externalId: "ics-series:workspace-1:invite-1",
      recurrenceRule: "FREQ=WEEKLY;COUNT=1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
      meetingUrlHash: "new-hash",
      startsAt: new Date("2026-04-30T17:00:00.000Z"),
      defaultDurationMinutes: 60,
      participantIds: [],
      participantEmails: [],
    });
    prismaMock.meeting.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meeting.findUnique.mockImplementation(async (args: any) => ({
      id: "meeting-ics",
      workspaceId: "workspace-1",
      seriesId: "series-ics",
      status: "SCHEDULED",
      title: "Imported Tactical",
      source: "ics",
      externalId: args.where.externalId,
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
    }));

    const icsText = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:invite-1",
      "DTSTART:20260430T170000Z",
      "DTEND:20260430T180000Z",
      "RRULE:FREQ=WEEKLY;COUNT=1",
      "SUMMARY:Imported Tactical",
      "DESCRIPTION:Join https://teams.microsoft.com/meet/12345678901234?p=newcode",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const { importMeetingInvite } = await import("./meetings");
    await importMeetingInvite(actor, {
      workspaceId: "workspace-1",
      icsText,
    });

    expect(prismaMock.meeting.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        seriesId: "series-ics",
        status: "SCHEDULED",
        archivedAt: null,
        recordedAt: { gte: expect.any(Date) },
        transcript: null,
        summaryMd: null,
        OR: [{ meetingUrl: null }, { meetingUrlHash: "old-hash" }],
      }),
      data: expect.objectContaining({
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
        meetingUrlHash: expect.any(String),
      }),
    });
  });

  it("ensureMeetingSeriesOccurrences creates missing weekly occurrences in the repair window", async () => {
    const startsAt = new Date("2026-04-01T17:00:00.000Z");
    prismaMock.meetingSeries.findMany.mockResolvedValue([
      {
        id: "series-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        description: null,
        source: "internal",
        externalId: null,
        recurrenceRule: "FREQ=WEEKLY;COUNT=3",
        startsAt,
        defaultDurationMinutes: 60,
        participantIds: ["member-1"],
        participantEmails: ["jan@example.com"],
      },
    ]);
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.meeting.findUnique.mockImplementation(async (args: any) => ({
      id: `created-${prismaMock.meeting.findUnique.mock.calls.length}`,
      workspaceId: "workspace-1",
      seriesId: "series-1",
      status: "SCHEDULED",
      title: "Weekly Tactical",
      source: "internal",
      externalId: args.where.externalId,
    }));

    const { ensureMeetingSeriesOccurrences } = await import("./meetings");
    await expect(ensureMeetingSeriesOccurrences({
      workspaceId: "workspace-1",
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-30T00:00:00.000Z"),
      reason: "test",
    })).resolves.toMatchObject({
      workspaceId: "workspace-1",
      seriesCount: 1,
      meetingCount: 3,
      createdCount: 3,
    });

    expect(prismaMock.meetingSeries.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        archivedAt: null,
        recurrenceRule: { not: null },
      },
      orderBy: { startsAt: "asc" },
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("ensureMeetingSeriesOccurrences is idempotent and does not overwrite existing occurrence fields", async () => {
    const startsAt = new Date("2026-04-01T17:00:00.000Z");
    const existingMeeting = {
      id: "meeting-existing",
      workspaceId: "workspace-1",
      seriesId: "series-1",
      status: "COMPLETED",
      title: "Edited title",
      source: "internal",
      externalId: "meeting-series:series-1:2026-04-01T17:00:00.000Z",
      recordedAt: startsAt,
      scheduledEndAt: new Date("2026-04-01T18:00:00.000Z"),
      transcript: "Existing transcript",
      agendaJson: { title: "Existing agenda" },
      participantIds: ["edited-member"],
      participantEmails: ["edited@example.com"],
      meetingUrl: "https://meet.example.test/edited",
    };
    prismaMock.meetingSeries.findMany.mockResolvedValue([
      {
        id: "series-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        description: null,
        source: "internal",
        externalId: null,
        recurrenceRule: "FREQ=WEEKLY;COUNT=1",
        startsAt,
        defaultDurationMinutes: 60,
        participantIds: ["member-1"],
        participantEmails: ["jan@example.com"],
      },
    ]);
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-existing" }]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.meeting.findUnique.mockResolvedValue(existingMeeting);

    const { ensureMeetingSeriesOccurrences } = await import("./meetings");
    await expect(ensureMeetingSeriesOccurrences({
      workspaceId: "workspace-1",
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-02T00:00:00.000Z"),
    })).resolves.toMatchObject({
      meetingCount: 1,
      createdCount: 0,
      meetings: [expect.objectContaining({
        id: "meeting-existing",
        transcript: "Existing transcript",
        agendaJson: { title: "Existing agenda" },
        participantEmails: ["edited@example.com"],
        meetingUrl: "https://meet.example.test/edited",
      })],
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
  });

  it("ensureMeetingSeriesOccurrences honors finite recurrence UNTIL rules", async () => {
    const startsAt = new Date("2026-04-01T17:00:00.000Z");
    prismaMock.meetingSeries.findMany.mockResolvedValue([
      {
        id: "series-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        description: null,
        source: "internal",
        externalId: null,
        recurrenceRule: "FREQ=WEEKLY;UNTIL=20260415T170000Z",
        startsAt,
        defaultDurationMinutes: 60,
        participantIds: [],
        participantEmails: [],
      },
    ]);
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.meeting.findUnique.mockImplementation(async (args: any) => ({
      id: `created-${prismaMock.meeting.findUnique.mock.calls.length}`,
      workspaceId: "workspace-1",
      seriesId: "series-1",
      status: "SCHEDULED",
      title: "Weekly Tactical",
      source: "internal",
      externalId: args.where.externalId,
    }));

    const { ensureMeetingSeriesOccurrences } = await import("./meetings");
    await expect(ensureMeetingSeriesOccurrences({
      workspaceId: "workspace-1",
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-05-01T00:00:00.000Z"),
    })).resolves.toMatchObject({
      meetingCount: 3,
      createdCount: 3,
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("uploadMeetingTranscript auto-matches a scheduled meeting by title, time, and attendees", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValue([
      {
        id: "scheduled-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        source: "internal",
        status: "SCHEDULED",
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
        participantEmails: ["jan@example.com"],
      },
    ]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "scheduled-1",
      title: "Weekly Tactical",
      transcript: null,
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: ["jan@example.com"],
    });
    prismaMock.meeting.update.mockResolvedValue({
      id: "scheduled-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "internal",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "manual",
      recordedAt,
      transcript: "Transcript text",
      participantEmails: ["jan@example.com"],
      ingestionGuidanceMd: " Track onboarding decisions. ",
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "scheduled-1" },
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "scheduled-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        transcript: "Transcript text",
        ingestionGuidanceMd: "Track onboarding decisions.",
        aiProcessedAt: null,
      }),
    }));
    expect(prismaMock.meetingInsight.deleteMany).toHaveBeenCalledWith({
      where: {
        meetingId: "scheduled-1",
        workspaceId: "workspace-1",
        status: "SUGGESTED",
        sourceRecordId: null,
      },
    });
    expect(prismaMock.meetingTranscriptProcessingProgress.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { meetingId: "scheduled-1" },
      update: expect.objectContaining({
        currentStage: "SUMMARIZING",
        completedAt: null,
        failedAt: null,
      }),
    }));
  });

  it("uploadMeetingTranscript rejects appending to an existing source transcript", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValue([
      {
        id: "completed-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        source: "chat-transcript-upload",
        status: "COMPLETED",
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: null,
        participantEmails: ["jan@example.com"],
      },
    ]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "completed-1",
      title: "Weekly Tactical",
      transcript: "Jan: Existing transcript.",
      summaryMd: "Existing summary",
      ingestionGuidanceMd: "Preserve decisions.",
      participantIds: ["member-1"],
      participantEmails: ["jan@example.com"],
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "chat-transcript-upload",
      recordedAt,
      transcript: "Andy: Added a new personal note.",
      participantEmails: ["andy@example.com"],
      ingestionGuidanceMd: "Extract Andy's personal note.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("uploadMeetingTranscript does not directly match recurring meetings by URL alone", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValue([
      {
        id: "scheduled-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        source: "internal",
        status: "SCHEDULED",
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
        participantEmails: [],
        meetingUrlHash: "shared-url",
      },
    ]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "scheduled-1",
      title: "Weekly Tactical",
      transcript: null,
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      meetingUrlHash: "shared-url",
    });
    prismaMock.meeting.update.mockResolvedValue({
      id: "scheduled-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "internal",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "manual",
      recordedAt,
      transcript: "Transcript text",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "scheduled-1" },
    });

    expect(prismaMock.meeting.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.meeting.findFirst.mock.invocationCallOrder[0],
    );
  });

  it("uploadMeetingTranscript does not directly match recurring meetings by calendar UID alone", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValue([
      {
        id: "scheduled-1",
        workspaceId: "workspace-1",
        title: "Weekly Tactical",
        source: "internal",
        status: "SCHEDULED",
        recordedAt: new Date("2026-04-30T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
        participantEmails: [],
        calendarExternalId: "recurring-event-uid",
      },
    ]);
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "scheduled-1",
      title: "Weekly Tactical",
      transcript: null,
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
      calendarExternalId: "recurring-event-uid",
    });
    prismaMock.meeting.update.mockResolvedValue({
      id: "scheduled-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "internal",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "manual",
      recordedAt,
      transcript: "Transcript text",
      calendarExternalId: "recurring-event-uid",
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "scheduled-1" },
    });

    expect(prismaMock.meeting.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.meeting.findFirst.mock.invocationCallOrder[0],
    );
  });

  it("uploadMeetingTranscript preserves existing calendar meeting identifiers", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({ id: "scheduled-1" })
      .mockResolvedValueOnce({
        id: "scheduled-1",
        title: "Weekly Tactical",
        transcript: null,
        summaryMd: null,
        ingestionGuidanceMd: null,
        participantIds: [],
        participantEmails: [],
        externalId: "meeting-series:series-1:2026-04-30T17:00:00.000Z",
        calendarExternalId: "recurring-event-uid",
      });
    prismaMock.meeting.update.mockResolvedValue({
      id: "scheduled-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "internal",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      meetingId: "scheduled-1",
      title: "Weekly Tactical",
      source: "meeting-transcript:fireflies",
      recordedAt,
      transcript: "Transcript text",
      externalId: "meeting-transcript:FIREFLIES:ff-1",
      calendarExternalId: "incoming-calendar-id",
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "scheduled-1" },
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "scheduled-1" },
      data: expect.objectContaining({
        externalId: "meeting-series:series-1:2026-04-30T17:00:00.000Z",
        calendarExternalId: "recurring-event-uid",
      }),
    }));
  });

  it("uploadMeetingTranscript rejects replacing an existing source transcript", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({ id: "completed-1" })
      .mockResolvedValueOnce({
        id: "completed-1",
        title: "Weekly Tactical",
        transcript: "Jan: Existing transcript.",
        summaryMd: "Existing summary",
        ingestionGuidanceMd: null,
        participantIds: [],
        participantEmails: [],
      });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      meetingId: "completed-1",
      title: "Weekly Tactical",
      source: "chat-transcript-upload",
      recordedAt,
      transcript: "Replacement transcript",
      replaceTranscript: true,
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
  });

  it("uploadMeetingTranscript links source records before transcript processing is queued", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({ id: "completed-1" })
      .mockResolvedValueOnce({
        id: "completed-1",
        title: "Weekly Tactical",
        transcript: null,
        summaryMd: null,
        ingestionGuidanceMd: null,
        participantIds: [],
        participantEmails: [],
        externalId: null,
        calendarExternalId: null,
        meetingUrl: null,
        meetingUrlHash: null,
      });
    prismaMock.meeting.update.mockResolvedValue({
      id: "completed-1",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      source: "meeting-transcript:fireflies",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
      ingestionGuidanceMd: null,
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      meetingId: "completed-1",
      title: "Weekly Tactical",
      source: "meeting-transcript:fireflies",
      recordedAt,
      transcript: "Transcript text",
      sourceRecordId: "source-record-1",
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "completed-1" },
    });

    expect(prismaMock.meetingTranscriptSourceRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "source-record-1",
        workspaceId: "workspace-1",
      },
      data: {
        meetingId: "completed-1",
      },
    });
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.event.createMany.mock.invocationCallOrder[0],
    );
  });

  it("uploadMeetingTranscript scopes transcript source external IDs on new meetings", async () => {
    const recordedAt = new Date("2026-04-30T17:10:00.000Z");
    prismaMock.meeting.findFirst.mockResolvedValue(null);
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.meeting.create.mockResolvedValue({
      id: "created-1",
      workspaceId: "workspace-1",
      title: "Imported transcript",
      source: "meeting-transcript:fireflies",
      status: "COMPLETED",
      recordedAt,
      transcript: "Transcript text",
    });

    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, {
      workspaceId: "workspace-1",
      title: "Imported transcript",
      source: "meeting-transcript:fireflies",
      recordedAt,
      transcript: "Transcript text",
      externalId: "meeting-transcript:FIREFLIES:ff-1",
    })).resolves.toMatchObject({
      status: "created",
      meeting: { id: "created-1" },
    });

    expect(prismaMock.meeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ externalId: "workspace:workspace-1:meeting-transcript:FIREFLIES:ff-1" }],
      }),
    }));
    expect(prismaMock.meeting.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        externalId: "workspace:workspace-1:meeting-transcript:FIREFLIES:ff-1",
      }),
    }));
  });

  it("requestMeetingIntelligenceRegeneration appends guidance and requeues transcript processing", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      source: "transcript-upload",
      status: "COMPLETED",
      transcript: "Jan: Milan owns onboarding.",
      ingestionGuidanceMd: "Extract action owners.",
    });
    prismaMock.meeting.update.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      source: "transcript-upload",
      status: "COMPLETED",
      transcript: "Jan: Milan owns onboarding.",
      ingestionGuidanceMd: "Extract action owners.\n\nAdditional guidance:\nSeparate proposals from action items.",
    });

    const { requestMeetingIntelligenceRegeneration } = await import("./meetings");
    await expect(requestMeetingIntelligenceRegeneration(actor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      guidanceMd: " Separate proposals from action items. ",
    })).resolves.toMatchObject({ id: "meeting-1" });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-1" },
      data: {
        ingestionGuidanceMd: "Extract action owners.\n\nAdditional guidance:\nSeparate proposals from action items.",
        aiProcessedAt: null,
      },
    }));
    expect(prismaMock.meetingInsight.deleteMany).toHaveBeenCalledWith({
      where: {
        meetingId: "meeting-1",
        workspaceId: "workspace-1",
        status: "SUGGESTED",
        sourceRecordId: null,
      },
    });
    expect(prismaMock.event.createMany).toHaveBeenCalled();
  });

  it("updateMeetingProcessedContent lets an active member edit summary and guidance", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "member-2-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      summaryMd: "Old summary",
      ingestionGuidanceMd: "Old guidance",
      transcriptProcessingProgress: null,
    });
    prismaMock.meeting.update.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      summaryMd: "New summary",
      ingestionGuidanceMd: "New guidance",
    });

    const { updateMeetingProcessedContent } = await import("./meetings");
    await expect(updateMeetingProcessedContent({
      kind: "user",
      user: {
        id: "member-2-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      summaryMd: " New summary ",
      ingestionGuidanceMd: " New guidance ",
    })).resolves.toMatchObject({
      id: "meeting-1",
      summaryMd: "New summary",
      ingestionGuidanceMd: "New guidance",
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "meeting-1",
        workspaceId: "workspace-1",
        summaryMd: "Old summary",
        ingestionGuidanceMd: "Old guidance",
      }),
      data: {
        summaryMd: "New summary",
        ingestionGuidanceMd: "New guidance",
      },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: "member-2-user",
        action: "meeting.processed_content_updated",
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: "workspace-1",
          type: "meeting.processed-content-updated",
          aggregateType: "Meeting",
          aggregateId: "meeting-1",
          payload: expect.objectContaining({
            meetingId: "meeting-1",
            editedSummary: true,
          }),
        }),
      ],
    });
  });

  it("updateMeetingProcessedContent rejects stale original values", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "member-2-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      summaryMd: "Fresh summary",
      ingestionGuidanceMd: "Old guidance",
      transcriptProcessingProgress: null,
    });

    const { updateMeetingProcessedContent } = await import("./meetings");
    await expect(updateMeetingProcessedContent({
      kind: "user",
      user: {
        id: "member-2-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      summaryMd: "New summary",
      expectedSummaryMd: "Old summary",
    })).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("updateMeetingProcessedContent rejects edits while transcript processing is active", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "member-2-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      summaryMd: "Old summary",
      ingestionGuidanceMd: "Old guidance",
      transcriptProcessingProgress: {
        currentStage: "SUMMARIZING",
        completedAt: null,
        failedAt: null,
      },
    });

    const { updateMeetingProcessedContent } = await import("./meetings");
    await expect(updateMeetingProcessedContent({
      kind: "user",
      user: {
        id: "member-2-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      summaryMd: "Manual summary",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("updateMeetingProcessedContent rejects transcript edits before processing starts", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "member-2-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly Tactical",
      transcript: "Jan: We need a cleaner intake path.",
      summaryMd: null,
      ingestionGuidanceMd: null,
      aiProcessedAt: null,
      transcriptProcessingProgress: null,
    });

    const { updateMeetingProcessedContent } = await import("./meetings");
    await expect(updateMeetingProcessedContent({
      kind: "user",
      user: {
        id: "member-2-user",
        email: "member@example.com",
        displayName: "Member",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      summaryMd: "Manual summary",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("deleteMeeting archives an existing meeting with a provided reason", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly",
      source: "zoom",
      archivedAt: null,
    });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1", archivedAt: new Date("2026-04-25T12:00:00.000Z") });
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});

    const { deleteMeeting } = await import("./meetings");
    await expect(deleteMeeting(actor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      reason: "Canceled before it happened.",
    })).resolves.toEqual({ id: "meeting-1" });
    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archiveReason: "Canceled before it happened.",
      }),
    }));
  });

  it("deleteMeeting falls back to the legacy archive reason when none is provided", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly",
      source: "zoom",
      archivedAt: null,
    });
    prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1", archivedAt: new Date("2026-04-25T12:00:00.000Z") });
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});

    const { deleteMeeting } = await import("./meetings");
    await expect(deleteMeeting(actor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
    })).resolves.toEqual({ id: "meeting-1" });
    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "meeting-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archiveReason: "Archived from meeting delete path.",
      }),
    }));
  });
});
