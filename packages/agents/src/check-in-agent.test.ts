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
  workspaceAgentConfig: {
    findUnique: vi.fn(),
  },
  modelUsageBudget: {
    findUnique: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
};

const envMock = {
  AGENT_KILL_SWITCH: false,
  WORKSPACE_AGENT_MAX_CONCURRENCY: 4,
};

const createCheckInMock = vi.fn();

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
    createCheckIn: createCheckInMock,
    isAgentEnabled: vi.fn().mockResolvedValue(true),
    getAgentModelOverride: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@corgtex/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/models")>();
  return {
    ...actual,
    resolveModel: vi.fn().mockReturnValue("fake-model"),
  };
});

describe("runDailyCheckInAgent", () => {
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

    prismaMock.agentStep.create.mockReset().mockImplementation(async ({ data }: any) => ({
      id: `step-${String(data.name)}`,
      ...data,
    }));
    prismaMock.agentStep.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentStep.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.agentToolCall.create.mockReset().mockImplementation(async ({ data }: any) => ({
      id: `tool-${String(data.name)}`,
      ...data,
    }));
    prismaMock.agentToolCall.createMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.agentToolCall.update.mockReset().mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));

    prismaMock.workspaceAgentConfig.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.event.create.mockReset().mockResolvedValue({ id: "event-1" });
    prismaMock.modelUsageBudget.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.$transaction.mockReset().mockImplementation(async (fn: any) => fn(prismaMock));
    createCheckInMock.mockReset().mockResolvedValue({ id: "checkin-1" });
  });

  it("creates a check-in without requiring a database", async () => {
    const { runDailyCheckInAgent } = await import("./runtime");

    const result = await runDailyCheckInAgent({
      workspaceId: "ws-1",
      triggerRef: "trigger-1",
      memberId: "member-1",
      triggerType: "SCHEDULE",
    });

    expect(createCheckInMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "SYSTEM" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        memberId: "member-1",
        questionSource: "AI",
      }),
    );
    expect(result).toEqual(expect.objectContaining({ status: "COMPLETED" }));
  });
});
