import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, fetchMock } = vi.hoisted(() => {
  const prisma = {
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceMeetingRecorderConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workflowJob: {
      upsert: vi.fn(),
    },
    meeting: {
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
    },
    meetingRecorderProviderEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
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
      SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
      RECALL_API_KEY: "recall-key",
      RECALL_REGION: "us-west-2",
      RECALL_WEBHOOK_SECRET: `whsec_${Buffer.from("recall-secret").toString("base64")}`,
      MEETING_BAAS_API_KEY: "baas-key",
      MEETING_BAAS_WEBHOOK_SECRET: "baas-secret",
      MEETING_RECORDER_PUBLIC_BASE_URL: "https://app.example.com",
      APP_URL: "https://app.example.com",
    },
  };
});

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
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
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
      data: expect.objectContaining({ status: "FAILED", failureCode: "HTTP_507" }),
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
});
