import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoal, createProposal, createProposalFromTension } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { createGoalAction, createGoalTool, createProposalAction, createProposalTool } from "./mutations";

vi.mock("@corgtex/domain", () => ({
  createAction: vi.fn(),
  updateAction: vi.fn(),
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createProposalFromTension: vi.fn(),
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

describe("proposal mutation tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
  });

  it("declares optional tension and action link fields", () => {
    expect(createProposalTool.function.name).toBe("create_proposal");
    expect(createProposalTool.function.parameters.properties).toHaveProperty("sourceTensionId");
    expect(createProposalTool.function.parameters.properties).toHaveProperty("relatedActionIds");
    expect(createProposalTool.function.parameters.required).toEqual([]);
  });

  it("creates a proposal from a source tension with optional related actions", async () => {
    vi.mocked(createProposalFromTension).mockResolvedValueOnce({
      id: "proposal-1",
      title: "Clarify approval policy",
    } as any);

    const result = await createProposalAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        title: "Clarify approval policy",
        summary: "Draft from a tension",
        bodyMd: "Proposal body",
        sourceTensionId: "tension-1",
        relatedActionIds: ["action-1"],
      },
    );

    expect(createProposalFromTension).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Clarify approval policy",
        sourceTensionId: "tension-1",
        relatedActionIds: ["action-1"],
      }),
    );
    expect(result).toEqual({ success: true, proposalId: "proposal-1" });
  });

  it("creates a regular proposal without a source tension", async () => {
    vi.mocked(createProposal).mockResolvedValueOnce({
      id: "proposal-2",
      title: "Clarify approval policy",
    } as any);

    const result = await createProposalAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        title: "Clarify approval policy",
        summary: "Regular draft",
        bodyMd: "Proposal body",
      },
    );

    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Clarify approval policy",
        bodyMd: "Proposal body",
      }),
    );
    expect(result).toEqual({ success: true, proposalId: "proposal-2" });
  });
});
