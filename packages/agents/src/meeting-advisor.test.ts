import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  agentRun: {
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentStep: {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  agentToolCall: {
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  modelUsageBudget: {
    findUnique: vi.fn(),
  },
  meeting: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(),
  agentIdentity: {
    findUnique: vi.fn(),
  },
};

const envMock = {
  AGENT_KILL_SWITCH: false,
  WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
};

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
    env: envMock,
    toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value ?? null)),
  };
});

vi.mock("@corgtex/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/domain")>();
  return {
    ...actual,
    isAgentEnabled: vi.fn().mockResolvedValue(true),
    getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
    resolveAgentIdentityLimits: vi.fn().mockResolvedValue(null),
    resolveAgentBehaviorContext: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@corgtex/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/models")>();
  return {
    ...actual,
    resolveModel: vi.fn().mockReturnValue("gpt-4o-mini"),
    defaultModelGateway: {
      chat: vi.fn().mockResolvedValue({ content: "Mock summary" }),
      embed: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]] }),
      extract: vi.fn().mockResolvedValue({ output: {} }),
      rerank: vi.fn().mockResolvedValue({ results: [] }),
    },
  };
});

describe("runMeetingSummaryAgent", () => {
  beforeEach(() => {
    envMock.AGENT_KILL_SWITCH = false;
    envMock.WORKSPACE_AGENT_MAX_CONCURRENCY = 4;

    prismaMock.agentRun.findFirst.mockReset().mockResolvedValue(null);
    prismaMock.agentRun.count.mockReset().mockResolvedValue(0);
    prismaMock.agentRun.create.mockReset().mockResolvedValue({ id: "run-1" });
    prismaMock.agentRun.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.agentStep.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.event.create.mockReset().mockResolvedValue({ id: "event-1" });
    prismaMock.modelUsageBudget.findUnique.mockReset().mockResolvedValue(null);

    prismaMock.meeting.findUnique.mockReset().mockResolvedValue({
      id: "meeting-1",
      workspaceId: "ws-1",
      title: "Test Meeting",
      source: "manual",
      transcript: "We discussed project updates.",
      summaryMd: null,
      recordedAt: new Date(),
    });
    prismaMock.meeting.update.mockReset().mockResolvedValue({ id: "meeting-1" });

    // Mock $transaction to execute the callback
    prismaMock.$transaction.mockReset().mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.agentIdentity.findUnique.mockReset().mockResolvedValue(null);
  });

  it("completes without requiring a live database", async () => {
    const { runMeetingSummaryAgent } = await import("./runtime");

    const result = await runMeetingSummaryAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-1",
      triggerType: "SCHEDULE",
      meetingId: "meeting-1",
    });

    expect(prismaMock.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentKey: "meeting-summary",
        workspaceId: "ws-1",
      }),
    }));
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
  });
});
