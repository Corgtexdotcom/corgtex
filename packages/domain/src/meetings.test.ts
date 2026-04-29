import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    meeting: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    meetingSeries: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
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
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
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

  it("getMeeting returns a meeting with related records", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1" });

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "meeting-1")).resolves.toEqual({ id: "meeting-1" });
  });

  it("getMeeting returns null when not found", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue(null);

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting("workspace-1", "missing-meeting")).resolves.toBeNull();
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
    })).resolves.toMatchObject({ id: "meeting-1" });

    expect(prismaMock.meeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Weekly",
        source: "zoom",
        recordedAt,
        participantIds: ["user-1"],
      }),
    });
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
    prismaMock.meeting.upsert.mockImplementation(async (args: any) => ({
      id: `meeting-${prismaMock.meeting.upsert.mock.calls.length}`,
      ...args.create,
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

    expect(prismaMock.meeting.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        participantEmails: ["jan@example.com"],
        status: "SCHEDULED",
      }),
    }));
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
    prismaMock.meeting.upsert.mockImplementation(async (args: any) => ({
      id: `meeting-${prismaMock.meeting.upsert.mock.calls.length}`,
      ...args.create,
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
    expect(prismaMock.meeting.upsert).toHaveBeenCalledTimes(2);
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
    })).resolves.toMatchObject({
      status: "matched",
      meeting: { id: "scheduled-1" },
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "scheduled-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        transcript: "Transcript text",
      }),
    }));
  });

  it("deleteMeeting archives an existing meeting", async () => {
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
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
    }));
  });
});
