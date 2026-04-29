import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoal } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { createGoalAction, createGoalTool } from "./mutations";

vi.mock("@corgtex/domain", () => ({
  createAction: vi.fn(),
  updateAction: vi.fn(),
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createTension: vi.fn(),
  updateTension: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    auditLog: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe("goal mutation tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
  });

  it("declares a create_goal model tool", () => {
    expect(createGoalTool.function.name).toBe("create_goal");
    expect(createGoalTool.function.parameters.required).toContain("title");
  });

  it("creates a goal through the domain layer", async () => {
    vi.mocked(createGoal).mockResolvedValueOnce({
      id: "goal-1",
      title: "Transform 1,000 businesses",
      status: "ACTIVE",
    } as any);

    const result = await createGoalAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        title: "Transform 1,000 businesses",
        cadence: "TEN_YEAR",
        keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
      },
    );

    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Transform 1,000 businesses",
        cadence: "TEN_YEAR",
        keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
      }),
    );
    expect(result).toEqual({ success: true, goalId: "goal-1" });
  });
});
