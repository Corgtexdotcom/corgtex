import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, runAgentWorkflowJobMock, runSlackAgentMock, processSlackInboundEventMock, purgeExpiredCommunicationMessagesMock, syncSlackPublicArchiveForWorkspaceMock, runMeetingAgendaThreadEditMock, isAgentEnabledMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workflowJob: {
      update: vi.fn(),
    },
    workspace: {
      findMany: vi.fn(),
    },
    communicationInstallation: {
      findMany: vi.fn(),
    },
  },
  txMock: {
    $queryRaw: vi.fn(),
    workflowJob: {
      upsert: vi.fn(),
    },
  },
  runAgentWorkflowJobMock: vi.fn(),
  runSlackAgentMock: vi.fn(),
  processSlackInboundEventMock: vi.fn(),
  purgeExpiredCommunicationMessagesMock: vi.fn(),
  syncSlackPublicArchiveForWorkspaceMock: vi.fn(),
  runMeetingAgendaThreadEditMock: vi.fn(),
  isAgentEnabledMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./handlers/agent-dispatch", () => ({
  runAgentWorkflowJob: runAgentWorkflowJobMock,
}));

vi.mock("@corgtex/agents", () => ({
  runAgentWorkflowJob: runAgentWorkflowJobMock,
  runSlackAgent: runSlackAgentMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  syncKnowledgeForSource: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  recordGovernanceScore: vi.fn(),
  createWebhookDeliveries: vi.fn(),
  deliverWebhook: vi.fn(),
  syncBrainArticleKnowledge: vi.fn(),
  fetchCalendarEvents: vi.fn(),
  processSlackInboundEvent: processSlackInboundEventMock,
  purgeExpiredCommunicationMessages: purgeExpiredCommunicationMessagesMock,
  syncSlackPublicArchiveForWorkspace: syncSlackPublicArchiveForWorkspaceMock,
  runMeetingAgendaThreadEdit: runMeetingAgendaThreadEditMock,
  isAgentEnabled: isAgentEnabledMock,
}));

import { runPendingJobs, scheduleDailyJobs } from "./outbox";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORKER_DAILY_JOB_START_HOUR_UTC;
});

describe("runPendingJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workflowJob.update.mockReset().mockResolvedValue({ id: "job-1" });
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([]);
    txMock.$queryRaw.mockReset().mockResolvedValue([]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    runAgentWorkflowJobMock.mockReset();
    runSlackAgentMock.mockReset();
    processSlackInboundEventMock.mockReset();
    purgeExpiredCommunicationMessagesMock.mockReset();
    syncSlackPublicArchiveForWorkspaceMock.mockReset();
    runMeetingAgendaThreadEditMock.mockReset();
    isAgentEnabledMock.mockReset().mockResolvedValue(false);
  });

  it("requeues agent jobs when execution is skipped by the concurrency gate", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "agent.meeting-summary",
        payload: { meetingId: "meeting-1" },
        attempts: 1,
      },
    ]);
    runAgentWorkflowJobMock.mockResolvedValue({
      skipped: true,
      reason: "concurrency_limit",
    });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runAgentWorkflowJobMock).toHaveBeenCalledWith({
      id: "job-1",
      workspaceId: "ws-1",
      type: "agent.meeting-summary",
      payload: { meetingId: "meeting-1" },
      attempts: 1,
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "PENDING",
        error: "Agent concurrency limit reached.",
        lockedAt: null,
        lockedBy: null,
      }),
    });
  });

  it("dispatches Slack communication event jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
        attempts: 1,
      },
    ]);

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(processSlackInboundEventMock).toHaveBeenCalledWith("inbound-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack public archive jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.public-archive",
        payload: {},
        attempts: 1,
      },
    ]);
    syncSlackPublicArchiveForWorkspaceMock.mockResolvedValue({
      workspaceId: "ws-1",
      channelsSeen: 1,
      messagesUpserted: 1,
    });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(syncSlackPublicArchiveForWorkspaceMock).toHaveBeenCalledWith("ws-1");
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack agent jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "communication.slack.agent",
        payload: {
          source: "slash_command",
          installationId: "install-1",
          workspaceId: "ws-1",
          actorUserId: "user-1",
          externalUserId: "U1",
          prompt: "Create an action",
        },
        attempts: 1,
      },
    ]);
    runSlackAgentMock.mockResolvedValue({ status: "COMPLETED" });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runSlackAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "slash_command",
      installationId: "install-1",
      workspaceId: "ws-1",
      actorUserId: "user-1",
      externalUserId: "U1",
      prompt: "Create an action",
      workflowJobId: "job-1",
    }));
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });

  it("dispatches Slack agenda edit jobs", async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: "job-1",
        workspaceId: "ws-1",
        type: "meeting.agenda.edit",
        payload: {
          meetingId: "meeting-1",
          actorUserId: "user-1",
          installationId: "install-1",
          channelId: "C1",
          threadTs: "1710000000.000100",
          messageTs: "1710000001.000100",
          messageText: "Add Bob's detail",
        },
        attempts: 1,
      },
    ]);
    runMeetingAgendaThreadEditMock.mockResolvedValue({ edited: true });

    await expect(runPendingJobs("worker-1", 1)).resolves.toBe(1);

    expect(runMeetingAgendaThreadEditMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      meetingId: "meeting-1",
      actorUserId: "user-1",
      installationId: "install-1",
      channelId: "C1",
      threadTs: "1710000000.000100",
      messageTs: "1710000001.000100",
      messageText: "Add Bob's detail",
    });
    expect(prismaMock.workflowJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });
  });
});

describe("scheduleDailyJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workspace.findMany.mockReset().mockResolvedValue([
      { id: "ws-1" },
      { id: "ws-2" },
    ]);
    prismaMock.communicationInstallation.findMany.mockReset().mockResolvedValue([
      { workspaceId: "ws-1" },
    ]);
    txMock.workflowJob.upsert.mockReset().mockResolvedValue({ id: "job-1" });
    isAgentEnabledMock.mockReset().mockImplementation(async (workspaceId: string) => workspaceId === "ws-1");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T20:15:00Z"));
  });

  it("schedules retention, digest, and Slack archive jobs once the daily window has opened", async () => {
    await expect(scheduleDailyJobs()).resolves.toBe(4);

    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "communication.raw-retention",
        dedupeKey: "ws-1:communication-retention:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-2",
        type: "communication.raw-retention",
        dedupeKey: "ws-2:communication-retention:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "brain.daily-digest",
        dedupeKey: "ws-1:daily-digest:2026-04-29",
      }),
    }));
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "communication.slack.public-archive",
        dedupeKey: "ws-1:slack-public-archive:2026-04-29",
      }),
    }));
  });

  it("does not schedule daily jobs before the configured UTC start hour", async () => {
    vi.setSystemTime(new Date("2026-04-29T10:59:00Z"));

    await expect(scheduleDailyJobs()).resolves.toBe(0);

    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
  });
});
