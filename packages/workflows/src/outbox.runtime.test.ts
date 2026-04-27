import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, runAgentWorkflowJobMock, runSlackAgentMock, processSlackInboundEventMock, purgeExpiredCommunicationMessagesMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    workflowJob: {
      update: vi.fn(),
    },
  },
  txMock: {
    $queryRaw: vi.fn(),
  },
  runAgentWorkflowJobMock: vi.fn(),
  runSlackAgentMock: vi.fn(),
  processSlackInboundEventMock: vi.fn(),
  purgeExpiredCommunicationMessagesMock: vi.fn(),
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
}));

import { runPendingJobs } from "./outbox";

describe("runPendingJobs", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    prismaMock.workflowJob.update.mockReset().mockResolvedValue({ id: "job-1" });
    txMock.$queryRaw.mockReset().mockResolvedValue([]);
    runAgentWorkflowJobMock.mockReset();
    runSlackAgentMock.mockReset();
    processSlackInboundEventMock.mockReset();
    purgeExpiredCommunicationMessagesMock.mockReset();
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
});
