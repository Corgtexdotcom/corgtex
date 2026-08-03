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
    workspaceEnterpriseService: {
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
      delete: vi.fn(),
      findMany: vi.fn(),
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
      findFirst: vi.fn(),
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
    workspacePermalink: {
      upsert: vi.fn(),
    },
    meetingInsight: {
      deleteMany: vi.fn(),
    },
    meetingTranscriptProcessingProgress: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
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

function resetMockTree(value: unknown) {
  if (vi.isMockFunction(value)) {
    value.mockReset();
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      resetMockTree(item);
    }
  }
}

describe("meeting recorder domain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T01:00:00.000Z"));
    resetMockTree(prismaMock);
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(0);
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
      series: { meetingUrl: null },
      participantEmails: ["team@example.com"],
    });
    prismaMock.meeting.findMany.mockResolvedValue([]);
    prismaMock.meetingRecording.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.findMany.mockResolvedValue([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue(null);
    prismaMock.meetingRecorderProviderEvent.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.create.mockResolvedValue({
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      status: "PENDING",
    });
    prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    }));
    prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } });
    prismaMock.meetingRecording.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meeting.delete.mockResolvedValue({ id: "meeting-1" });
    prismaMock.meeting.create.mockResolvedValue({
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Live meeting",
      source: "manual-recorder",
      status: "SCHEDULED",
      recordedAt: new Date("2026-06-24T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      participantEmails: ["team@example.com"],
    });
    prismaMock.meetingTranscriptProcessingProgress.findUnique.mockResolvedValue(null);
    prismaMock.meetingTranscriptProcessingProgress.upsert.mockResolvedValue({ id: "progress-1" });
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
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

  it("sends a manual meeting recorder after validating the link and duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T17:00:00.000Z"));
    try {
      const { sendManualMeetingRecorder } = await import("./meeting-recorders");
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-1" }) });

      await expect(sendManualMeetingRecorder(facilitatorActor, {
        workspaceId: "workspace-1",
        meetingUrl: "https://MEET.google.com/abc-defg-hij#ignored",
        participantEmails: [" Team@Example.com "],
      })).resolves.toMatchObject({
        meeting: { id: "meeting-1" },
        recording: { status: "SCHEDULED", externalBotId: "recall-bot-1" },
      });

      expect(prismaMock.meeting.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          title: "Live meeting",
          source: "manual-recorder",
          recordedAt: new Date("2026-06-24T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          participantEmails: ["team@example.com"],
        }),
      });
      expect(prismaMock.meeting.delete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts Teams short business meet links for manual recorder scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T17:00:00.000Z"));
    try {
      const { sendManualMeetingRecorder } = await import("./meeting-recorders");
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-1" }) });

      await expect(sendManualMeetingRecorder(facilitatorActor, {
        workspaceId: "workspace-1",
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
      })).resolves.toMatchObject({
        meeting: { id: "meeting-1" },
        recording: { status: "SCHEDULED", externalBotId: "recall-bot-1" },
      });

      expect(prismaMock.meeting.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        }),
      });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed Teams short links before creating a manual meeting", async () => {
    const { sendManualMeetingRecorder } = await import("./meeting-recorders");

    await expect(sendManualMeetingRecorder(facilitatorActor, {
      workspaceId: "workspace-1",
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234",
    })).rejects.toMatchObject({
      status: 400,
      code: "RECORDER_TEAMS_FULL_JOIN_LINK_REQUIRED",
      message: expect.stringContaining("supported live meeting link"),
    });

    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid manual recorder duration before creating a meeting", async () => {
    const { sendManualMeetingRecorder } = await import("./meeting-recorders");

    await expect(sendManualMeetingRecorder(facilitatorActor, {
      workspaceId: "workspace-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      durationMinutes: "481",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.meeting.create).not.toHaveBeenCalled();
  });

  it("keeps the manual meeting and failed recording when provider scheduling fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T17:00:00.000Z"));
    try {
      const { sendManualMeetingRecorder } = await import("./meeting-recorders");
      prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
        workspaceId: "workspace-1",
        enabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        botName: "Corgtex Recorder",
        entryMessage: "Recording notice",
        autoRecordEnabled: true,
        monthlyMinuteCap: 6000,
      });
      prismaMock.meeting.findFirst.mockResolvedValueOnce({
        id: "meeting-1",
        title: "Live meeting",
        recordedAt: new Date("2026-06-24T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participantEmails: [],
      });
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });

      await expect(sendManualMeetingRecorder(facilitatorActor, {
        workspaceId: "workspace-1",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
      })).resolves.toMatchObject({
        meeting: { id: "meeting-1", status: "SCHEDULED" },
        recording: {
          id: "recording-1",
          status: "FAILED",
          failureCode: "vendor_http_error",
        },
      });

      expect(prismaMock.meeting.create).toHaveBeenCalled();
      expect(prismaMock.meeting.delete).not.toHaveBeenCalled();
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-1" },
        data: expect.objectContaining({
          status: "FAILED",
          failureCode: "vendor_http_error",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
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
        retention: {
          type: "timed",
          hours: 168,
        },
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

  it("builds immediate Recall create bot requests without join_at", async () => {
    const { buildRecallCreateBotRequest } = await import("./meeting-recorders");
    const request = buildRecallCreateBotRequest({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAt: new Date("2026-05-05T17:00:00.000Z"),
      joinMode: "immediate",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      metadata: { workspaceId: "workspace-1", meetingId: "meeting-1", recordingId: "recording-1" },
    }, "secret", "us-east-1");

    expect(request.url).toBe("https://us-east-1.recall.ai/api/v1/bot/");
    expect(request.body).not.toHaveProperty("join_at");
    expect(request.body).toMatchObject({
      recording_config: {
        retention: {
          type: "timed",
          hours: 168,
        },
      },
    });
  });

  it("switches Meeting BaaS between immediate and scheduled bot endpoints", async () => {
    const { buildMeetingBaasCreateBotRequest } = await import("./meeting-recorders");
    const scheduled = buildMeetingBaasCreateBotRequest({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAt: new Date("2026-05-05T17:00:00.000Z"),
      joinMode: "scheduled",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      metadata: { workspaceId: "workspace-1", meetingId: "meeting-1", recordingId: "recording-1" },
    }, "secret");
    const immediate = buildMeetingBaasCreateBotRequest({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAt: new Date("2026-05-05T17:00:00.000Z"),
      joinMode: "immediate",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      metadata: { workspaceId: "workspace-1", meetingId: "meeting-1", recordingId: "recording-1" },
    }, "secret");

    expect(scheduled.url).toBe("https://api.meetingbaas.com/v2/bots/scheduled");
    expect(scheduled.body).toMatchObject({ join_at: "2026-05-05T17:00:00.000Z" });
    expect(immediate.url).toBe("https://api.meetingbaas.com/v2/bots");
    expect(immediate.body).not.toHaveProperty("join_at");
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

  it("refreshes recorder Microsoft tokens through the work-school organization endpoint", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "microsoft-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "microsoft-client-secret");
    const { syncRecorderCalendarSource } = await import("./meeting-recorders");
    prismaMock.workspaceRecorderCalendarSource.findFirst.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      expiresAt: new Date("2026-05-05T15:00:00.000Z"),
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
      accessTokenEnc: "enc:old-access-token",
      refreshTokenEnc: "enc:refresh-token",
      expiresAt: new Date("2026-05-05T15:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
    });
    prismaMock.workspaceRecorderCalendarSource.update.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      accessTokenEnc: "enc:new-access-token",
      refreshTokenEnc: "enc:new-refresh-token",
      expiresAt: new Date("2026-05-05T18:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          scope: "Calendars.Read",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: [] }),
      });

    vi.setSystemTime(new Date("2026-05-05T16:00:00.000Z"));

    await expect(syncRecorderCalendarSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      now: new Date("2026-05-05T16:00:00.000Z"),
    })).resolves.toMatchObject({ action: "synced", teamsEvents: 0 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
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

  it("rejects recorder transcript ingestion when the recording points across workspaces", async () => {
    const { processMeetingRecorderWebhook } = await import("./meeting-recorders");
    const payload = JSON.stringify({
      id: "event-transcript-1",
      event: "transcript.done",
      data: {
        bot: {
          id: "bot-1",
          metadata: {
            workspaceId: "workspace-1",
            meetingId: "meeting-1",
            recordingId: "recording-1",
          },
        },
        transcript: {
          id: "transcript-1",
          data: {
            download_url: "https://signed.example.com/transcript.json",
          },
        },
      },
    });
    const msgId = "msg_1";
    const timestamp = "1770000000";
    const signature = createHmac("sha256", Buffer.from("recall-secret"))
      .update(`${msgId}.${timestamp}.${payload}`)
      .digest("base64");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "bot-1",
      status: "SCHEDULED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
    };
    prismaMock.meetingRecorderProviderEvent.findUnique.mockResolvedValue(null);
    prismaMock.meetingRecorderProviderEvent.upsert.mockResolvedValue({ id: "provider-event-1" });
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({
        ...recording,
        meeting: { workspaceId: "workspace-2" },
      });
    prismaMock.meetingRecording.update.mockResolvedValue({ ...recording, status: "COMPLETED" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { speaker: "Dana", start: 0, text: "This transcript should not cross workspaces." },
    ]), { status: 200 }));

    await expect(processMeetingRecorderWebhook("RECALL_AI", {
      rawBody: payload,
      headers: {
        "svix-id": msgId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "RECORDER_WORKSPACE_MISMATCH",
    });

    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).not.toHaveBeenCalled();
  });

  it("ignores late transcript webhooks for recorder rows already skipped as duplicates", async () => {
    const { processMeetingRecorderWebhook } = await import("./meeting-recorders");
    const payload = JSON.stringify({
      id: "event-duplicate-transcript-1",
      event: "transcript.done",
      data: {
        bot: {
          id: "bot-duplicate",
          metadata: {
            workspaceId: "workspace-1",
            meetingId: "meeting-1",
            recordingId: "recording-duplicate",
          },
        },
        transcript: {
          id: "transcript-duplicate",
          data: {
            download_url: "https://signed.example.com/duplicate-transcript.json",
          },
        },
      },
    });
    const msgId = "msg_1";
    const timestamp = "1770000000";
    const signature = createHmac("sha256", Buffer.from("recall-secret"))
      .update(`${msgId}.${timestamp}.${payload}`)
      .digest("base64");
    const recording = {
      id: "recording-duplicate",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "bot-duplicate",
      status: "SKIPPED",
      failureCode: "DUPLICATE_RECORDER",
      failureMessage: "Duplicate provider bot was skipped.",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
    };
    prismaMock.meetingRecorderProviderEvent.findUnique.mockResolvedValue(null);
    prismaMock.meetingRecorderProviderEvent.upsert.mockResolvedValue({ id: "provider-event-1" });
    prismaMock.meetingRecorderProviderEvent.update.mockResolvedValue({ id: "provider-event-1" });
    prismaMock.meetingRecording.findUnique.mockResolvedValue(recording);

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
      recordingId: "recording-duplicate",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.meeting.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecorderProviderEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ receivedAt: expect.any(Date) }),
    }));
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

  it("creates a local recording before calling Meeting BaaS for immediate joins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T17:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
        workspaceId: "workspace-1",
        enabled: true,
        defaultProvider: "MEETING_BAAS",
        fallbackProvider: null,
        botName: "Corgtex Recorder",
        entryMessage: "Recording notice",
        autoRecordEnabled: true,
        monthlyMinuteCap: 6000,
      });
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Live meeting",
        recordedAt: new Date("2026-06-24T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participantEmails: ["team@example.com"],
      });
      prismaMock.meetingRecording.create.mockImplementation(async () => {
        expect(fetchMock).not.toHaveBeenCalled();
        return {
          id: "recording-baas",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "MEETING_BAAS",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          status: "PENDING",
        };
      });
      prismaMock.meetingRecording.update.mockResolvedValue({
        id: "recording-baas",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "MEETING_BAAS",
        status: "SCHEDULED",
        externalBotId: "baas-bot-1",
      });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ data: { bot_id: "baas-bot-1" } }) });

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "manual",
      })).resolves.toMatchObject({ id: "recording-baas", status: "SCHEDULED" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.meetingbaas.com/v2/bots");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("join_at");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an active immediate recording without creating another provider bot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T17:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Live meeting",
        recordedAt: new Date("2026-06-24T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participantEmails: ["team@example.com"],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValueOnce({
        id: "recording-active",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-1",
        status: "JOINING",
      });

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "manual",
      })).resolves.toMatchObject({ id: "recording-active", status: "JOINING" });

      expect(prismaMock.meetingRecording.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it("syncs enterprise service status when recorder config changes", async () => {
    const { updateMeetingRecorderConfig } = await import("./meeting-recorders");
    const lastSyncAt = new Date("2026-05-05T18:00:00.000Z");
    prismaMock.workspaceMeetingRecorderConfig.upsert.mockResolvedValue({ enabled: true });
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
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 55 * 60 * 1000),
    });
    prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 1500 } });

    await updateMeetingRecorderConfig(operatorActor, {
      workspaceId: "workspace-1",
      enabled: true,
    });

    expect(prismaMock.workspaceEnterpriseService.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_serviceKey: {
          workspaceId: "workspace-1",
          serviceKey: "MEETING_RECORDER",
        },
      },
      update: expect.objectContaining({
        displayName: "Meeting recorder",
        providerKey: "RECALL_AI",
        healthStatus: "ACTIVE",
        lastSuccessfulSyncAt: lastSyncAt,
        lastError: null,
        usageJson: expect.objectContaining({
          recorder: expect.objectContaining({
            usedSeconds: 1500,
            usedMinutes: 25,
            monthlyMinuteCap: 6000,
            remainingMinutes: 5975,
          }),
        }),
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        serviceKey: "MEETING_RECORDER",
        ownershipMode: "CUSTOMER_MANAGED",
        displayName: "Meeting recorder",
        providerKey: "RECALL_AI",
        healthStatus: "ACTIVE",
      }),
    });
  });

  it("treats internal Corgtex recorder schedules as the primary readiness source without calendar sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
      const meetingAt = new Date("2026-07-21T16:00:00.000Z");
      const scheduledAt = new Date("2026-07-20T11:45:00.000Z");
      const meetingUrl = "https://teams.microsoft.com/meet/12345678901234?p=abc";
      prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue(null);
      prismaMock.meeting.findMany.mockResolvedValue([{
        id: "meeting-1",
        seriesId: null,
        recordedAt: meetingAt,
        scheduledEndAt: new Date(meetingAt.getTime() + 60 * 60 * 1000),
        meetingUrl,
        series: { meetingUrl: null },
        recordings: [{
          status: "SCHEDULED",
          meetingUrl,
          failureCode: null,
        }],
      }]);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{
        id: "recording-1",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-1",
        status: "SCHEDULED",
        scheduledAt,
        joinAt: meetingAt,
        startedAt: null,
        endedAt: null,
        createdAt: scheduledAt,
        updatedAt: scheduledAt,
      }])
        .mockResolvedValueOnce([]);

      const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

      expect(readiness.ready).toBe(true);
      expect(readiness.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "recording_schedule",
          ok: true,
          detail: "1 upcoming Corgtex scheduled meeting(s) already have recorder coverage.",
        }),
        expect.objectContaining({
          key: "provider_proof",
          ok: true,
          detail: "Recent recorder provider proof at 2026-07-20T11:45:00.000Z.",
        }),
      ]));
      expect(readiness.checks.map((check) => check.key)).not.toContain("calendar_source");
      expect(readiness.checks.map((check) => check.key)).not.toContain("worker_sync");
      expect(readiness.calendarSource).toBeNull();
      expect(prismaMock.meetingRecording.findMany.mock.calls[0]?.[0]?.where.OR).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "SCHEDULED",
          externalBotId: { not: null },
          OR: [{ scheduledAt: { gte: new Date("2026-07-20T12:00:00.000Z") } }, { joinAt: { gte: new Date("2026-07-20T12:00:00.000Z") } }],
        }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale successful enterprise health checks when recorder readiness fails", async () => {
    const { syncMeetingRecorderEnterpriseService } = await import("./meeting-recorders");
    const now = new Date("2026-05-06T18:00:00.000Z");
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue(null);

    await syncMeetingRecorderEnterpriseService("workspace-1", now);

    const payload = prismaMock.workspaceEnterpriseService.upsert.mock.calls[0]?.[0];
    expect(payload.update).toMatchObject({
      healthStatus: "NEEDS_SETUP",
      lastHealthCheckAt: now,
      lastSuccessfulHealthCheckAt: null,
      lastSuccessfulSyncAt: null,
    });
    expect(payload.create).toMatchObject({
      ownershipMode: "CUSTOMER_MANAGED",
      healthStatus: "NEEDS_SETUP",
      lastSuccessfulHealthCheckAt: null,
    });
    expect(payload.update).not.toHaveProperty("ownershipMode");
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
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        participantEmails: [],
      });
    prismaMock.meeting.upsert.mockResolvedValue({
      id: "meeting-teams",
      workspaceId: "workspace-1",
      title: "Client sync",
      recordedAt: new Date("2026-05-05T17:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-05T18:00:00.000Z"),
      meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
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
              onlineMeeting: { joinUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc" },
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

  it("requires recent provider proof while optional calendar import can satisfy schedule readiness", async () => {
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
    expect(readiness.checks.find((check) => check.key === "recording_schedule")).toMatchObject({
      ok: true,
      detail: "Optional calendar sync is connected and can import recorder meetings into Corgtex.",
    });
    expect(readiness.checks.map((check) => check.key)).not.toContain("worker_sync");
    expect(readiness.checks.find((check) => check.key === "provider_proof")?.ok).toBe(false);
    expect(readiness.ready).toBe(false);
  });

  it("marks recorder readiness ready from a recent successful real recording", async () => {
    const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      status: "ACTIVE",
      lastSyncAt: recent,
      lastSyncStartedAt: recent,
      lastSyncCompletedAt: recent,
      lastSyncJobId: "job-success",
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 1,
      lastSchedulableEventCount: 1,
      createdAt: recent,
      updatedAt: recent,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([{
        id: "recording-1",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        status: "COMPLETED",
        scheduledAt: recent,
        joinAt: recent,
        startedAt: recent,
        endedAt: recent,
        createdAt: recent,
        updatedAt: recent,
      }])
      .mockResolvedValueOnce([]);

    const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

    expect(readiness.checks.find((check) => check.key === "provider_proof")).toMatchObject({
      ok: true,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.lastSuccessfulRecording).toMatchObject({
      id: "recording-1",
      status: "COMPLETED",
    });
  });

  it("blocks recorder readiness when a provider auth failure is newer than successful proof", async () => {
    const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
    const proofAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const failureAt = new Date(Date.now() - 30 * 60 * 1000);
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      status: "ACTIVE",
      lastSyncAt: proofAt,
      lastSyncStartedAt: proofAt,
      lastSyncCompletedAt: proofAt,
      lastSyncJobId: "job-success",
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 1,
      lastSchedulableEventCount: 1,
      createdAt: proofAt,
      updatedAt: proofAt,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: proofAt,
      completedAt: proofAt,
    });
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "recording-failed",
        provider: "RECALL_AI",
        status: "FAILED",
        failureCode: "vendor_http_error",
        failureMessage: "RECALL_AI returned 401: authentication_failed Invalid API token for region.",
        updatedAt: failureAt,
      }]);

    const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

    expect(readiness.checks.find((check) => check.key === "provider_proof")).toMatchObject({
      ok: false,
      detail: "Recall authentication failed; verify the configured API token and region.",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.lastProviderAuthFailure).toMatchObject({
      id: "recording-failed",
      failureCode: "vendor_http_error",
    });
  });

  it("uses the freshest provider proof when scheduled bot proof is newer than an older smoke", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
      const smokeProofAt = new Date("2026-07-20T10:00:00.000Z");
      const failureAt = new Date("2026-07-20T11:00:00.000Z");
      const scheduledAt = new Date("2026-07-20T11:30:00.000Z");
      const joinAt = new Date("2026-07-21T16:00:00.000Z");
      prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
        id: "source-1",
        workspaceId: "workspace-1",
        provider: "MICROSOFT",
        providerAccountId: "ms-user-1",
        providerAccountEmail: "calendar@customer.test",
        displayName: "Customer Recorder",
        status: "ACTIVE",
        lastSyncAt: smokeProofAt,
        lastSyncStartedAt: smokeProofAt,
        lastSyncCompletedAt: smokeProofAt,
        lastSyncJobId: "job-success",
        lastSyncError: null,
        lastDryRunAt: null,
        lastUpcomingEventCount: 1,
        lastSchedulableEventCount: 1,
        createdAt: smokeProofAt,
        updatedAt: smokeProofAt,
      });
      prismaMock.workflowJob.count.mockResolvedValue(0);
      prismaMock.meetingRecorderSmokeRun.findFirst
        .mockResolvedValueOnce({
          id: "smoke-latest",
          workspaceId: "workspace-1",
          status: "COMPLETED",
          provider: "RECALL_AI",
          createdAt: smokeProofAt,
          completedAt: smokeProofAt,
        })
        .mockResolvedValueOnce({
          id: "smoke-success",
          workspaceId: "workspace-1",
          status: "COMPLETED",
          provider: "RECALL_AI",
          createdAt: smokeProofAt,
          completedAt: smokeProofAt,
        });
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{
          id: "recording-scheduled",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-1",
          status: "SCHEDULED",
          scheduledAt,
          joinAt,
          startedAt: null,
          endedAt: null,
          createdAt: scheduledAt,
          updatedAt: scheduledAt,
        }])
        .mockResolvedValueOnce([{
          id: "recording-failed",
          provider: "RECALL_AI",
          status: "FAILED",
          failureCode: "vendor_http_error",
          failureMessage: "RECALL_AI returned 401: authentication_failed Invalid API token for region.",
          updatedAt: failureAt,
        }]);

      const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

      expect(readiness.checks.find((check) => check.key === "provider_proof")).toMatchObject({
        ok: true,
        detail: "Recent recorder provider proof at 2026-07-20T11:30:00.000Z.",
      });
      expect(readiness.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a recent joining provider update without startedAt as proof", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const { getMeetingRecorderEnterpriseReadiness } = await import("./meeting-recorders");
      const meetingAt = new Date("2026-07-21T16:00:00.000Z");
      const meetingUrl = "https://meet.google.com/abc-defg-hij";
      prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue(null);
      prismaMock.meeting.findMany.mockResolvedValue([{
        id: "meeting-1",
        seriesId: null,
        recordedAt: meetingAt,
        scheduledEndAt: new Date(meetingAt.getTime() + 60 * 60 * 1000),
        meetingUrl,
        series: { meetingUrl: null },
        recordings: [],
      }]);
      prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue(null);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{
          id: "recording-joining",
          workspaceId: "workspace-1",
          meetingId: "meeting-proof",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-joining",
          status: "JOINING",
          scheduledAt: new Date("2026-07-20T11:00:00.000Z"),
          joinAt: new Date("2026-07-20T11:05:00.000Z"),
          startedAt: null,
          endedAt: null,
          createdAt: new Date("2026-07-20T11:00:00.000Z"),
          updatedAt: new Date("2026-07-20T11:50:00.000Z"),
        }])
        .mockResolvedValueOnce([{
          id: "recording-failed",
          provider: "RECALL_AI",
          status: "FAILED",
          failureCode: "vendor_http_error",
          failureMessage: "RECALL_AI returned 401: authentication_failed Invalid API token for region.",
          updatedAt: new Date("2026-07-20T11:30:00.000Z"),
        }]);

      const readiness = await getMeetingRecorderEnterpriseReadiness("workspace-1");

      expect(readiness.checks.find((check) => check.key === "provider_proof")).toMatchObject({
        ok: true,
        detail: "Recent recorder provider proof at 2026-07-20T11:50:00.000Z.",
      });
      expect(readiness.ready).toBe(true);
      expect(prismaMock.meetingRecording.findMany.mock.calls[0]?.[0]?.where.OR).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "JOINING",
          externalBotId: { not: null },
          OR: expect.arrayContaining([
            { updatedAt: { gte: new Date("2026-06-20T12:00:00.000Z") } },
          ]),
        }),
      ]));
      expect(prismaMock.meetingRecording.findMany.mock.calls[0]?.[0]?.take).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an unproven optional calendar sync as a Corgtex recording schedule", async () => {
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

    expect(readiness.checks.find((check) => check.key === "recording_schedule")).toMatchObject({
      ok: false,
      detail: "No upcoming Corgtex scheduled meetings found. Add the meeting to Corgtex before recording; optional calendar sync is not required. calendar@customer.test is active and has not produced recordable meetings.",
    });
    expect(readiness.checks.map((check) => check.key)).not.toContain("worker_sync");
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

  it("retires an active recorder for an old URL before scheduling the current URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: new Date("2026-06-24T19:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
        series: { meetingUrl: null },
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValue(null);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{
          id: "recording-old-url",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-old",
          status: "SCHEDULED",
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=oldcode",
          joinAt: new Date("2026-06-24T19:00:00.000Z"),
        }])
        .mockResolvedValueOnce([]);
      prismaMock.meetingRecording.create.mockResolvedValue({
        id: "recording-new-url",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        status: "PENDING",
      });
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-new" }) });

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).resolves.toMatchObject({
        id: "recording-new-url",
        status: "SCHEDULED",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-old/",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-old-url" },
        data: expect.objectContaining({
          status: "FAILED",
          activeDedupeKey: null,
          failureCode: "MEETING_URL_CHANGED",
        }),
      }));
      expect(prismaMock.meetingRecording.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          meetingId: "meeting-1",
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports upcoming recorder coverage blockers without exposing raw meeting URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    try {
      const { getMeetingRecorderCoverageReadiness } = await import("./meeting-recorders");
      prismaMock.meeting.findMany.mockResolvedValue([
        {
          id: "meeting-no-url",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
          meetingUrl: null,
          series: { meetingUrl: null },
          recordings: [],
        },
        {
          id: "meeting-covered",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T19:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=private-code",
          series: { meetingUrl: null },
          recordings: [{ status: "SCHEDULED", meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=private-code", failureCode: null }],
        },
      ]);

      const readiness = await getMeetingRecorderCoverageReadiness("workspace-1");

      expect(readiness.counts.blockers.no_url).toBe(1);
      expect(readiness.counts.blockers.already_covered).toBe(1);
      expect(readiness.meetings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          meetingId: "meeting-covered",
          urlKind: "MICROSOFT_TEAMS_MEET",
          hasOccurrenceUrl: true,
          blockerReasons: ["already_covered"],
        }),
      ]));
      expect(JSON.stringify(readiness)).not.toContain("12345678901234");
      expect(JSON.stringify(readiness)).not.toContain("private-code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an active recorder for an old URL as current coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    try {
      const { getMeetingRecorderCoverageReadiness } = await import("./meeting-recorders");
      prismaMock.meeting.findMany.mockResolvedValue([
        {
          id: "meeting-url-changed",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T19:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=newcode",
          series: { meetingUrl: null },
          recordings: [{
            status: "SCHEDULED",
            meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=oldcode",
            failureCode: null,
          }],
        },
      ]);

      const readiness = await getMeetingRecorderCoverageReadiness("workspace-1");

      expect(readiness.counts.eligible).toBe(1);
      expect(readiness.counts.blockers.already_covered).toBe(0);
      expect(readiness.meetings[0]).toMatchObject({
        meetingId: "meeting-url-changed",
        hasRecorderCoverage: false,
        blockerReasons: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block primary scheduling when only the fallback provider config is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    const { env } = await import("@corgtex/shared");
    const mutableEnv = env as unknown as { MEETING_BAAS_API_KEY: string; MEETING_BAAS_WEBHOOK_SECRET: string };
    const originalBaasKey = mutableEnv.MEETING_BAAS_API_KEY;
    const originalBaasSecret = mutableEnv.MEETING_BAAS_WEBHOOK_SECRET;
    try {
      mutableEnv.MEETING_BAAS_API_KEY = "";
      mutableEnv.MEETING_BAAS_WEBHOOK_SECRET = "";
      const { getMeetingRecorderCoverageReadiness } = await import("./meeting-recorders");
      prismaMock.meeting.findMany.mockResolvedValue([
        {
          id: "meeting-primary-ready",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T19:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
          series: { meetingUrl: null },
          recordings: [],
        },
      ]);

      const readiness = await getMeetingRecorderCoverageReadiness("workspace-1");

      expect(readiness.providerChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "meeting_baas_api_key", ok: false }),
      ]));
      expect(readiness.providerConfigOk).toBe(true);
      expect(readiness.counts.eligible).toBe(1);
      expect(readiness.counts.blockers.no_provider_config).toBe(0);
    } finally {
      mutableEnv.MEETING_BAAS_API_KEY = originalBaasKey;
      mutableEnv.MEETING_BAAS_WEBHOOK_SECRET = originalBaasSecret;
      vi.useRealTimers();
    }
  });

  it("requires completed smoke proof before support enables auto-recording", async () => {
    const { setMeetingRecorderAutoRecordingForSupport } = await import("./meeting-recorders");

    await expect(setMeetingRecorderAutoRecordingForSupport("workspace-1", true)).rejects.toMatchObject({
      status: 400,
      code: "RECORDER_SMOKE_REQUIRED",
    });

    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).not.toHaveBeenCalled();
  });

  it("allows support to disable auto-recording without smoke proof", async () => {
    const { setMeetingRecorderAutoRecordingForSupport } = await import("./meeting-recorders");
    prismaMock.workspaceMeetingRecorderConfig.upsert.mockResolvedValue({
      workspaceId: "workspace-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      autoRecordEnabled: false,
      monthlyMinuteCap: 6000,
    });

    const result = await setMeetingRecorderAutoRecordingForSupport("workspace-1", false);

    expect(prismaMock.meetingRecorderSmokeRun.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { autoRecordEnabled: false },
    }));
    expect(result.autoRecordEnabled).toBe(false);
  });

  it("allows support to enable auto-recording after completed smoke proof", async () => {
    const { setMeetingRecorderAutoRecordingForSupport } = await import("./meeting-recorders");
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      createdAt: new Date("2026-06-24T15:00:00.000Z"),
    });
    prismaMock.workspaceMeetingRecorderConfig.upsert.mockResolvedValue({
      workspaceId: "workspace-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      botName: "Corgtex Recorder",
      entryMessage: "Recording notice",
      autoRecordEnabled: true,
      monthlyMinuteCap: 6000,
    });

    const result = await setMeetingRecorderAutoRecordingForSupport("workspace-1", true);

    expect(prismaMock.meetingRecorderSmokeRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        status: "COMPLETED",
      },
    }));
    expect(result.autoRecordEnabled).toBe(true);
  });

  it("ensures upcoming recorder coverage once and skips already covered meetings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    try {
      const { ensureUpcomingScheduledMeetingRecorderCoverage } = await import("./meeting-recorders");
      prismaMock.meeting.findMany.mockResolvedValue([
        {
          id: "meeting-eligible",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T17:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
          meetingUrl: null,
          series: { meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc" },
          recordings: [],
        },
        {
          id: "meeting-covered",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T19:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
          series: { meetingUrl: null },
          recordings: [{ status: "SCHEDULED", meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc", failureCode: null }],
        },
      ]);
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-eligible",
        title: "Weekly",
        recordedAt: new Date("2026-06-24T17:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T18:00:00.000Z"),
        meetingUrl: null,
        series: { meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc" },
        participantEmails: [],
      });
      prismaMock.meetingRecording.create.mockResolvedValue({
        id: "recording-eligible",
        workspaceId: "workspace-1",
        meetingId: "meeting-eligible",
        provider: "RECALL_AI",
        status: "PENDING",
      });
      prismaMock.meetingRecording.update.mockResolvedValue({
        id: "recording-eligible",
        workspaceId: "workspace-1",
        meetingId: "meeting-eligible",
        provider: "RECALL_AI",
        status: "SCHEDULED",
        externalBotId: "recall-bot-1",
      });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-1" }) });

      await expect(ensureUpcomingScheduledMeetingRecorderCoverage("workspace-1")).resolves.toMatchObject({
        scheduled: 1,
        providerSchedulingFailed: 0,
        attemptedMeetingIds: ["meeting-eligible"],
        counts: {
          eligible: 1,
          blockers: expect.objectContaining({ already_covered: 1 }),
        },
      });

      expect(prismaMock.meetingRecording.create).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans stale active recordings before scheduling replacement coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T16:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-stale",
          workspaceId: "workspace-1",
          meetingId: "meeting-eligible",
          provider: "RECALL_AI",
          status: "PENDING",
          externalBotId: null,
          createdAt: new Date("2026-06-24T08:00:00.000Z"),
          joinAt: null,
          meeting: {
            recordedAt: new Date("2026-06-24T19:00:00.000Z"),
            scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          },
        }]);
      prismaMock.meeting.findMany.mockResolvedValue([
        {
          id: "meeting-eligible",
          seriesId: "series-1",
          recordedAt: new Date("2026-06-24T19:00:00.000Z"),
          scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
          meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
          series: { meetingUrl: null },
          recordings: [{
            status: "FAILED",
            meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
            failureCode: "STALE_RECORDER",
          }],
        },
      ]);
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-eligible",
        title: "Weekly",
        recordedAt: new Date("2026-06-24T19:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-24T20:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/meet/12345678901234?p=abc",
        series: { meetingUrl: null },
        participantEmails: [],
      });
      prismaMock.meetingRecording.create.mockResolvedValue({
        id: "recording-replacement",
        workspaceId: "workspace-1",
        meetingId: "meeting-eligible",
        provider: "RECALL_AI",
        status: "PENDING",
      });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-replacement" }) });
      prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "PENDING" } as any);

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 1,
        scheduledUpcomingRecorders: 1,
      });

      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-stale" },
        data: expect.objectContaining({ failureCode: "STALE_RECORDER" }),
      }));
      expect(prismaMock.meetingRecording.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ meetingId: "meeting-eligible" }),
      }));
      expect(prismaMock.meetingRecording.update.mock.invocationCallOrder[0]).toBeLessThan(
        prismaMock.meetingRecording.create.mock.invocationCallOrder[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks stale active recordings failed during reconciliation", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "recording-stale",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        status: "SCHEDULED",
        externalBotId: null,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
        meeting: {
          recordedAt: new Date("2026-05-04T16:00:00.000Z"),
          scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
        },
      }]);
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-stale", status: "FAILED" });
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "SCHEDULED" } as any);
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 2 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 1, recoveredTranscripts: 0 });

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

  it("marks Recall terminal failures visible before stale timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T15:55:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-low-credit",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          status: "SCHEDULED",
          externalBotId: "recall-bot-low-credit",
          joinAt: new Date("2026-06-24T16:00:00.000Z"),
          createdAt: new Date("2026-06-24T15:45:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-06-24T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-06-24T17:00:00.000Z"),
          },
        }]);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        status_changes: [{
          code: "fatal",
          sub_code: "insufficient_credit_balance",
          message: "Recall account has insufficient credit balance.",
        }],
      }), { status: 200 }));
      prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-low-credit", status: "FAILED" });
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        terminalFailed: 1,
        staleFailed: 0,
        recoveredTranscripts: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-low-credit/",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-low-credit" },
        data: expect.objectContaining({
          status: "FAILED",
          activeDedupeKey: null,
          failureCode: "insufficient_credit_balance",
          failureMessage: "Recall account has insufficient credit balance.",
          endedAt: expect.any(Date),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark future scheduled provider bots stale based on creation time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-future",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-future",
          status: "SCHEDULED",
          joinAt: new Date("2026-06-03T16:00:00.000Z"),
          createdAt: new Date("2026-05-13T16:00:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-06-03T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
          },
        }]);
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 0,
        recoveredTranscripts: 0,
      });

      expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks past provider-backed stale recordings failed after cancelling the bot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-stale-provider",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-stale",
          status: "RECORDING",
          joinAt: new Date("2026-05-26T16:00:00.000Z"),
          createdAt: new Date("2026-05-26T15:50:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-05-26T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-05-26T17:00:00.000Z"),
          },
        }]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-stale-provider", status: "FAILED" });
      prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "RECORDING" } as any);
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 1,
        recoveredTranscripts: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-stale/leave_call/",
        expect.objectContaining({ method: "POST" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-stale-provider" },
        data: expect.objectContaining({
          status: "FAILED",
          activeDedupeKey: null,
          failureCode: "STALE_RECORDER",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the recorder join time when a rescheduled meeting leaves an old bot stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-rescheduled-stale",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-rescheduled",
          status: "SCHEDULED",
          joinAt: new Date("2026-05-20T16:00:00.000Z"),
          createdAt: new Date("2026-05-20T15:50:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-06-03T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
          },
        }]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-rescheduled-stale", status: "FAILED" });
      prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "SCHEDULED" } as any);
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 1,
        recoveredTranscripts: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-rescheduled/leave_call/",
        expect.objectContaining({ method: "POST" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-rescheduled-stale" },
        data: expect.objectContaining({
          status: "FAILED",
          activeDedupeKey: null,
          failureCode: "STALE_RECORDER",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel provider-backed recordings that overrun the scheduled end inside the stale timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T18:30:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-overrun",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          externalBotId: "recall-bot-overrun",
          status: "RECORDING",
          joinAt: new Date("2026-05-26T16:00:00.000Z"),
          createdAt: new Date("2026-05-26T15:50:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-05-26T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-05-26T17:00:00.000Z"),
          },
        }]);
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 0,
        recoveredTranscripts: 0,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats already-missing Meeting BaaS stale bots as cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "recording-baas-stale",
          workspaceId: "workspace-1",
          meetingId: "meeting-1",
          provider: "MEETING_BAAS",
          externalBotId: "baas-bot-missing",
          status: "SCHEDULED",
          joinAt: new Date("2026-05-26T16:00:00.000Z"),
          createdAt: new Date("2026-05-26T15:50:00.000Z"),
          meeting: {
            recordedAt: new Date("2026-05-26T16:00:00.000Z"),
            scheduledEndAt: new Date("2026-05-26T17:00:00.000Z"),
          },
        }]);
      fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
      prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-baas-stale", status: "FAILED" });
      prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "SCHEDULED" } as any);
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 1,
        recoveredTranscripts: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.meetingbaas.com/v2/bots/baas-bot-missing",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-baas-stale" },
        data: expect.objectContaining({
          status: "FAILED",
          failureCode: "STALE_RECORDER",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels duplicate future provider bots with Recall delete and restores one canonical row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      const meeting = {
        recordedAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
      };
      const canonical = {
        id: "recording-canonical",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-canonical",
        activeDedupeKey: null,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt: meeting.recordedAt,
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
        meeting,
      };
      const duplicate = {
        ...canonical,
        id: "recording-duplicate",
        externalBotId: "recall-bot-duplicate",
        scheduledAt: new Date("2026-05-13T12:00:00.000Z"),
        createdAt: new Date("2026-05-13T12:00:00.000Z"),
      };
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([canonical, duplicate])
        .mockResolvedValueOnce([]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...(where.id === canonical.id ? canonical : duplicate),
        ...data,
      }));
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 0,
        duplicateProviderBotsCancelled: 1,
        duplicateRecordersSkipped: 1,
        canonicalRecordingsRestored: 1,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-duplicate/",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-duplicate/leave_call/",
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-duplicate" },
        data: expect.objectContaining({
          status: "SKIPPED",
          activeDedupeKey: null,
          failureCode: "DUPLICATE_RECORDER",
        }),
      }));
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-canonical" },
        data: expect.objectContaining({
          status: "SCHEDULED",
          activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
          failureCode: null,
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore an obsolete duplicate group over an existing active recorder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      const currentMeeting = {
        recordedAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
      };
      const oldMeeting = {
        recordedAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
      };
      const currentActive = {
        id: "recording-current-active",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: null,
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
        status: "PENDING",
        failureCode: null,
        failureMessage: null,
        joinAt: currentMeeting.recordedAt,
        scheduledAt: new Date("2026-05-27T12:00:00.000Z"),
        endedAt: null,
        createdAt: new Date("2026-05-27T12:00:00.000Z"),
        meeting: currentMeeting,
      };
      const oldCanonical = {
        ...currentActive,
        id: "recording-old-canonical",
        externalBotId: "recall-bot-old-canonical",
        activeDedupeKey: null,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt: new Date("2026-05-20T16:00:00.000Z"),
        scheduledAt: new Date("2026-05-13T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-13T12:00:00.000Z"),
        meeting: oldMeeting,
      };
      const oldDuplicate = {
        ...oldCanonical,
        id: "recording-old-duplicate",
        externalBotId: "recall-bot-old-duplicate",
        scheduledAt: new Date("2026-05-13T11:50:00.000Z"),
        createdAt: new Date("2026-05-13T11:50:00.000Z"),
      };
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([currentActive, oldCanonical, oldDuplicate])
        .mockResolvedValueOnce([]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...[currentActive, oldCanonical, oldDuplicate].find((recording) => recording.id === where.id),
        ...data,
      }));
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 0,
        duplicateProviderBotsCancelled: 1,
        duplicateRecordersSkipped: 1,
        canonicalRecordingsRestored: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-old-duplicate/leave_call/",
        expect.objectContaining({ method: "POST" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-old-duplicate" },
        data: expect.objectContaining({
          status: "SKIPPED",
          activeDedupeKey: null,
          failureCode: "DUPLICATE_RECORDER",
        }),
      }));
      expect(prismaMock.meetingRecording.update).not.toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-old-canonical" },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels near-join duplicate provider bots with Recall leave call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T15:55:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      const meeting = {
        recordedAt: new Date("2026-05-27T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-27T17:00:00.000Z"),
      };
      const canonical = {
        id: "recording-near-canonical",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-near-canonical",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
        status: "SCHEDULED",
        failureCode: null,
        failureMessage: null,
        joinAt: meeting.recordedAt,
        scheduledAt: new Date("2026-05-27T15:45:00.000Z"),
        endedAt: null,
        createdAt: new Date("2026-05-27T15:45:00.000Z"),
        meeting,
      };
      const duplicate = {
        ...canonical,
        id: "recording-near-duplicate",
        externalBotId: "recall-bot-near-duplicate",
        activeDedupeKey: null,
        scheduledAt: new Date("2026-05-27T15:40:00.000Z"),
        createdAt: new Date("2026-05-27T15:40:00.000Z"),
      };
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([canonical, duplicate])
        .mockResolvedValueOnce([]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...(where.id === canonical.id ? canonical : duplicate),
        ...data,
      }));
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        staleFailed: 0,
        duplicateProviderBotsCancelled: 1,
        duplicateRecordersSkipped: 1,
        canonicalRecordingsRestored: 0,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-near-duplicate/leave_call/",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-near-duplicate/",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an in-flight canonical recorder status during duplicate cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T16:02:00.000Z"));
    try {
      const { reconcileMeetingRecorders } = await import("./meeting-recorders");
      const meeting = {
        recordedAt: new Date("2026-05-27T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-27T17:00:00.000Z"),
      };
      const canonical = {
        id: "recording-live-canonical",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-live-canonical",
        activeDedupeKey: null,
        status: "RECORDING",
        failureCode: null,
        failureMessage: null,
        joinAt: meeting.recordedAt,
        scheduledAt: new Date("2026-05-27T15:45:00.000Z"),
        endedAt: null,
        createdAt: new Date("2026-05-27T15:45:00.000Z"),
        meeting,
      };
      const duplicate = {
        ...canonical,
        id: "recording-live-duplicate",
        externalBotId: "recall-bot-live-duplicate",
        status: "JOINING",
        scheduledAt: new Date("2026-05-27T15:40:00.000Z"),
        createdAt: new Date("2026-05-27T15:40:00.000Z"),
      };
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([canonical, duplicate])
        .mockResolvedValueOnce([]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...(where.id === canonical.id ? canonical : duplicate),
        ...data,
      }));
      prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

      await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
        duplicateProviderBotsCancelled: 1,
        duplicateRecordersSkipped: 1,
        canonicalRecordingsRestored: 1,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://us-west-2.recall.ai/api/v1/bot/recall-bot-live-duplicate/leave_call/",
        expect.objectContaining({ method: "POST" }),
      );
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-live-canonical" },
        data: expect.objectContaining({
          status: "RECORDING",
          activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a future canonical provider bot instead of creating another bot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      const reusable = {
        id: "recording-reusable",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-reusable",
        activeDedupeKey: null,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      };
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValueOnce(null);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([reusable]);
      prismaMock.meetingRecording.update.mockResolvedValue({
        ...reusable,
        status: "SCHEDULED",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
        failureCode: null,
        failureMessage: null,
        endedAt: null,
      });

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).resolves.toMatchObject({
        id: "recording-reusable",
        status: "SCHEDULED",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
      });

      expect(prismaMock.meetingRecording.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prismaMock.meetingRecording.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: expect.objectContaining({
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        }),
      }));
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-reusable" },
        data: expect.objectContaining({
          status: "SCHEDULED",
          activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a stale provider bot from a previous meeting URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      const currentUrl = "https://teams.microsoft.com/l/meetup-join/new";
      const oldReusable = {
        id: "recording-old-url",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-old-url",
        activeDedupeKey: null,
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/old",
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      };
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: oldReusable.joinAt,
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        meetingUrl: currentUrl,
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValueOnce(null);
      prismaMock.meetingRecording.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (
        "NOT" in where || where.meetingUrl === currentUrl ? [] : [oldReusable]
      ));
      prismaMock.meetingRecording.create.mockResolvedValue({
        id: "recording-new-url",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        meetingUrl: currentUrl,
        status: "PENDING",
      });
      prismaMock.meetingRecording.update.mockResolvedValue({
        id: "recording-new-url",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-new-url",
        meetingUrl: currentUrl,
        status: "SCHEDULED",
      });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "recall-bot-new-url" }) });

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).resolves.toMatchObject({
        id: "recording-new-url",
        externalBotId: "recall-bot-new-url",
      });

      expect(prismaMock.meetingRecording.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ meetingUrl: currentUrl }),
      }));
      expect(prismaMock.meetingRecording.update).not.toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-old-url" },
      }));
      expect(prismaMock.meetingRecording.create).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a future fallback provider bot instead of scheduling another after primary failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      const joinAt = new Date("2026-06-03T16:00:00.000Z");
      const meetingUrl = "https://teams.microsoft.com/l/meetup-join/abc";
      const primaryAttempt = {
        id: "recording-primary-failed",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        meetingUrl,
        status: "PENDING",
      };
      const fallbackReusable = {
        id: "recording-fallback-reusable",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "MEETING_BAAS",
        externalBotId: "baas-bot-reusable",
        activeDedupeKey: null,
        meetingUrl,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt,
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      };
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: joinAt,
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        meetingUrl,
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValueOnce(null);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([fallbackReusable]);
      prismaMock.meetingRecording.create.mockResolvedValueOnce(primaryAttempt);
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...(where.id === primaryAttempt.id ? primaryAttempt : fallbackReusable),
        ...data,
      }));
      fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).resolves.toMatchObject({
        id: "recording-fallback-reusable",
        provider: "MEETING_BAAS",
        status: "SCHEDULED",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:MEETING_BAAS",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(prismaMock.meetingRecording.findMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
        where: expect.objectContaining({
          provider: "MEETING_BAAS",
          meetingUrl,
          joinAt,
        }),
      }));
      expect(prismaMock.meetingRecording.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "recording-fallback-reusable" },
        data: expect.objectContaining({
          status: "SCHEDULED",
          activeDedupeKey: "meeting-recording:workspace-1:meeting-1:MEETING_BAAS",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the monthly cap before reusing a stale future provider bot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      const reusable = {
        id: "recording-reusable",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        externalBotId: "recall-bot-reusable",
        activeDedupeKey: null,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        joinAt: new Date("2026-06-03T16:00:00.000Z"),
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      };
      prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
        workspaceId: "workspace-1",
        enabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: "MEETING_BAAS",
        botName: "Corgtex Recorder",
        entryMessage: "Recording notice",
        autoRecordEnabled: true,
        monthlyMinuteCap: 10,
      });
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: reusable.joinAt,
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst.mockResolvedValueOnce(null);
      prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 10 * 60 } });
      prismaMock.meetingRecording.findMany.mockResolvedValueOnce([reusable]);

      await expect(scheduleMeetingRecording(facilitatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).rejects.toMatchObject({
        code: "RECORDER_MONTHLY_CAP_EXCEEDED",
      });

      expect(prismaMock.meetingRecording.findMany).not.toHaveBeenCalled();
      expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the post-cleanup reuse lookup scoped to the requested join time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    try {
      const { scheduleMeetingRecording } = await import("./meeting-recorders");
      const requestedJoinAt = new Date("2026-06-03T16:00:00.000Z");
      const oldJoinAt = new Date("2026-05-20T16:00:00.000Z");
      const baseRecording = {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        provider: "RECALL_AI",
        activeDedupeKey: null,
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        failureMessage: "stale",
        scheduledAt: new Date("2026-05-20T12:00:00.000Z"),
        endedAt: new Date("2026-05-20T18:00:00.000Z"),
        createdAt: new Date("2026-05-20T12:00:00.000Z"),
      };
      const requestedCanonical = {
        ...baseRecording,
        id: "recording-requested-canonical",
        externalBotId: "recall-bot-requested-canonical",
        joinAt: requestedJoinAt,
        meeting: {
          recordedAt: requestedJoinAt,
          scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        },
      };
      const requestedDuplicate = {
        ...requestedCanonical,
        id: "recording-requested-duplicate",
        externalBotId: "recall-bot-requested-duplicate",
        scheduledAt: new Date("2026-05-13T12:00:00.000Z"),
        createdAt: new Date("2026-05-13T12:00:00.000Z"),
      };
      const oldCanonical = {
        ...baseRecording,
        id: "recording-old-canonical",
        externalBotId: "recall-bot-old-canonical",
        joinAt: oldJoinAt,
        meeting: {
          recordedAt: oldJoinAt,
          scheduledEndAt: new Date("2026-05-20T17:00:00.000Z"),
        },
      };
      const oldDuplicate = {
        ...oldCanonical,
        id: "recording-old-duplicate",
        externalBotId: "recall-bot-old-duplicate",
        scheduledAt: new Date("2026-05-13T12:00:00.000Z"),
        createdAt: new Date("2026-05-13T12:00:00.000Z"),
      };
      const requestedActive = {
        ...requestedCanonical,
        status: "SCHEDULED",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
      };
      const oldActive = {
        ...oldCanonical,
        status: "SCHEDULED",
        activeDedupeKey: "meeting-recording:workspace-1:meeting-1:RECALL_AI",
      };
      prismaMock.meeting.findFirst.mockResolvedValue({
        id: "meeting-1",
        title: "Weekly",
        recordedAt: requestedJoinAt,
        scheduledEndAt: new Date("2026-06-03T17:00:00.000Z"),
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        participantEmails: [],
      });
      prismaMock.meetingRecording.findFirst
        .mockResolvedValueOnce(null)
        .mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
          return where.joinAt === requestedJoinAt ? requestedActive : oldActive;
        });
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([requestedCanonical, requestedDuplicate])
        .mockResolvedValueOnce([requestedCanonical, requestedDuplicate, oldCanonical, oldDuplicate]);
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...[requestedCanonical, requestedDuplicate, oldCanonical, oldDuplicate].find((recording) => recording.id === where.id),
        ...data,
      }));

      await expect(scheduleMeetingRecording(operatorActor, {
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        mode: "auto",
      })).resolves.toMatchObject({
        id: "recording-requested-canonical",
        joinAt: requestedJoinAt,
      });

      expect(prismaMock.meetingRecording.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: expect.objectContaining({
          externalBotId: { not: null },
          joinAt: requestedJoinAt,
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
          status: { in: ["PENDING", "SCHEDULED", "JOINING", "RECORDING"] },
        }),
      }));
      expect(prismaMock.meetingRecording.findMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
        where: expect.objectContaining({
          meetingId: "meeting-1",
          provider: "RECALL_AI",
          joinAt: requestedJoinAt,
          OR: expect.arrayContaining([
            expect.objectContaining({ meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc" }),
          ]),
        }),
      }));
      expect(prismaMock.meetingRecording.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
      .mockResolvedValueOnce({
        ...recording,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
      });
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

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 1 });

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
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

  it("recovers one transcript from duplicate completed Recall bots and skips the others", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly progress",
      source: "internal",
      status: "COMPLETED",
      recordedAt: new Date("2026-05-04T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      transcript: null,
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
    };
    const recording = {
      id: "recording-canonical",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-canonical",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      scheduledAt: new Date("2026-05-04T15:55:00.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    const duplicate = {
      ...recording,
      id: "recording-duplicate",
      externalBotId: "recall-bot-duplicate",
      scheduledAt: new Date("2026-05-04T15:50:00.000Z"),
      createdAt: new Date("2026-05-04T15:50:00.000Z"),
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([recording, duplicate])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce(recording)
      .mockResolvedValueOnce({
        ...recording,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
      });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-canonical/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-canonical",
          status: "done",
          recordings: [{
            id: "recall-recording-1",
            status: "done",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/duplicate-transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.endsWith("/api/v1/bot/recall-bot-duplicate/")) {
        throw new Error("duplicate bot should not be fetched after canonical recovery");
      }
      if (value.startsWith("https://signed.example.com/duplicate-transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "Only one duplicate transcript should be ingested." },
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
      transcript: "Dana [00:00:00]: Only one duplicate transcript should be ingested.",
    });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-canonical", status: "COMPLETED" });
    prismaMock.meetingRecording.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
      staleFailed: 0,
      recoveredTranscripts: 1,
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-duplicate" },
      data: expect.objectContaining({
        status: "SKIPPED",
        activeDedupeKey: null,
        failureCode: "DUPLICATE_RECORDER",
      }),
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "https://us-west-2.recall.ai/api/v1/bot/recall-bot-duplicate/",
    );
  });

  it("continues duplicate Recall recovery after an empty transcript artifact", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const meeting = {
      id: "meeting-1",
      workspaceId: "workspace-1",
      title: "Weekly progress",
      source: "internal",
      status: "COMPLETED",
      recordedAt: new Date("2026-05-04T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      transcript: null,
      summaryMd: null,
      ingestionGuidanceMd: null,
      participantIds: [],
      participantEmails: [],
    };
    const empty = {
      id: "recording-empty",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-empty",
      status: "COMPLETED",
      transcriptProcessedAt: null,
      joinAt: new Date("2026-05-04T16:00:00.000Z"),
      startedAt: new Date("2026-05-04T16:00:30.000Z"),
      scheduledAt: new Date("2026-05-04T15:55:00.000Z"),
      createdAt: new Date("2026-05-04T15:55:00.000Z"),
      meeting: {
        recordedAt: new Date("2026-05-04T16:00:00.000Z"),
        scheduledEndAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    };
    const good = {
      ...empty,
      id: "recording-good",
      externalBotId: "recall-bot-good",
      scheduledAt: new Date("2026-05-04T15:50:00.000Z"),
      createdAt: new Date("2026-05-04T15:50:00.000Z"),
    };
    prismaMock.meetingRecording.findMany
      .mockResolvedValueOnce([empty, good])
      .mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({
        ...empty,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
      })
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce({
        ...good,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
      });
    prismaMock.meetingRecording.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const id = where.id as { not?: string } | undefined;
      if (id?.not === good.id && !Object.prototype.hasOwnProperty.call(where, "failureCode")) {
        return { id: empty.id };
      }
      return null;
    });
    fetchMock.mockImplementation(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/api/v1/bot/recall-bot-empty/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-empty",
          status: "done",
          recordings: [{
            id: "recall-recording-empty",
            status: "done",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/empty-transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.endsWith("/api/v1/bot/recall-bot-good/")) {
        return new Response(JSON.stringify({
          id: "recall-bot-good",
          status: "done",
          recordings: [{
            id: "recall-recording-good",
            status: "done",
            media_shortcuts: {
              transcript: {
                data: {
                  download_url: "https://signed.example.com/good-transcript.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
                },
              },
            },
          }],
        }), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/empty-transcript.json")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (value.startsWith("https://signed.example.com/good-transcript.json")) {
        return new Response(JSON.stringify([
          { speaker: "Dana", start: 0, text: "The later duplicate transcript had the usable content." },
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
      transcript: "Dana [00:00:00]: The later duplicate transcript had the usable content.",
    });
    prismaMock.meetingInsight.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      ...(where.id === empty.id ? empty : good),
      ...data,
    }));
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({
      staleFailed: 0,
      recoveredTranscripts: 1,
    });

    expect(prismaMock.meeting.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.meetingRecording.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { not: good.id },
        transcriptProcessedAt: { not: null },
        failureCode: null,
      }),
    }));
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: empty.id },
      data: expect.objectContaining({
        status: "COMPLETED",
        failureCode: "RECORDER_TRANSCRIPT_EMPTY",
      }),
    });
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: good.id },
      data: expect.objectContaining({
        status: "COMPLETED",
        transcriptProcessedAt: expect.any(Date),
        failureCode: null,
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
      .mockResolvedValueOnce({
        ...recording,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
      });
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

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 1 });

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

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 0 });

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
        meeting: { workspaceId: "workspace-1" },
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

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 0 });

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
        ...recording,
        meeting: { workspaceId: "workspace-1" },
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

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 0 });

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
      .mockResolvedValueOnce({
        ...recording,
        meeting: { workspaceId: "workspace-1" },
        transcriptProcessedAt: null,
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
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    prismaMock.meetingRecording.update.mockResolvedValue({ id: "recording-1", status: "COMPLETED" });
    prismaMock.meetingRecorderProviderEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileMeetingRecorders("workspace-1")).resolves.toMatchObject({ staleFailed: 0, recoveredTranscripts: 0 });

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
  it("terminalizes successfully cancelled stale recordings and their smoke runs", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "RECORDING",
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([recording]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "RECORDING" });
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "FAILED",
        failureCode: "STALE_RECORDER",
        activeDedupeKey: null,
      }),
    });
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ recordingId: "recording-1" }),
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("terminalizes failed cancellation stale recordings without retry", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "RECORDING",
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([recording]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ transcriptProcessedAt: null, status: "RECORDING" });
    fetchMock.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "FAILED",
        failureCode: "STALE_RECORDER",
      }),
    });
  });

  it("retries transcript fetch for retryable errors inside 24h", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: null });
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("marks transcript fetch as permanently failed for non-retryable errors", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: null, status: "COMPLETED" });
    fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock")]),
      expect.any(String)
    );
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: "RECORDER_TRANSCRIPT_FETCH_FAILED",
        transcriptProcessedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ recordingId: "recording-1" }),
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("terminalizes expired transcript recovery without provider call", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = { id: "recording-1", workspaceId: "workspace-1", meetingId: "meeting-1", provider: "RECALL_AI", externalBotId: "recall-bot-1", status: "COMPLETED", createdAt: new Date(1), joinAt: new Date(1), meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: null, status: "COMPLETED" });

    await reconcileMeetingRecorders("workspace-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock")]),
      expect.any(String)
    );
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith({
      where: { id: "recording-1" },
      data: expect.objectContaining({
        status: "FAILED",
        activeDedupeKey: null,
        failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED",
        transcriptProcessedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ recordingId: "recording-1" }),
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("protects expiry terminalization against late successful webhook races", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: new Date(), status: "COMPLETED" });

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock")]),
      expect.any(String)
    );
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).not.toHaveBeenCalled();
  });

  it("protects expiry terminalization against in-flight webhook claims (unprocessed transcript.done event)", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = { id: "recording-1", workspaceId: "workspace-1", meetingId: "meeting-1", provider: "RECALL_AI", externalBotId: "recall-bot-1", status: "COMPLETED", createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000), joinAt: new Date(Date.now() - 26 * 60 * 60 * 1000), meeting: { recordedAt: new Date(Date.now() - 26 * 60 * 60 * 1000), scheduledEndAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: null, status: "COMPLETED" });
    prismaMock.meetingRecorderProviderEvent.findFirst.mockResolvedValue({ id: "event-1" } as any);
    await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecorderProviderEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ eventType: "transcript.done", processedAt: null, recordingId: "recording-1" }) }));
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).not.toHaveBeenCalled();
  });


  it("protects permanent failure terminalization against late successful webhook races", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique
      .mockResolvedValueOnce({ ...recording, transcriptProcessedAt: null, status: "COMPLETED" })
      .mockResolvedValueOnce({ ...recording, transcriptProcessedAt: new Date(), status: "COMPLETED" });
    fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock")]),
      expect.any(String)
    );
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).not.toHaveBeenCalled();
  });

  it("leaves transient transport failures recoverable", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    const recording = {
      id: "recording-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      provider: "RECALL_AI",
      externalBotId: "recall-bot-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      joinAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      meeting: {
        recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        scheduledEndAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    };
    prismaMock.meetingRecording.findMany.mockResolvedValueOnce([recording]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.meetingRecording.findUnique.mockResolvedValue({ ...recording, transcriptProcessedAt: null, status: "COMPLETED" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await reconcileMeetingRecorders("workspace-1");

    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("does not retry terminalized recordings in subsequent reconciliations using a stateful two-pass mock", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    
    let mockDb = [
      { id: "recording-stale", workspaceId: "workspace-1", meetingId: "meeting-stale", provider: "MEETING_BAAS", externalBotId: "bot-stale", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(Date.now() - 36000000), joinAt: new Date(Date.now() - 36000000), transcriptProcessedAt: null, meeting: { recordedAt: new Date(Date.now() - 36000000), scheduledEndAt: new Date(Date.now() - 32400000) } },
      { id: "recording-expired", workspaceId: "workspace-1", meetingId: "meeting-expired", provider: "RECALL_AI", externalBotId: "bot-expired", status: "COMPLETED", activeDedupeKey: null, createdAt: new Date(Date.now() - 93600000), joinAt: new Date(Date.now() - 93600000), transcriptProcessedAt: null, meeting: { recordedAt: new Date(Date.now() - 93600000), scheduledEndAt: new Date(Date.now() - 90000000) } },
      { id: "recording-permanent", workspaceId: "workspace-1", meetingId: "meeting-permanent", provider: "RECALL_AI", externalBotId: "bot-permanent", status: "COMPLETED", activeDedupeKey: null, createdAt: new Date(Date.now() - 7200000), joinAt: new Date(Date.now() - 7200000), transcriptProcessedAt: null, meeting: { recordedAt: new Date(Date.now() - 7200000), scheduledEndAt: new Date(Date.now() - 3600000) } }
    ];

    prismaMock.meetingRecording.findMany.mockImplementation(async (q: any) => mockDb.filter((r) => q.where?.transcriptProcessedAt === null ? (r.transcriptProcessedAt === null && r.provider === "RECALL_AI" && (!q.where.OR || q.where.OR.some((c: any) => c.status?.in?.includes(r.status) || (c.status === "FAILED" && c.failureCode === "STALE_RECORDER" && r.status === "FAILED" && (r as any).failureCode === "STALE_RECORDER")))) : (q.where?.status?.in ? q.where.status.in.includes(r.status) : false)));

    prismaMock.meetingRecording.findUnique.mockImplementation(async (args: any) => {
      return mockDb.find(r => r.id === args.where.id) || null;
    });

    prismaMock.meetingRecording.update.mockImplementation(async (args: any) => {
      const idx = mockDb.findIndex(r => r.id === args.where.id);
      if (idx !== -1) {
        mockDb[idx] = { ...mockDb[idx], ...args.data };
      }
      return mockDb[idx];
    });

    // Mock permanent failure fetch
    fetchMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes("bot-permanent")) {
        return Promise.resolve(new Response("Forbidden", { status: 403 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    // Pass 1: should terminalize all three
    await reconcileMeetingRecorders("workspace-1");
    
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "recording-stale" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "STALE_RECORDER" })
    }));
    
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "recording-expired" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED" })
    }));

    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "recording-permanent" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_FETCH_FAILED" })
    }));

    // Reset mocks for pass 2 to prove they aren't called again
    vi.clearAllMocks();

    // Pass 2: should do nothing because they are terminalized
    await reconcileMeetingRecorders("workspace-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
  });

  it("stale-vs-webhook race: terminalization lock skips if transcriptProcessedAt is set during lock wait", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "race-stale", workspaceId: "workspace-1", meetingId: "meeting-race", provider: "MEETING_BAAS", externalBotId: "bot-race", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    prismaMock.meetingRecording.findMany.mockImplementation(async () => mockDb); prismaMock.meetingRecording.findUnique.mockImplementation(async () => ({ transcriptProcessedAt: new Date(), status: "COMPLETED" }));
    const result = await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled(); expect(prismaMock.meetingRecorderSmokeRun.updateMany).not.toHaveBeenCalled(); expect(result).toMatchObject({ staleFailed: 0 });
  });

  it("stale-vs-webhook race: terminalization lock proceeds if status transitions from SCHEDULED to RECORDING", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "race-transition", workspaceId: "workspace-1", meetingId: "meeting-race-transition", provider: "MEETING_BAAS", externalBotId: "bot-race-transition", status: "SCHEDULED", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    prismaMock.meetingRecording.findMany.mockImplementation(async () => mockDb); prismaMock.meetingRecording.findUnique.mockImplementation(async () => ({ transcriptProcessedAt: null, status: "RECORDING" }));
    const result = await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecording.update).toHaveBeenCalled(); expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalled(); expect(result).toMatchObject({ staleFailed: 1 });
  });

  it("atomic rollback/retry behavior: failing second write aborts transaction", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "atomic-stale", workspaceId: "workspace-1", meetingId: "meeting-atomic", provider: "MEETING_BAAS", externalBotId: "bot-atomic", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    let smokeRunsTerminalized = 0;
    prismaMock.meetingRecording.findMany.mockImplementation(async () => mockDb);
    prismaMock.meetingRecording.findUnique.mockImplementation(async () => mockDb[0]);
    prismaMock.meetingRecording.update.mockImplementation(async ({ where, data }) => { if (where.id === "atomic-stale") mockDb[0] = { ...mockDb[0], ...data } as any; return mockDb[0]; });
    let failSmokeUpdate = true;
    prismaMock.meetingRecorderSmokeRun.updateMany.mockImplementation(async () => { if (failSmokeUpdate) throw new Error("Atomic failure"); smokeRunsTerminalized++; return { count: 1 }; });
    prismaMock.$transaction.mockImplementation(async (callback) => {
      const snapDb = [...mockDb], snapSmoke = smokeRunsTerminalized;
      try { return await callback(prismaMock as any); } catch (err) { mockDb = [...snapDb]; smokeRunsTerminalized = snapSmoke; throw err; }
    });
    await expect(reconcileMeetingRecorders("workspace-1")).rejects.toThrow("Atomic failure");
    expect(mockDb[0].status).toBe("RECORDING"); expect(smokeRunsTerminalized).toBe(0);
    failSmokeUpdate = false;
    await reconcileMeetingRecorders("workspace-1");
    expect(mockDb[0].status).toBe("FAILED"); expect(smokeRunsTerminalized).toBe(1);
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledTimes(2); expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledTimes(2);
  });

  it("lock-wait timeout: transaction uses 120-second timeout", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "timeout-stale", workspaceId: "workspace-1", meetingId: "meeting-timeout", provider: "MEETING_BAAS", externalBotId: "bot-timeout", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    prismaMock.meetingRecording.findMany.mockImplementation(async () => mockDb);
    prismaMock.meetingRecording.findUnique.mockImplementation(async () => mockDb[0]);
    
    await reconcileMeetingRecorders("workspace-1");
    
    // Verify timeout parameter passed to transaction
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 120000 })
    );
  });

  it("terminalizes 24-hour expired active recordings with zero provider calls", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "active-expired", workspaceId: "workspace-1", meetingId: "meeting-expired", provider: "RECALL_AI", externalBotId: "bot-expired", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    prismaMock.meetingRecording.findMany.mockImplementation(async (q: any) => q.where?.provider === "RECALL_AI" ? mockDb : []);
    prismaMock.meetingRecording.findUnique.mockImplementation(async () => mockDb[0]);
    await reconcileMeetingRecorders("workspace-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "active-expired" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED" })
    }));
  });

  it("skips terminalization if there is a fresh webhook claim, but proceeds if it is abandoned", async () => {
    const { reconcileMeetingRecorders } = await import("./meeting-recorders");
    let mockDb = [{ id: "claim-race", workspaceId: "workspace-1", meetingId: "meeting-claim", provider: "RECALL_AI", externalBotId: "bot-claim", status: "RECORDING", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1) } }];
    prismaMock.meetingRecording.findMany.mockImplementation(async (q: any) => q.where?.provider === "RECALL_AI" ? mockDb : []);
    prismaMock.meetingRecording.findUnique.mockImplementation(async () => mockDb[0]);
    
    let freshWebhook = true;
    prismaMock.meetingRecorderProviderEvent.findFirst.mockImplementation(async () => freshWebhook ? { id: "webhook-fresh" } : null);

    await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecorderProviderEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ receivedAt: expect.objectContaining({ gte: expect.any(Date) }) })
    }));
    expect(prismaMock.meetingRecording.update).not.toHaveBeenCalled();
    
    freshWebhook = false;
    await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "claim-race" },
      data: expect.objectContaining({ status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED" })
    }));
  });

  it("allows a late transcript webhook to supersede an expired recovery terminalization", async () => {
    const { reconcileMeetingRecorders, processMeetingRecorderWebhook } = await import("./meeting-recorders");
    const { createHmac } = await import("crypto");
    const recording = { id: "rec-late", workspaceId: "workspace-1", meetingId: "meeting-1", provider: "RECALL_AI", externalBotId: "bot-late", status: "COMPLETED", activeDedupeKey: "dedupe-1", createdAt: new Date(1), joinAt: new Date(1), transcriptProcessedAt: null as Date | null, failureCode: null as string | null, failureMessage: null as string | null, meeting: { recordedAt: new Date(1), scheduledEndAt: new Date(1), workspaceId: "workspace-1" } };
    let mockDb = [recording];
    prismaMock.meetingRecording.findMany.mockImplementation(async (q: any) => mockDb.filter(r => q.where?.provider === "RECALL_AI" ? true : false));
    prismaMock.meetingRecording.findUnique.mockImplementation(async () => mockDb[0]);
    prismaMock.meetingRecorderProviderEvent.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecorderSmokeRun.updateMany.mockResolvedValue({ count: 1 });
    
    // Reconciliation wins lock and terminalizes
    await reconcileMeetingRecorders("workspace-1");
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED" }) }));
    mockDb[0] = { ...recording, status: "FAILED", failureCode: "RECORDER_TRANSCRIPT_RECOVERY_EXPIRED", failureMessage: "expired", transcriptProcessedAt: new Date() };

    // Late webhook claims
    const payload = JSON.stringify({ id: "event-late", event: "transcript.done", data: { bot: { id: "bot-late", metadata: { workspaceId: "workspace-1", meetingId: "meeting-1", recordingId: "rec-late" } }, transcript: { id: "trans-1", data: { download_url: "https://example.com/t.json" } } } });
    const msgId = "msg_1", timestamp = "1770000000", signature = createHmac("sha256", Buffer.from("recall-secret")).update(`${msgId}.${timestamp}.${payload}`).digest("base64");
    prismaMock.meetingRecorderProviderEvent.findUnique.mockResolvedValue(null); prismaMock.meetingRecorderProviderEvent.upsert.mockResolvedValue({ id: "e" } as any); prismaMock.meetingRecorderProviderEvent.update.mockResolvedValue({ id: "e" } as any); fetchMock.mockResolvedValue(new Response(JSON.stringify([{ speaker: "A", start: 0, text: "Content" }]), { status: 200 })); prismaMock.meetingRecording.update.mockResolvedValue(mockDb[0] as any); prismaMock.meeting.findFirst.mockResolvedValue({ id: "meeting-1", participantIds: [], participantEmails: [], title: "W", transcript: null, summaryMd: null, ingestionGuidanceMd: null } as any); prismaMock.meeting.update.mockResolvedValue({ id: "meeting-1", recordedAt: new Date() } as any);
    await expect(processMeetingRecorderWebhook("RECALL_AI", { rawBody: payload, headers: { "svix-id": msgId, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } })).resolves.toMatchObject({ processed: true, duplicate: false, recordingId: "rec-late" });
    expect(prismaMock.meetingRecording.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rec-late" }, data: expect.objectContaining({ status: "COMPLETED", failureCode: null }) }));
    expect(prismaMock.meetingRecorderSmokeRun.updateMany).toHaveBeenCalledWith({ where: { recordingId: "rec-late", status: { in: ["PENDING", "SCHEDULED", "FAILED"] } }, data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date) }) });
  });
});

