import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  productionValidationReceipt: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  action: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  goal: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  agentCredential: {
    create: vi.fn(),
  },
}));

const prisma = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  productionValidationReceipt: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
}));

const auth = vi.hoisted(() => ({
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma,
  randomOpaqueToken: () => "opaque-secret",
  sha256: (value: string | Buffer) => `sha256:${String(value)}`,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: auth.requireWorkspaceMembership,
}));

describe("PR 976 production validation receipt authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.workspace.findUnique.mockResolvedValue({ id: "workspace-1", slug: "corgtex-validation" });
    auth.requireWorkspaceMembership.mockResolvedValue({ id: "member-1", role: "ADMIN", isActive: true });
  });

  it("creates the durable receipt before any synthetic resource or credential", async () => {
    const { provisionPr976ActionGoalValidation } = await import("./production-validation");
    const receipt = {
      id: "receipt-1",
      operationKey: "pr976-action-goal-production-validation",
      workspaceId: "workspace-1",
      targetPullRequest: 976,
      targetReleaseSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      deployedSha: "1".repeat(40),
      ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      workflowRunId: "10",
      workflowRunAttempt: 1,
      syntheticMarker: "corgtex:production-validation:pr976:action-goal",
      actionId: null,
      goalId: null,
      agentCredentialId: null,
      actionBaselineVersion: null,
      goalBaselineVersion: null,
      actionExpectedDigest: null,
      actionObservedDigest: null,
      goalExpectedProgress: null,
      goalObservedProgress: null,
      actionState: "PENDING",
      goalState: "PENDING",
      credentialState: "PENDING",
      outcome: "PENDING",
      actionArchiveRecordId: null,
      goalArchiveRecordId: null,
      cleanupStartedAt: null,
      completedAt: null,
      claimedAt: new Date(),
      featureProvenAt: null,
      terminalizedAt: null,
      failureCode: null,
      failureMessage: null,
      transitions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.productionValidationReceipt.create.mockResolvedValue(receipt);
    tx.productionValidationReceipt.findUniqueOrThrow.mockResolvedValue(receipt);
    tx.action.create.mockResolvedValue({ id: "action-1", version: 1 });
    tx.goal.create.mockResolvedValue({ id: "goal-1", version: 1 });
    tx.agentCredential.create.mockResolvedValue({ id: "cred-1" });
    tx.productionValidationReceipt.update.mockImplementation(async ({ data }) => ({
      ...receipt,
      ...data,
      id: "receipt-1",
      workspaceId: "workspace-1",
      operationKey: "pr976-action-goal-production-validation",
      targetPullRequest: 976,
      targetReleaseSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      deployedSha: "1".repeat(40),
      ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      syntheticMarker: "corgtex:production-validation:pr976:action-goal",
      outcome: "PENDING",
      createdAt: new Date(),
      updatedAt: new Date(),
      claimedAt: new Date(),
    }));

    const result = await provisionPr976ActionGoalValidation(
      { kind: "user", user: { id: "user-1", email: "admin@example.com" } } as any,
      {
        operationKey: "pr976-action-goal-production-validation",
        deployedSha: "1".repeat(40),
        ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
        workflowRunId: "10",
        workflowRunAttempt: 1,
      },
    );

    expect(result.credentialToken).toBe("agentc-opaque-secret");
    expect(prisma.productionValidationReceipt.create).toHaveBeenCalledBefore(tx.action.create);
    expect(prisma.productionValidationReceipt.create).toHaveBeenCalledBefore(tx.goal.create);
    expect(prisma.productionValidationReceipt.create).toHaveBeenCalledBefore(tx.agentCredential.create);
    expect(tx.productionValidationReceipt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actionId: "action-1",
        goalId: "goal-1",
        agentCredentialId: "cred-1",
        actionState: "PROVISIONED",
        goalState: "PROVISIONED",
        credentialState: "PROVISIONED",
      }),
    }));
  });

  it("rejects non-fixed operation keys before claim", async () => {
    const { provisionPr976ActionGoalValidation } = await import("./production-validation");
    await expect(provisionPr976ActionGoalValidation(
      { kind: "user", user: { id: "user-1", email: "admin@example.com" } } as any,
      {
        operationKey: "other-operation",
        deployedSha: "1".repeat(40),
        ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      },
    )).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.productionValidationReceipt.create).not.toHaveBeenCalled();
  });
});
