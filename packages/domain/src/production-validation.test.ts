import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
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
    tx.$queryRaw.mockResolvedValue([{ id: "receipt-1" }]);
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

  it("serializes provisioning on the claimed receipt row and rejects immutable release rewrites", async () => {
    const { provisionPr976ActionGoalValidation } = await import("./production-validation");
    const existing = {
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
    prisma.productionValidationReceipt.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: {},
    }));
    prisma.productionValidationReceipt.findUniqueOrThrow.mockResolvedValue(existing);
    tx.$queryRaw.mockResolvedValue([{ id: "receipt-1" }]);
    tx.productionValidationReceipt.findUniqueOrThrow.mockResolvedValue(existing);

    await expect(provisionPr976ActionGoalValidation(
      { kind: "user", user: { id: "user-1", email: "admin@example.com" } } as any,
      {
        operationKey: "pr976-action-goal-production-validation",
        deployedSha: "2".repeat(40),
        ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
        workflowRunId: "10",
        workflowRunAttempt: 1,
      },
    )).rejects.toMatchObject({ code: "RECEIPT_ALREADY_CLAIMED" });

    expect(prisma.productionValidationReceipt.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        ProductionValidationReceipt_operationKey_workflowRunId_work_key: {
          operationKey: "pr976-action-goal-production-validation",
          workflowRunId: "10",
          workflowRunAttempt: 1,
        },
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.productionValidationReceipt.update).not.toHaveBeenCalled();
    expect(tx.action.create).not.toHaveBeenCalled();
    expect(tx.goal.create).not.toHaveBeenCalled();
    expect(tx.agentCredential.create).not.toHaveBeenCalled();
  });

  it("rejects non-fixed operation keys before claim", async () => {
    const { provisionPr976ActionGoalValidation } = await import("./production-validation");
    await expect(provisionPr976ActionGoalValidation(
      { kind: "user", user: { id: "user-1", email: "admin@example.com" } } as any,
      {
        operationKey: "other-operation",
        deployedSha: "1".repeat(40),
        ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
        workflowRunId: "10",
        workflowRunAttempt: 1,
      },
    )).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.productionValidationReceipt.create).not.toHaveBeenCalled();
  });

  it("rejects non-user actors before workspace authorization or receipt creation", async () => {
    const { provisionPr976ActionGoalValidation } = await import("./production-validation");
    await expect(provisionPr976ActionGoalValidation(
      { kind: "agent", label: "validation-agent" } as any,
      {
        operationKey: "pr976-action-goal-production-validation",
        deployedSha: "1".repeat(40),
        ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
        workflowRunId: "10",
        workflowRunAttempt: 1,
      },
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(auth.requireWorkspaceMembership).not.toHaveBeenCalled();
    expect(prisma.productionValidationReceipt.create).not.toHaveBeenCalled();
  });

  it("records unexpected cleanup exceptions as retryable without terminal timestamps", async () => {
    const { terminalizePr976ActionGoalValidation } = await import("./production-validation");
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
      actionId: "action-1",
      goalId: "goal-1",
      agentCredentialId: "cred-1",
      actionBaselineVersion: 1,
      goalBaselineVersion: 1,
      actionExpectedDigest: "sha256:expected",
      actionObservedDigest: "sha256:observed",
      goalExpectedProgress: 37,
      goalObservedProgress: 37,
      actionState: "FEATURE_PROVEN",
      goalState: "CLEANED",
      credentialState: "CLEANED",
      outcome: "PENDING",
      actionArchiveRecordId: null,
      goalArchiveRecordId: "goal-archive-1",
      cleanupStartedAt: null,
      completedAt: null,
      claimedAt: new Date(),
      featureProvenAt: new Date(),
      terminalizedAt: null,
      failureCode: null,
      failureMessage: null,
      transitions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    tx.$queryRaw.mockResolvedValue([{ id: "receipt-1" }]);
    tx.productionValidationReceipt.findUniqueOrThrow.mockResolvedValue(receipt);
    tx.productionValidationReceipt.update.mockImplementation(async ({ data }) => ({ ...receipt, ...data }));
    prisma.productionValidationReceipt.findUniqueOrThrow.mockResolvedValue({ ...receipt, failureCode: null, failureMessage: null });

    const result = await terminalizePr976ActionGoalValidation(
      { kind: "user", user: { id: "user-1", email: "admin@example.com" } } as any,
      {
        operationKey: "pr976-action-goal-production-validation",
        workflowRunId: "10",
        workflowRunAttempt: 1,
        mode: "action",
      },
    );

    expect(result.receipt.failureCode).toBeNull();
    expect(result.receipt.failureMessage).toBeNull();
    expect(tx.productionValidationReceipt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        transitions: expect.arrayContaining([expect.objectContaining({ type: "TARGET_CLEANUP_RETRYABLE", target: "action" })]),
      }),
    }));
    expect(tx.productionValidationReceipt.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ failureCode: "RETRYABLE_TARGET_CLEANUP_FAILED" }),
    }));
    expect(tx.productionValidationReceipt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        outcome: "PENDING",
        terminalizedAt: null,
        completedAt: null,
      }),
    }));
    expect(tx.productionValidationReceipt.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionState: "BLOCKED" }),
    }));
  });
});
