import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, fetchMock } = vi.hoisted(() => {
  const prisma = {
    customerDeployment: {
      findUnique: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceMeetingRecorderConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceRecorderCalendarSource: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workflowJob: {
      count: vi.fn(),
      upsert: vi.fn(),
    },
    meeting: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    meetingRecording: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    meetingRecorderProviderEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    meetingRecorderSmokeRun: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    meetingInsight: {
      deleteMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    prismaMock: prisma,
    fetchMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => {
  return {
    prisma: prismaMock,
    parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
    env: {
      NODE_ENV: "test",
      SESSION_COOKIE_SECRET: "test-session-secret",
      SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
      RECALL_API_KEY: "recall-key",
      RECALL_REGION: "us-west-2",
      RECALL_WEBHOOK_SECRET: `whsec_${Buffer.from("recall-secret").toString("base64")}`,
      MEETING_BAAS_API_KEY: "baas-key",
      MEETING_BAAS_WEBHOOK_SECRET: "baas-secret",
      MEETING_RECORDER_PUBLIC_BASE_URL: "https://app.example.com",
      APP_URL: "https://app.example.com",
    },
    encryptSecret: vi.fn((value: string) => `enc:${value}`),
    decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, "")),
    randomOpaqueToken: vi.fn(() => "nonce-value"),
  };
});

vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

const operatorActor: AppActor = {
  kind: "user",
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

const facilitatorActor: AppActor = {
  kind: "user",
  user: {
    id: "facilitator-1",
    email: "facilitator@example.com",
    displayName: "Facilitator",
    globalRole: "USER",
  },
};

describe("meeting recorder domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      autoRecordEnabled: true,
      monthlyMinuteCap: 6000,
    });
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Weekly",
      recordedAt: new Date("2026-05-05T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-05T18:00:00.000Z"),
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      participantEmails: ["team@example.com"],
    });
    prismaMock.meetingRecording.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } });
    prismaMock.meetingRecording.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue(null);
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "facilitator-1",
      role: "FACILITATOR",
      isActive: true,
    });
  });

  it("builds Recall create bot requests with transcript and consent chat config", async () => {
    const { buildRecallCreateBotRequest } = await import("./meeting-recorders");
    const request = buildRecallCreateBotRequest({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAt: new Date("2026-05-05T17:00:00.000Z"),
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      metadata: { workspaceId: "workspace-1", meetingId: "meeting-1", recordingId: "recording-1" },
    }, "secret", "us-east-1");

    expect(request.url).toBe("https://us-east-1.recall.ai/api/v1/bot/");
    expect(request.body).toMatchObject({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "Corgtex Recorder",
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: {
              mode: "prioritize_accuracy",
              language_code: "auto",
            },
          },
        },
      },
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: "Recording notice",
          pin: true,
        },
      },
    });
  });

  it("rejects tampered recorder calendar OAuth state", async () => {
    const { createRecorderCalendarOAuthState, readRecorderCalendarOAuthState } = await import("./meeting-recorders");
    const state = createRecorderCalendarOAuthState({ deploymentId: "deployment-1", actorUserId: "operator-1" });
    const [payload] = state.split(".");

    expect(readRecorderCalendarOAuthState(state)).toMatchObject({
      deploymentId: "deployment-1",
      actorUserId: "operator-1",
      nonce: "nonce-value",
    });
    expect(readRecorderCalendarOAuthState(`${payload}.tampered`)).toBeNull();
    expect(readRecorderCalendarOAuthState(`${state}.extra`)).toBeNull();
  });

  it("stores recorder calendar source tokens encrypted and scoped to one workspace provider", async () => {
    const { upsertRecorderCalendarSource } = await import("./meeting-recorders");
    prismaMock.workspaceRecorderCalendarSource.upsert.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      expiresAt: new Date("2027-05-05T18:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncAt: null,
      lastSyncJobId: null,
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 0,
      lastSchedulableEventCount: 0,
      createdAt: new Date("2026-05-05T17:00:00.000Z"),
      updatedAt: new Date("2026-05-05T17:00:00.000Z"),
    });

    await upsertRecorderCalendarSource({
      workspaceId: "workspace-1",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      scopes: ["Calendars.Read"],
    });

    expect(prismaMock.workspaceRecorderCalendarSource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_provider: {
          workspaceId: "workspace-1",
          provider: "MICROSOFT",
        },
      },
      update: expect.objectContaining({
        accessTokenEnc: "enc:access-token",
        refreshTokenEnc: "enc:refresh-token",
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        accessTokenEnc: "enc:access-token",
        refreshTokenEnc: "enc:refresh-token",
      }),
    }));
  });

  it("clears stale recorder calendar refresh tokens when reconnect does not return one", async () => {
    const { upsertRecorderCalendarSource } = await import("./meeting-recorders");
    prismaMock.workspaceRecorderCalendarSource.upsert.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-2",
      providerAccountEmail: "new-calendar@customer.test",
      status: "ACTIVE",
    });

    await upsertRecorderCalendarSource({
      workspaceId: "workspace-1",
      providerAccountId: "ms-user-2",
      providerAccountEmail: "new-calendar@customer.test",
      accessToken: "new-access-token",
      refreshToken: null,
      expiresIn: 3600,
      scopes: ["Calendars.Read"],
    });

    expect(prismaMock.workspaceRecorderCalendarSource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        accessTokenEnc: "enc:new-access-token",
        refreshTokenEnc: null,
      }),
      create: expect.objectContaining({
        accessTokenEnc: "enc:new-access-token",
        refreshTokenEnc: null,
      }),
    }));
  });

  it("verifies Svix-style webhook signatures", async () => {
    const { verifySvixLikeSignature } = await import("./meeting-recorders");
    const payload = JSON.stringify({ event: "transcript.done" });
    const msgId = "msg_1";
    const timestamp = "1770000000";
    const key = Buffer.from("recall-secret");
    const signature = createHmac("sha256", key).update(`${msgId}.${timestamp}.${payload}`).digest("base64");

    expect(verifySvixLikeSignature({
      secret: `whsec_${Buffer.from("recall-secret").toString("base64")}`,
      payload,
      headers: {
        "svix-id": msgId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
    })).toBe(true);
  });

  it("marks live smoke runs failed when recorder webhooks report terminal failures", async () => {
    const { processMeetingRecorderWebhook } = await import("./meeting-recorders");
    const payload = JSON.stringify({
      id: "event-1",
      event: "bot.failed",
      data: {
        bot: {
          id: "bot-1",
          metadata: {
            workspaceId: "workspace-1",
            meetingId: "meeting-1",
            recordingId: "recording-1",
          },
        },
        data: {
          code: "failed",
          sub_code: "no_join",
          message: "Bot could not join.",
        },
      },
    });
    const msgId = "msg_1";
    const timestamp = "1770000000";
    const signature = createHmac("sha256", Buffer.from("recall-secret"))
      .update(`${msgId}.${timestamp}.${payload}`)
      .digest("base64");
    prismaMock.meetingRecorderProviderEvent.findUnique.mockResolvedValue(null);
    prismaMock.meetingRecorderProviderEvent.upsert.mockResolvedValue({ id: "provider-event-1" });
    prismaMock.meetingRecorderProviderEvent.update.mockResolvedValue({ id: "provider-event-1" });
    prismaMock.meetingRecording.findUnique.mockResolvedValue({
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "bot-1",
      status: "SCHEDULED",
      failureMessage: null,
    });
    prismaMock.meetingRecording.update.mockResolvedValue({
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "bot-1",
      status: "FAILED",
      failureCode: "no_join",
      failureMessage: "Bot could not join.",
    });
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(processMeetingRecorderWebhook("RECALL_AI", {
      rawBody: payload,
      headers: {
        "svix-id": msgId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
    })).resolves.toMatchObject({
      processed: true,
      duplicate: false,
      recordingId: "recording-1",
    });

    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({
      where: {
        recordingId: "recording-1",
        status: { in: ["PENDING", "SCHEDULED"] },
      },
      data: expect.objectContaining({
        status: "FAILED",
        failureMessage: "Bot could not join.",
        completedAt: expect.any(Date),
      }),
    });
  });

  it("normalizes structured transcript segments into Corgtex transcript text", async () => {
    const { normalizeProviderTranscript } = await import("./meeting-recorders");

    expect(normalizeProviderTranscript([
      {
        participant: { name: "Alice" },
        start_timestamp: 12,
        text: "Hello team.",
      },
      {
        speaker: "Bob",
        start_ms: 62_000,
        words: [{ text: "Next" }, { text: "step" }],
      },
    ])).toBe([
      "Alice [00:00:12]: Hello team.",
      "Bob [00:01:02]: Next step",
    ].join("\n"));
  });

  it("falls back from Recall to Meeting BaaS on retryable scheduling failures", async () => {
    const { scheduleMeetingRecording } = await import("./meeting-recorders");
    prismaMock.meetingRecording.create
      .mockResolvedValueOnce({
        id: "recording-recall",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        status: "PENDING",
      })
      .mockResolvedValueOnce({
        id: "recording-baas",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "MEETING_BAAS",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        status: "PENDING",
      });
    prismaMock.meetingRecording.update
      .mockResolvedValueOnce({ id: "recording-recall", status: "FAILED" })
      .mockResolvedValueOnce({ id: "recording-baas", status: "SCHEDULED", externalBotId: "baas-bot-1" });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 507, text: async () => "capacity" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ data: { bot_id: "baas-bot-1" } }) });

    await expect(scheduleMeetingRecording(operatorActor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      mode: "auto",
    })).resolves.toMatchObject({ id: "recording-baas", status: "SCHEDULED" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.meetingRecording.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "recording-recall" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "vendor_capacity_exceeded" }),
    }));
  });

  it("sends only IDs in Recall scheduling metadata", async () => {
    const { scheduleMeetingRecording } = await import("./meeting-recorders");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "deployment-1",
      customerAccountId: "customer-1",
    });
    prismaMock.meetingRecording.create.mockResolvedValue({
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      status: "PENDING",
    });
    prismaMock.meetingRecording.update.mockResolvedValue({
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      status: "SCHEDULED",
      externalBotId: "recall-bot-1",
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-1" }) });

    await scheduleMeetingRecording(operatorActor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      mode: "manual",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.metadata).toEqual({
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      recordingId: "recording-1",
      deploymentId: "deployment-1",
      customerId: "customer-1",
    });
    expect(JSON.stringify(body.metadata)).not.toContain("Weekly");
    expect(JSON.stringify(body.metadata)).not.toContain("team@example.com");
  });

  it("does not fall back from Recall to Meeting BaaS on non-retryable scheduling failures", async () => {
    const { scheduleMeetingRecording } = await import("./meeting-recorders");
    prismaMock.meetingRecording.create.mockResolvedValue({
      id: "recording-recall",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      status: "PENDING",
    });
    prismaMock.meetingRecording.update.mockResolvedValue({
      id: "recording-recall",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      status: "FAILED",
      failureCode: "vendor_http_error",
    });
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });

    await expect(scheduleMeetingRecording(operatorActor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      mode: "auto",
    })).resolves.toMatchObject({
      id: "recording-recall",
      status: "FAILED",
      failureCode: "vendor_http_error",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.meetingRecording.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "recording-recall" },
      data: expect.objectContaining({
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: "vendor_http_error",
      }),
    }));
  });

  it("blocks facilitator manual scheduling when the monthly cap is exceeded", async () => {
    const { scheduleMeetingRecording } = await import("./meeting-recorders");
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      autoRecordEnabled: true,
      monthlyMinuteCap: 60,
    });
    prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 3600 } });

    await expect(scheduleMeetingRecording(facilitatorActor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      mode: "manual",
    })).rejects.toMatchObject({
      status: 402,
      code: "RECORDER_MONTHLY_CAP_EXCEEDED",
    });
  });

  it("treats private, free, declined, past, and too-soon calendar events as ineligible", async () => {
    const { calendarEventIsEligible } = await import("./meeting-recorders");
    const now = new Date("2026-05-05T16:00:00.000Z");
    const base = {
      id: "event-1",
      provider: "MICROSOFT" as const,
      title: "Client sync",
      description: null,
      startTime: new Date("2026-05-05T17:00:00.000Z"),
      endTime: new Date("2026-05-05T18:00:00.000Z"),
      attendees: [],
      organizerEmail: "host@example.com",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      htmlLink: null,
      status: null,
      visibility: null,
      transparency: null,
      responseStatus: null,
    };

    expect(calendarEventIsEligible(base, now)).toBe(true);
    expect(calendarEventIsEligible({ ...base, visibility: "private" }, now)).toBe(false);
    expect(calendarEventIsEligible({ ...base, transparency: "free" }, now)).toBe(false);
    expect(calendarEventIsEligible({ ...base, responseStatus: "declined" }, now)).toBe(false);
    expect(calendarEventIsEligible({ ...base, endTime: new Date("2026-05-05T15:00:00.000Z") }, now)).toBe(false);
    expect(calendarEventIsEligible({ ...base, startTime: new Date("2026-05-05T16:05:00.000Z") }, now)).toBe(false);
  });

  it("records failed live smoke prechecks as completed failures", async () => {
    const { runMeetingRecorderSmoke } = await import("./meeting-recorders");
    prismaMock.meetingRecorderSmokeRun.create.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "FAILED",
      liveVendorCall: true,
    });

    await expect(runMeetingRecorderSmoke({
      workspaceId: "workspace-1",
      deploymentId: "deployment-1",
      meetingUrl: "https://example.com/not-teams",
      joinAt: new Date(Date.now() + 60 * 60 * 1000),
      provider: "RECALL_AI",
      liveVendorCall: true,
    })).resolves.toMatchObject({ status: "FAILED" });

    expect(prismaMock.meetingRecorderSmokeRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "deployment-1",
        status: "FAILED",
        liveVendorCall: true,
        completedAt: expect.any(Date),
        failureMessage: expect.stringContaining("supported Microsoft Teams meeting URL"),
      }),
    }));
    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("syncs recorder calendar sources by scheduling only eligible Microsoft Teams meetings", async () => {
    const { syncRecorderCalendarSource } = await import("./meeting-recorders");
    prismaMock.workspaceRecorderCalendarSource.findFirst.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      expiresAt: new Date("2027-05-05T18:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncAt: null,
      lastSyncJobId: null,
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 0,
      lastSchedulableEventCount: 0,
      createdAt: new Date("2026-05-05T17:00:00.000Z"),
      updatedAt: new Date("2026-05-05T17:00:00.000Z"),
    });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      accessTokenEnc: "enc:access-token",
      refreshTokenEnc: "enc:refresh-token",
      expiresAt: new Date("2027-05-05T18:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
    });
    prismaMock.workspaceRecorderCalendarSource.update.mockResolvedValue({});
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "meeting-teams",
        title: "Client sync",
        recordedAt: new Date("2026-05-05T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-05T18:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        participantEmails: [],
      });
    prismaMock.meeting.upsert.mockResolvedValue({
      id: "meeting-teams",
      workspaceId: "workspace-1",
      title: "Client sync",
      recordedAt: new Date("2026-05-05T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-05T18:00:00.000Z"),
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    });
    prismaMock.meetingRecording.create.mockResolvedValue({
      id: "recording-teams",
      workspaceId: "workspace-1",
      meetingId: "meeting-teams",
      provider: "RECALL_AI",
      status: "PENDING",
    });
    prismaMock.meetingRecording.update.mockResolvedValue({
      id: "recording-teams",
      workspaceId: "workspace-1",
      meetingId: "meeting-teams",
      provider: "RECALL_AI",
      status: "SCHEDULED",
      externalBotId: "recall-bot-1",
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "teams-event",
              subject: "Client sync",
              start: { dateTime: "2026-05-05T10:00:00", timeZone: "Pacific Standard Time" },
              end: { dateTime: "2026-05-05T11:00:00", timeZone: "Pacific Standard Time" },
              onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
              showAs: "busy",
              sensitivity: "normal",
            },
            {
              id: "zoom-event",
              subject: "Zoom sync",
              start: { dateTime: "2026-05-05T17:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-05-05T18:00:00", timeZone: "UTC" },
              onlineMeeting: { joinUrl: "https://example.zoom.us/j/123" },
              showAs: "busy",
              sensitivity: "normal",
            },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/events?$skiptoken=page-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "zoom-event-next-page",
              subject: "Zoom sync",
              start: { dateTime: "2026-05-05T19:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-05-05T20:00:00", timeZone: "UTC" },
              onlineMeeting: { joinUrl: "https://example.zoom.us/j/456" },
              showAs: "busy",
              sensitivity: "normal",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-1" }) });

    await expect(syncRecorderCalendarSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      now: new Date("2026-05-05T16:00:00.000Z"),
    })).resolves.toMatchObject({ action: "synced", teamsEvents: 1, scheduled: 1 });

    expect(prismaMock.meeting.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.meeting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        recordedAt: new Date("2026-05-05T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-05T18:00:00.000Z"),
      }),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("https://graph.microsoft.com/v1.0/me/calendarView?");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://graph.microsoft.com/v1.0/me/events?$skiptoken=page-2");
  });

  it("requires a completed smoke run and ignores failed sync jobs before the latest successful sync", async () => {
    const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
    const lastSyncAt = new Date("2026-05-05T18:00:00.000Z");
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      status: "ACTIVE",
      lastSyncAt,
      lastSyncStartedAt: new Date("2026-05-05T17:59:00.000Z"),
      lastSyncCompletedAt: lastSyncAt,
      lastSyncJobId: "job-success",
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 1,
      lastSchedulableEventCount: 1,
      createdAt: new Date("2026-05-05T17:00:00.000Z"),
      updatedAt: lastSyncAt,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "DRY_RUN_READY",
      provider: "RECALL_AI",
      createdAt: new Date("2026-05-05T18:05:00.000Z"),
    });

    const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

    expect(prismaMock.workflowJob.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        type: "meeting-recorders.calendar.sync",
        status: "FAILED",
        updatedAt: { gt: lastSyncAt },
      },
    });
    expect(readiness.checks.find((check) => check.key === "worker_sync")?.ok).toBe(true);
    expect(readiness.checks.find((check) => check.key === "last_smoke")?.ok).toBe(false);
    expect(readiness.ready).toBe(false);
  });

  it("does not mark worker sync ready before a successful calendar sync completes", async () => {
    const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      status: "ACTIVE",
      lastSyncAt: null,
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncJobId: null,
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 0,
      lastSchedulableEventCount: 0,
      createdAt: new Date("2026-05-05T17:00:00.000Z"),
      updatedAt: new Date("2026-05-05T17:00:00.000Z"),
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: new Date("2026-05-05T18:05:00.000Z"),
    });

    const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

    expect(readiness.checks.find((check) => check.key === "worker_sync")).toMatchObject({
      ok: false,
      detail: "No successful recorder calendar sync yet.",
    });
    expect(readiness.ready).toBe(false);
  });

  it("reuses an active recording when concurrent scheduling hits the database dedupe key", async () => {
    const { scheduleMeetingRecording } = await import("./meeting-recorders");
    prismaMock.meetingRecording.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "recording-active",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-1",
        status: "SCHEDULED",
      });
    prismaMock.meetingRecording.create.mockRejectedValue({ code: "P2002" });

    await expect(scheduleMeetingRecording(operatorActor, {
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      mode: "auto",
    })).resolves.toMatchObject({
      id: "recording-active",
      status: "SCHEDULED",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks stale active recordings failed during reconciliation", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "recording-stale",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        status: "SCHEDULED",
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
      }]);
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-stale", status: "FAILED" });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 2 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 1, recoveredTranscripts: 0 });

    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "recording-stale" },
      data: expect.objectContaining({
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: "STALE_RECORDER",
      }),
    }));
    expect(prismaMock.meetingRecorderProviderEvent.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        redactedAt: null,
      },
      data: {
        redactedAt: expect.any(Date),
      },
    });
  });

  it("recovers completed Recall transcripts during reconciliation when the webhook was missed", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly progress",
      source: "internal",
      status: "COMPLETED",
      recordedAt: new Date("2026-05-04T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      transcript: "Speaker [00:00:00]: Existing",
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
    };
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({ transcriptProcessedAt: null });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-1",
          status: "done",
          recordings: [
            {
              id: "recall-recording-old",
              status: "done",
              completed_at: "2026-05-04T16:30:00.000Z",
              media_shortcuts: {
                transcript: {
                  data: {
                    download_url: "https://signed.example.com/old-transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                  },
                },
              },
            },
            {
              id: "recall-recording-new",
              status: "done",
              completed_at: "2026-05-04T17:05:00.000Z",
              media_shortcuts: {
                transcript: {
                  data: {
                    download_url: "https://signed.example.com/transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                  },
                },
              },
            },
          ],
        }), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/old-transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "The recorder recovered the first transcript segment." },
        ]), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 60, text: "The recorder recovered the second transcript segment." },
        ]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({ recordedAt: meeting.recordedAt, title: meeting.title, participantEmails: [] })
      .mockResolvedValueOnce({ id: meeting.id })
      .mockResolvedValueOnce(meeting);
    prismaMock.meeting.update.mockResolvedValue({
      ...meeting,
      transcript: `${meeting.transcript}\n\n---\nAdditional transcript upload:\nDana [00:00:00]: The recorder recovered the first transcript segment.\nDana [00:01:00]: The recorder recovered the second transcript segment.`,
    });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-1", status: "COMPLETED" });
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 1 });

    expect(prismaMock.meetingRecording.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ status: { in: expect.arrayContaining(["COMPLETED"]) } }),
          expect.objectContaining({ status: "FAILED", failureCode: "STALE_RECORDER" }),
        ]),
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://signed.example.com/old-transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://signed.example.com/transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
    const meetingUpdateData = prismaMock.meeting.update.mock.calls[0]?.[0]?.data;
    expect(meetingUpdateData?.transcript).toContain("The recorder recovered the first transcript segment.");
    expect(meetingUpdateData?.transcript).toContain("The recorder recovered the second transcript segment.");
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        activeDedupeKey: null,
        transcriptProcessedAt: expect.any(Date),
        failureCode: null,
        failureMessage: null,
      }),
    });
  });

  it("falls back to the legacy Recall transcript endpoint when bot metadata is unavailable", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly progress",
      source: "internal",
      status: "COMPLETED",
      recordedAt: new Date("2026-05-04T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      transcript: "Speaker [00:00:00]: Existing",
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
    };
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({ transcriptProcessedAt: null });
    let botFetches = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        botFetches += 1;
        if (botFetches === 1) {
          return new Response(JSON.stringify({
            id: "recall-bot-1",
            status: "done",
          }), { status: 200 });
        }
        return new Response("temporary bot metadata failure", { status: 503 });
      }
      if (value.endsWith("/api/v1/bot/recall-bot-1/transcript/")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "The legacy endpoint still had the transcript." },
        ]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meeting.findFirst
      .mockResolvedValueOnce({ recordedAt: meeting.recordedAt, title: meeting.title, participantEmails: [] })
      .mockResolvedValueOnce({ id: meeting.id })
      .mockResolvedValueOnce(meeting);
    prismaMock.meeting.update.mockResolvedValue({
      ...meeting,
      transcript: `${meeting.transcript}\n\n---\nAdditional transcript upload:\nDana [00:00:00]: The legacy endpoint still had the transcript.`,
    });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-1", status: "COMPLETED" });
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://us-west-2.recall.ai/api/v1/bot/recall-bot-1/transcript/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Token recall-key",
          accept: "application/json",
        }),
      }),
    );
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        activeDedupeKey: null,
        transcriptProcessedAt: expect.any(Date),
        failureCode: null,
        failureMessage: null,
      }),
    });
  });

  it("does not recover Recall transcripts when bot done status cannot be confirmed", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValueOnce(recording);
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        return new Response("temporary bot status failure", { status: 503 });
      }
      if (value.endsWith("/api/v1/bot/recall-bot-1/transcript/")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "This could still be partial." },
        ]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 0 });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "https://us-west-2.recall.ai/api/v1/bot/recall-bot-1/transcript/",
    );
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("skips Recall recovery intake when a delayed webhook already processed the transcript", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({
        ...recording,
        transcriptProcessedAt: new Date("2026-05-04T17:05:00.000Z"),
      });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-1",
          status: "done",
          recordings: [{
            id: "recall-recording-1",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "This transcript was already handled by the webhook." },
        ]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 0 });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("skips Recall recovery intake when the lock-protected row is already processed", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      activeDedupeKey: null,
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({
        transcriptProcessedAt: new Date("2026-05-04T17:05:00.000Z"),
      });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-1",
          status: "done",
          recordings: [{
            id: "recall-recording-1",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "Only the claim holder should ingest this." },
        ]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 0 });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("marks empty Recall transcripts processed instead of retrying forever", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      activeDedupeKey: null,
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({ transcriptProcessedAt: null });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-1/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-1",
          status: "done",
          recordings: [{
            id: "recall-recording-1",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/transcript.json")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-1", status: "COMPLETED" });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toEqual({ staleFailed: 0, recoveredTranscripts: 0 });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        activeDedupeKey: null,
        transcriptProcessedAt: expect.any(Date),
        failureCode: "RECORDER_TRANSCRIPT_EMPTY",
      }),
    });
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({
      where: {
        recordingId: "recording-1",
        status: { in: ["PENDING", "SCHEDULED"] },
      },
      data: expect.objectContaining({
        status: "FAILED",
        failureMessage: "Provider transcript was empty.",
        completedAt: expect.any(Date),
      }),
    });
  });
});
