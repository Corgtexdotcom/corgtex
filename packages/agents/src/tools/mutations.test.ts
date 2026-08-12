import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAction, createGoal, createProposal, createProposalFromTension, createTension, updateAction, updateTension } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { createActionItemAction, createActionTool, createGoalAction, createGoalTool, createProposalAction, createProposalTool, updateActionItemAction, updateActionTool, updateTensionAction, updateTensionTool } from "./mutations";

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  createAction: vi.fn(),
  updateAction: vi.fn(),
  createGoal: vi.fn(),
  createProposal: vi.fn(),
  createProposalFromTension: vi.fn(),
  createTension: vi.fn(),
  updateTension: vi.fn(),
  duplicateGuardErrorPayload: vi.fn((error: any) => ({
    status: "duplicate_confirmation_required",
    candidate: error.candidate,
    recommendedResolution: error.recommendedResolution,
    allowedResolutions: error.allowedResolutions,
  })),
  isDuplicateGuardMatchError: vi.fn((error: any) => error?.code === "DUPLICATE_GUARD_MATCH"),
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
    expect(createGoalTool.function.parameters.properties).toHaveProperty("duplicateResolution");
    expect(createGoalTool.function.parameters.properties).toHaveProperty("duplicateTargetEntityId");
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
        status: "ACTIVE",
        keyResults: [{ title: "Acquire first pilot", targetValue: 1, currentValue: 0 }],
        duplicateGuard: { onExact: "use_existing" },
      }),
    );
    expect(result).toEqual({ success: true, goalId: "goal-1" });
  });
});

describe("action mutation tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
  });

  it("only annotates create audits from the current write attempt", async () => {
    vi.mocked(createAction).mockResolvedValueOnce({
      id: "action-existing",
      title: "Send Acme proposal",
      status: "OPEN",
    } as any);

    await createActionItemAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      { title: "Send Acme proposal" },
    );

    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        duplicateGuard: { onExact: "use_existing" },
      }),
    );
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        entityType: "Action",
        entityId: "action-existing",
        action: "action.created",
        createdAt: { gte: expect.any(Date) },
      }),
    }));
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("declares duplicate resolution fields", () => {
    expect(createActionTool.function.parameters.properties).toHaveProperty("duplicateResolution");
    expect(createActionTool.function.parameters.properties).toHaveProperty("duplicateTargetEntityId");
  });

  it("passes explicit duplicate resolutions into action creation", async () => {
    vi.mocked(createAction).mockResolvedValueOnce({
      id: "action-existing",
      title: "Send Acme proposal",
      status: "OPEN",
    } as any);

    await createActionItemAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        title: "Send Acme proposal",
        duplicateResolution: "update_existing",
        duplicateTargetEntityId: "action-existing",
      },
    );

    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        duplicateGuard: {
          resolution: "update_existing",
          targetEntityId: "action-existing",
        },
      }),
    );
  });

  it("returns duplicate confirmation payloads without annotating create audits", async () => {
    vi.mocked(createAction).mockRejectedValueOnce({
      code: "DUPLICATE_GUARD_MATCH",
      candidate: {
        entityType: "Action",
        entityId: "action-existing",
        title: "Send Acme proposal",
        excerpt: null,
        score: 0.91,
        matchKind: "likely",
        reasons: ["similar title"],
        createdAt: null,
        updatedAt: null,
        archivedAt: null,
      },
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    });

    const result = await createActionItemAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      { title: "Send Acme proposal" },
    );

    expect(result).toMatchObject({
      status: "duplicate_confirmation_required",
      candidate: expect.objectContaining({ entityId: "action-existing" }),
      recommendedResolution: "update_existing",
      allowedResolutions: ["use_existing", "update_existing", "create_new"],
    });
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });
});

describe("proposal mutation tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
  });

  it("declares optional tension and action link fields", () => {
    const properties = createProposalTool.function.parameters.properties as Record<string, unknown>;

    expect(createProposalTool.function.name).toBe("create_proposal");
    expect(properties).toHaveProperty("sourceTensionId");
    expect(properties).toHaveProperty("relatedActionIds");
    expect(properties).toHaveProperty("ownerMemberId");
    expect(properties).toHaveProperty("duplicateResolution");
    expect(properties).toHaveProperty("duplicateTargetEntityId");
    expect(properties.ownerMemberId).toMatchObject({
      type: ["string", "null"],
    });
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
        duplicateGuard: { onExact: "use_existing" },
      }),
    );
    expect(result).toEqual({ success: true, proposalId: "proposal-1" });
  });

  it("passes explicit ownerless requests from source tension proposals", async () => {
    vi.mocked(createProposalFromTension).mockResolvedValueOnce({
      id: "proposal-ownerless",
      title: "Clarify approval policy",
    } as any);

    await createProposalAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        sourceTensionId: "tension-1",
        ownerMemberId: null,
      },
    );

    expect(createProposalFromTension).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        sourceTensionId: "tension-1",
        ownerMemberId: null,
      }),
    );
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

  it("passes explicit ownerless requests into regular proposal creation", async () => {
    vi.mocked(createProposal).mockResolvedValueOnce({
      id: "proposal-ownerless",
      title: "Clarify approval policy",
    } as any);

    await createProposalAction(
      { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
      { workspaceId: "ws-1", sessionId: "session-1" },
      {
        title: "Clarify approval policy",
        bodyMd: "Proposal body",
        ownerMemberId: null,
      },
    );

    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      expect.objectContaining({
        workspaceId: "ws-1",
        title: "Clarify approval policy",
        ownerMemberId: null,
      }),
    );
  });

  it("rejects malformed explicit owner values before proposal creation", async () => {
    await expect(
      createProposalAction(
        { kind: "agent", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any,
        { workspaceId: "ws-1", sessionId: "session-1" },
        {
          title: "Clarify approval policy",
          bodyMd: "Proposal body",
          ownerMemberId: 42,
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_OWNER_MEMBER_ID",
    });

    expect(createProposal).not.toHaveBeenCalled();
    expect(createProposalFromTension).not.toHaveBeenCalled();
  });
});

describe("agent update tools version requirements", () => {
  const updateCases = [
    { name: "update_action", toolDef: updateActionTool, actionFn: updateActionItemAction, domainFn: vi.mocked(updateAction), args: { actionId: "a-1", expectedVersion: 2, title: "Title" }, expectedArg: { actionId: "a-1", expectedVersion: 2, title: "Title" } },
    { name: "update_tension", toolDef: updateTensionTool, actionFn: updateTensionAction, domainFn: vi.mocked(updateTension), args: { tensionId: "t-1", expectedVersion: 2, title: "Title" }, expectedArg: { tensionId: "t-1", expectedVersion: 2, title: "Title" } },
  ];

  for (const testCase of updateCases) {
    it(`[${testCase.name}] schema requires expectedVersion minimum 1 and propagates exactly without retry`, async () => {
      expect(testCase.toolDef.function.parameters.required).toContain("expectedVersion");
      expect((testCase.toolDef.function.parameters.properties as any).expectedVersion).toMatchObject({
        type: "integer",
        minimum: 1,
      });

      testCase.domainFn.mockClear();
      testCase.domainFn.mockResolvedValueOnce({ id: "id-1", version: 3 } as any);
      const successResult = await testCase.actionFn({ kind: "agent" } as any, { workspaceId: "ws-1", sessionId: "session-1" }, testCase.args);
      expect(successResult.version).toBe(3);

      expect(testCase.domainFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining(testCase.expectedArg)
      );

      const findFirstCalls = vi.mocked(prisma.auditLog.findFirst).mock.calls.length;
      const updateCalls = vi.mocked(prisma.auditLog.update).mock.calls.length;

      const { AppError } = await import("@corgtex/domain");
      testCase.domainFn.mockRejectedValueOnce(new AppError(409, "VERSION_CONFLICT", "Conflict"));

      const conflictResult = await testCase.actionFn({ kind: "agent" } as any, { workspaceId: "ws-1", sessionId: "session-1" }, testCase.args);
      expect(conflictResult).toStrictEqual({
        status: "VERSION_CONFLICT",
        instruction: "The record was modified by another request. Read the latest version and apply your changes again.",
      });

      expect(testCase.domainFn).toHaveBeenCalledTimes(2);
      expect(vi.mocked(prisma.auditLog.findFirst).mock.calls.length).toBe(findFirstCalls);
      expect(vi.mocked(prisma.auditLog.update).mock.calls.length).toBe(updateCalls);
    });

    it(`[${testCase.name}] rejects missing, zero, or fractional expectedVersion before calling domain`, async () => {
      testCase.domainFn.mockClear();

      const resMissing = await testCase.actionFn({ kind: "agent" } as any, { workspaceId: "ws-1", sessionId: "session-1" }, { ...testCase.args, expectedVersion: undefined });
      expect(resMissing.status).toBe("INVALID_ARGUMENT");

      const resZero = await testCase.actionFn({ kind: "agent" } as any, { workspaceId: "ws-1", sessionId: "session-1" }, { ...testCase.args, expectedVersion: 0 });
      expect(resZero.status).toBe("INVALID_ARGUMENT");

      const resFrac = await testCase.actionFn({ kind: "agent" } as any, { workspaceId: "ws-1", sessionId: "session-1" }, { ...testCase.args, expectedVersion: 1.5 });
      expect(resFrac.status).toBe("INVALID_ARGUMENT");

      expect(testCase.domainFn).not.toHaveBeenCalled();
    });
  }
});
