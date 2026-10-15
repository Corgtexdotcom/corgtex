import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { humanMemberIdentityWhere } from "./member-identity";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
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
    proposal: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    meetingInsight: {
      findMany: vi.fn(),
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

vi.mock("./source-lineage", async () => ({
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  isLineageKind: (value: unknown) => ["Meeting", "MeetingTranscript", "MeetingSeries"].includes(String(value)),
  assertArtifactInputWriteFence: vi.fn().mockResolvedValue(undefined),
  advanceArchivedArtifactEnvelopeLineage: vi.fn().mockResolvedValue(false),
  advanceHumanArtifactInputLineage: vi.fn().mockResolvedValue(true),
  captureArtifactInputProof: vi.fn(async (_actor: unknown, _workspace: string, inputs: Array<{ kind: string; id: string }>) =>
    inputs.map((input) => ({ ...input, fingerprint: "a".repeat(64) }))),
  captureArtifactReadHeadObservation: vi.fn(async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() })),
  mergeLineageInputRoot: (_previous: unknown, root: unknown) => root,
  withArtifactCountReleaseSnapshot: vi.fn(async (_actor: unknown, _workspace: string, _roots: unknown, _before: unknown,
    release: (tx: typeof prismaMock) => Promise<unknown>) => release(prismaMock)),
  captureArtifactInputSnapshotProof: vi.fn().mockResolvedValue([{ kind: "ArtifactInputSnapshot", id: "meeting-prior-snapshot", fingerprint: "b".repeat(64) }]),
  captureImmutableArtifactInputProof: vi.fn().mockResolvedValue([{ kind: "ArtifactInputSnapshot", id: "frozen-prior", fingerprint: "c".repeat(64) }]),
  currentArtifactInputRoots: vi.fn(async () => [{ kind: "MeetingTranscript", id: "meeting-1", fingerprint: "a".repeat(64) }]),
  invalidateArtifactInputLineage: vi.fn(),
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  lineageContentFingerprint: vi.fn().mockReturnValue("a".repeat(64)),
  preserveUnknownArtifactInputSnapshot: vi.fn(),
  recordArtifactInputLineage: vi.fn(),
  readableArtifactIds: vi.fn(async (_actor: unknown, _workspace: string, _kind: string, records: Array<{ id: string }>) => new Set(records.map((record) => record.id))),
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
    prismaMock.$queryRaw.mockResolvedValue([{ id: "locked-series" }]);
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingInsight.findMany.mockResolvedValue([]);
    prismaMock.proposal.findMany.mockResolvedValue([]);
    prismaMock.tension.findMany.mockResolvedValue([]);
    prismaMock.meetingTranscriptSourceRecord.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingTranscriptProcessingProgress.findUnique.mockResolvedValue(null);
    prismaMock.meetingTranscriptProcessingProgress.upsert.mockResolvedValue({ id: "progress-1" });
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.meetingSeries.findMany.mockResolvedValue([]);
    prismaMock.meetingSeries.findFirst.mockImplementation(async () => (await prismaMock.meetingSeries.findMany())[0] ?? null);
    prismaMock.meetingSeries.findUnique.mockResolvedValue(null);
    prismaMock.meeting.findMany.mockResolvedValue([]);
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
    await expect(listMeetings(actor, "workspace-1")).resolves.toEqual([{ id: "meeting-1" }]);
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", archivedAt: null },
      orderBy: [{ recordedAt: "desc" }, { id: "asc" }], take: 100,
    });
  });

  it("listMeetings matches multiple members through participant ids and emails", async () => {
    prismaMock.member.findMany.mockResolvedValue([
      { id: "member-1", userId: "user-1", user: { id: "user-1", email: "one@example.test" } },
      { id: "member-2", userId: "user-2", user: { id: "user-2", email: "two@example.test" } },
    ]);
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1" }]);

    const { listMeetings } = await import("./meetings");
    await expect(listMeetings(actor, "workspace-1", { memberIds: ["member-1", "member-2", "member-1"] })).resolves.toEqual([{ id: "meeting-1" }]);
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
      orderBy: [{ recordedAt: "desc" }, { id: "asc" }], take: 100,
    });
  });

  it("getMeeting returns a meeting with related records", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      proposals: [], tensions: [], series: null,
      insights: [
        {
          id: "insight-1",
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
    const record = await prismaMock.meeting.findFirst();
    prismaMock.meetingInsight.findMany.mockResolvedValue(record.insights);
    prismaMock.meeting.findFirst.mockClear();
    prismaMock.action.findMany.mockResolvedValue([{ id: "action-1", title: "Follow up", author: null, assigneeMember: null }]);

    const { getMeeting } = await import("./meetings");
    await expect(getMeeting(actor, "workspace-1", "meeting-1")).resolves.toEqual(expect.objectContaining({
      id: "meeting-1",
      raisedActions: [{ id: "action-1", title: "Follow up", author: null, assigneeMember: null }],
    }));
    expect(prismaMock.meetingInsight.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", meetingId: "meeting-1" }, take: 100,
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
    await expect(getMeeting(actor, "workspace-1", "missing-meeting")).resolves.toBeNull();
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

  it("rejects copied meeting content before duplicate reads when no input receipt exists", async () => {
    const { createMeeting } = await import("./meetings");
    const copiedActor = { kind: "agent", label: "execution", authProvider: "bootstrap", workspaceIds: ["workspace-1"] } as AppActor;
    await expect(createMeeting(copiedActor, { workspaceId: "workspace-1", source: "external-execution",
      recordedAt: new Date("2026-04-30T17:00:00.000Z"), transcript: "Copied output", duplicateGuard: {} }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.meeting.findMany).not.toHaveBeenCalled();
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("uses a supplied transaction for copied meeting duplicate scan, records, and receipts", async () => {
    const { createMeeting } = await import("./meetings");
    const { recordArtifactInputLineage, isArtifactInputProofReadable } = await import("./source-lineage");
    const copiedActor = { kind: "agent", label: "execution", authProvider: "bootstrap", workspaceIds: ["workspace-1"] } as AppActor;
    const root = { kind: "ExecutionResult" as const, id: "result-1", fingerprint: "a".repeat(64) };
    const txFindMany = vi.fn().mockResolvedValue([]);
    const txCreate = vi.fn().mockResolvedValue({ id: "tx-meeting", workspaceId: "workspace-1", title: "Copied meeting",
      source: "external-execution", recordedAt: new Date("2026-04-30T17:00:00.000Z"), transcript: "Copied output" });
    const tx = { ...prismaMock, meeting: { ...prismaMock.meeting, findMany: txFindMany, create: txCreate } } as any;
    const meeting = await createMeeting(copiedActor, { workspaceId: "workspace-1", title: "Copied meeting",
      source: "external-execution", recordedAt: new Date("2026-04-30T17:00:00.000Z"), transcript: "Copied output",
      lineageRoots: [root], duplicateGuard: {}, tx });
    expect(meeting.id).toBe("tx-meeting");
    expect(isArtifactInputProofReadable).toHaveBeenCalledWith(copiedActor, "workspace-1", [root], tx);
    expect(txFindMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx,
      artifact: { kind: "MeetingTranscript", id: "tx-meeting" }, inheritedRoots: [root] }));
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.meeting.findMany).not.toHaveBeenCalled();
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
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
    const { recordArtifactInputLineage } = await import("./source-lineage");
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "Meeting", id: "meeting-1" }, origin: "HUMAN_ORIGINAL", inputs: [],
    }));
  });

  it("createMeetingSeries materializes recurring scheduled meetings", async () => {
    const startsAt = new Date("2026-04-30T17:00:00.000Z");
    const scheduledEndAt = new Date("2026-04-30T18:00:00.000Z");
    prismaMock.member.findMany.mockResolvedValue([{ id: "member-1", userId: "user-1" }]);
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
      participantIds: ["member-1", "user-1"],
      participantEmails: [" Jan@Example.com "],
    })).resolves.toMatchObject({
      series: { id: "series-1" },
      meetings: expect.arrayContaining([
        expect.objectContaining({ status: "SCHEDULED" }),
      ]),
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
    expect(prismaMock.member.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        isActive: true,
        ...humanMemberIdentityWhere(),
        OR: [
          { id: { in: ["member-1", "user-1"] } },
          { userId: { in: ["member-1", "user-1"] } },
        ],
      },
      select: { id: true, userId: true },
    });
    expect(prismaMock.meetingSeries.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        participantIds: ["user-1"],
        participantEmails: ["jan@example.com"],
      }),
    }));
  });

  it("rejects scheduled meeting attendees outside the active human workspace membership", async () => {
    const { createMeetingSeries } = await import("./meetings");
    prismaMock.member.findMany.mockResolvedValue([]);

    await expect(createMeetingSeries(actor, {
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      startsAt: new Date("2026-04-30T17:00:00.000Z"),
      participantIds: ["foreign-user"],
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
      message: "Every selected attendee must be an active member of this workspace.",
    });

    expect(prismaMock.member.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        isActive: true,
        ...humanMemberIdentityWhere(),
        OR: [
          { id: { in: ["foreign-user"] } },
          { userId: { in: ["foreign-user"] } },
        ],
      },
      select: { id: true, userId: true },
    });
    expect(prismaMock.meetingSeries.create).not.toHaveBeenCalled();
  });

  it("resolves meeting participants from either legacy member ids or canonical user ids", async () => {
    const { getMeetingParticipants } = await import("./meetings");
    prismaMock.member.findMany.mockResolvedValue([]);

    await expect(getMeetingParticipants(actor, "workspace-1", ["member-1", "user-1"])).resolves.toEqual([]);

    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        OR: [
          { id: { in: ["member-1", "user-1"] } },
          { userId: { in: ["member-1", "user-1"] } },
        ],
      },
    }));
  });

  it("withholds unproven participant roles and departed profiles", async () => {
    const { captureArtifactInputProof } = await import("./source-lineage");
    const { AppError } = await import("./errors");
    const { getMeetingParticipants } = await import("./meetings");
    prismaMock.member.findMany.mockResolvedValue([
      { id: "member-visible", user: { id: "user-visible", displayName: "Public", email: "public@example.test" },
        roleAssignments: [{ id: "assignment-secret", role: { id: "role-secret", name: "Finance role" } },
          { id: "assignment-public", role: { id: "role-public", name: "Public role" } }] },
      { id: "member-departed", user: { id: "user-departed", displayName: "Departed", email: "departed@example.test" }, roleAssignments: [] },
    ]);
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs.some((input) => (input.kind === "Role" && input.id === "role-secret") || (input.kind === "User" && input.id === "user-departed"))) {
        throw new AppError(409, "UNKNOWN_LINEAGE", "Synthetic unavailable profile or role.");
      }
      return inputs.map((input) => ({ ...input, fingerprint: "a".repeat(64) }));
    });
    const participants = await getMeetingParticipants(actor, "workspace-1", ["member-visible", "member-departed"]);
    expect(participants).toHaveLength(1);
    expect(participants[0].roleAssignments).toEqual([{ id: "assignment-public", role: { name: "Public role" } }]);
    expect(JSON.stringify(participants)).not.toContain("Finance");
    expect(JSON.stringify(participants)).not.toContain("Departed");
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor, _ws, inputs) => inputs.map((input) => ({ ...input, fingerprint: "a".repeat(64) })));
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
    const children = ["future-1", "future-2", "past-1"].map((id, index) => ({ id, workspaceId: "workspace-1",
      seriesId: "series-1", title: "Weekly Tactical", status: "SCHEDULED", transcript: null, summaryMd: null,
      meetingUrl: null, meetingUrlHash: null, recordedAt: new Date(index < 2 ? "2026-05-01T17:00:00.000Z" : "2026-04-01T17:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z") }));
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
    prismaMock.meeting.findMany.mockResolvedValue(children);
    prismaMock.meeting.findFirst.mockImplementation(async (args: any) => children.find((child) => child.id === args.where.id));
    prismaMock.meeting.update.mockImplementation(async (args: any) => ({ ...children.find((child) => child.id === args.where.id), ...args.data }));

    const { setMeetingSeriesRecorderUrl } = await import("./meetings");
    await expect(setMeetingSeriesRecorderUrl(actor, {
      workspaceId: "workspace-1",
      seriesId: "series-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      now,
    })).resolves.toMatchObject({
      updatedFutureScheduledMeetings: 2,
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "future-1", updatedAt: children[0].updatedAt },
      data: expect.objectContaining({ meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        meetingUrlHash: expect.any(String) }),
    }));
    const { recordArtifactInputLineage } = await import("./source-lineage");
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "Meeting", id: "past-1" }, origin: "DERIVED",
      inheritedRoots: expect.arrayContaining([{ kind: "ArtifactInputSnapshot", id: "frozen-prior", fingerprint: "c".repeat(64) }]),
    }));
  });

  it("does not change a series when an old child cannot be frozen", async () => {
    const { captureImmutableArtifactInputProof } = await import("./source-lineage");
    prismaMock.meetingSeries.findFirst.mockResolvedValue({ id: "series-1", workspaceId: "workspace-1",
      title: "Planning", meetingUrlHash: "old-hash" });
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "child-1", workspaceId: "workspace-1",
      seriesId: "series-1", status: "SCHEDULED", transcript: null,
      recordedAt: new Date("2026-05-01T17:00:00.000Z") }]);
    vi.mocked(captureImmutableArtifactInputProof).mockResolvedValueOnce([{ kind: "ArtifactInputSnapshot",
      id: "series-old", fingerprint: "a".repeat(64) }]).mockRejectedValueOnce({ code: "SOURCE_CHANGED" });
    const { setMeetingSeriesRecorderUrl } = await import("./meetings");
    await expect(setMeetingSeriesRecorderUrl(actor, { workspaceId: "workspace-1", seriesId: "series-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      now: new Date("2026-04-30T16:00:00.000Z") })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(prismaMock.meetingSeries.update).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
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
    prismaMock.meetingSeries.findUnique.mockResolvedValue({ id: "series-ics", workspaceId: "workspace-1", meetingUrlHash: "old-hash" });
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
    const oldOccurrence = { id: "old-occurrence", workspaceId: "workspace-1", seriesId: "series-ics",
      status: "SCHEDULED", title: "Imported Tactical", transcript: null, summaryMd: null,
      meetingUrl: null, meetingUrlHash: null, recordedAt: new Date(Date.now() + 86_400_000),
      updatedAt: new Date("2026-04-01T00:00:00.000Z") };
    prismaMock.meeting.findMany.mockResolvedValue([oldOccurrence]);
    prismaMock.meeting.findFirst.mockResolvedValue(oldOccurrence);
    prismaMock.meeting.update.mockImplementation(async (args: any) => ({ ...oldOccurrence, ...args.data }));
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

    expect(prismaMock.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "old-occurrence", updatedAt: oldOccurrence.updatedAt },
      data: expect.objectContaining({ meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
        meetingUrlHash: expect.any(String) }),
    }));
    const { invalidateArtifactInputLineage } = await import("./source-lineage");
    expect(invalidateArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "Meeting", id: "old-occurrence" },
    }));
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

  it("filters unproved scheduled candidates before its match limit and member lookups", async () => {
    const { readableArtifactIds } = await import("./source-lineage");
    const hidden = Array.from({ length: 100 }, (_, index) => ({ id: `hidden-${index}`, workspaceId: "workspace-1",
      title: "Hidden schedule", source: "ics", status: "SCHEDULED", transcript: null,
      recordedAt: new Date("2026-04-30T17:00:00.000Z"), participantIds: ["hidden-person"], participantEmails: [] }));
    const visible = { id: "visible-1", workspaceId: "workspace-1", title: "Visible schedule", source: "manual",
      status: "SCHEDULED", transcript: null, recordedAt: new Date("2026-04-30T17:10:00.000Z"),
      participantIds: [], participantEmails: [] };
    prismaMock.meeting.findMany.mockResolvedValueOnce(hidden).mockResolvedValueOnce([visible]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, kind, rows) => new Set(rows
      .filter((row) => kind !== "Meeting" || row.id === "visible-1").map((row) => row.id)));
    try {
      const { findTranscriptMeetingCandidates } = await import("./meetings");
      await expect(findTranscriptMeetingCandidates(actor, { workspaceId: "workspace-1",
        recordedAt: visible.recordedAt, title: visible.title })).resolves.toMatchObject([{ meetingId: "visible-1" }]);
      expect(prismaMock.meeting.findMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.member.findMany).not.toHaveBeenCalled();
    } finally {
      vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, _kind, rows) => new Set(rows.map((row) => row.id)));
    }
  });

  it("scores transcript candidate attendee overlap from scheduled workspace member ids", async () => {
    const recordedAt = new Date("2026-04-30T17:00:00.000Z");
    prismaMock.meeting.findMany.mockResolvedValue([{
      id: "scheduled-member-attendee",
      workspaceId: "workspace-1",
      title: "Weekly Tactical",
      status: "SCHEDULED",
      recordedAt,
      scheduledEndAt: new Date("2026-04-30T18:00:00.000Z"),
      participantIds: ["user-1"],
      participantEmails: [],
    }]);
    prismaMock.member.findMany.mockResolvedValue([{
      id: "member-1",
      userId: "user-1",
      user: { email: "jan@example.com" },
    }]);

    const { findTranscriptMeetingCandidates } = await import("./meetings");
    await expect(findTranscriptMeetingCandidates(actor, {
      workspaceId: "workspace-1",
      recordedAt,
      participantEmails: ["jan@example.com"],
    })).resolves.toMatchObject([{
      meetingId: "scheduled-member-attendee",
      score: 0.6,
      reason: "time, attendees",
    }]);
    expect(prismaMock.member.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        OR: [
          { id: { in: ["user-1"] } },
          { userId: { in: ["user-1"] } },
        ],
      },
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

  it("does not certify a first transcript by copying an unproved scheduled meeting", async () => {
    const { captureArtifactInputProof } = await import("./source-lineage");
    prismaMock.meeting.findFirst.mockResolvedValue({ id: "legacy-schedule", workspaceId: "workspace-1",
      title: "Unproved calendar title", transcript: null, participantIds: [], participantEmails: [] });
    vi.mocked(captureArtifactInputProof).mockRejectedValueOnce({ code: "UNKNOWN_LINEAGE" });
    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, { workspaceId: "workspace-1", meetingId: "legacy-schedule",
      title: "New title", source: "manual", recordedAt: new Date("2026-04-30T17:00:00.000Z"),
      transcript: "New human transcript" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany).not.toHaveBeenCalled();
  });

  it("joins a supplied intake transaction for matched transcript and source receipt", async () => {
    const txUpdate = vi.fn().mockResolvedValue({ id: "scheduled-1", workspaceId: "workspace-1", title: "Meeting",
      source: "recorder:recall", status: "COMPLETED", transcript: "Provider text",
      recordedAt: new Date("2026-04-30T17:00:00.000Z") });
    const tx = { ...prismaMock, meeting: { ...prismaMock.meeting,
      findFirst: vi.fn().mockResolvedValue({ id: "scheduled-1", workspaceId: "workspace-1", title: "Meeting",
        source: "manual-recorder", transcript: null, participantIds: [], participantEmails: [] }),
      update: txUpdate } } as any;
    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, { workspaceId: "workspace-1", meetingId: "scheduled-1", tx,
      source: "recorder:recall", sourceRecordId: "record-1", transcript: "Provider text",
      recordedAt: new Date("2026-04-30T17:00:00.000Z"),
      lineageRoots: [{ kind: "ArtifactInputSnapshot", id: "provider-input", fingerprint: "a".repeat(64) }] }))
      .resolves.toMatchObject({ status: "matched", meeting: { id: "scheduled-1" } });
    expect(txUpdate).toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
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

  it("uploadMeetingTranscript rejects unproved provider content before matching", async () => {
    const { uploadMeetingTranscript } = await import("./meetings");
    await expect(uploadMeetingTranscript(actor, { workspaceId: "workspace-1", meetingId: "meeting-1",
      source: "meeting-transcript:fireflies", recordedAt: new Date("2026-04-30T17:10:00.000Z"),
      transcript: "Provider transcript", sourceRecordId: "source-record-1" }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(prismaMock.meeting.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingTranscriptSourceRecord.updateMany).not.toHaveBeenCalled();
  });

  it("uploadMeetingTranscript links proved source records before transcript processing is queued", async () => {
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
      lineageRoots: [{ kind: "ArtifactInputSnapshot", id: "synthetic-provider-receipt", fingerprint: "a".repeat(64) }],
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
    const { recordArtifactInputLineage } = await import("./source-lineage");
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { kind: "MeetingTranscript", id: "completed-1" },
      inheritedRoots: expect.arrayContaining([{ kind: "ArtifactInputSnapshot", id: "synthetic-provider-receipt", fingerprint: "a".repeat(64) }]),
    }));
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
  it("keeps original meeting fields while withholding unknown derived content and linked insight counts", async () => {
    const { readableArtifactIds } = await import("./source-lineage");
    vi.mocked(readableArtifactIds).mockImplementation(async (_reader, _workspace, kind, rows) =>
      new Set(kind === "MeetingTranscript" ? rows.map((row) => row.id) : []));
    const record = { id: "meeting-safe", workspaceId: "workspace-1", title: "Original title", source: "manual",
      transcript: "Original public transcript", summaryMd: "Finance secret", blocksJson: { secret: "Finance block" },
      decisionsJson: { secret: "Finance decision" }, agendaJson: { secret: "Finance agenda" }, series: null,
      proposals: [], tensions: [], insights: [{ id: "secret-insight", title: "Finance suggestion", status: "APPLIED",
        type: "ACTION_ITEM", operation: "CREATE", appliedEntityType: "Action", appliedEntityId: "finance-action" }] };
    prismaMock.meeting.findMany.mockResolvedValue([record]);
    prismaMock.meeting.findFirst.mockResolvedValue(record);
    const { listMeetings, getMeeting } = await import("./meetings");
    const listing = await listMeetings(actor, "workspace-1");
    expect(listing[0]).toMatchObject({ title: "Original title", transcript: "Original public transcript", summaryMd: null,
      blocksJson: null, decisionsJson: null, agendaJson: null });
    const detail = await getMeeting(actor, "workspace-1", "meeting-safe");
    expect(detail?.insights).toEqual([]);
    expect(detail?.raisedActions).toEqual([]);
    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(detail)).not.toContain("Finance");
  });

  it("filters duplicate candidates before scoring and redacts unknown summary copies", async () => {
    const { readableArtifactIds } = await import("./source-lineage");
    const { createMeeting } = await import("./meetings");
    const recordedAt = new Date("2026-05-01T09:00:00Z");
    const unknown = { id: "unknown-summary", workspaceId: "workspace-1", title: "Secret finance summary",
      transcript: null, summaryMd: "Secret finance summary", source: "manual", recordedAt, createdAt: recordedAt };
    prismaMock.meeting.findMany.mockResolvedValue([unknown]);
    prismaMock.meeting.create.mockResolvedValue({ id: "safe-new", workspaceId: "workspace-1", source: "manual", recordedAt });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, kind, rows) => new Set(kind === "MeetingTranscript" ? rows.map((row) => row.id) : []));
    await expect(createMeeting(actor, { workspaceId: "workspace-1", title: unknown.title, source: "manual", recordedAt,
      summaryMd: unknown.summaryMd, duplicateGuard: {} })).resolves.toMatchObject({ id: "safe-new" });
    prismaMock.meeting.findMany.mockResolvedValue([{ ...unknown, title: "Public original", transcript: "Public original transcript" }]);
    await expect(createMeeting(actor, { workspaceId: "workspace-1", title: "Public original", source: "manual", recordedAt,
      transcript: "Public original transcript", duplicateGuard: {} })).rejects.toMatchObject({ code: "DUPLICATE_GUARD_MATCH" });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _ws, _kind, rows) => new Set(rows.map((row) => row.id)));
  });

});
