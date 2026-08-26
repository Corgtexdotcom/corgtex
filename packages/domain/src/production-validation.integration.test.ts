import { beforeEach, describe, expect, it } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import {
  PR976_ACTION_GOAL_OPERATION_KEY,
  PR976_ACTION_PROVEN_BODY,
  PR976_GOAL_PROVEN_PROGRESS,
  PR976_SYNTHETIC_MARKER,
  PR976_TARGET_PULL_REQUEST,
  PR976_TARGET_RELEASE_SHA,
  PR976_VALIDATION_WORKSPACE_SLUG,
  getPr976ActionGoalValidationStatus,
  provisionPr976ActionGoalValidation,
  recordPr976ActionGoalFeatureProof,
  terminalizePr976ActionGoalValidation,
} from "./production-validation";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables();
});

async function createValidationWorkspace() {
  return prisma.workspace.create({
    data: {
      slug: PR976_VALIDATION_WORKSPACE_SLUG,
      name: "Corgtex Validation",
    },
  });
}

async function createValidationAdmin(): Promise<{ actor: AppActor; workspaceId: string; userId: string; memberId: string }> {
  const workspace = await createValidationWorkspace();
  const user = await prisma.user.create({
    data: {
      email: "production-validation-admin@example.com",
      displayName: "Production Validation Admin",
      passwordHash: "test-password-hash",
    },
  });
  const member = await prisma.member.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
      isActive: true,
    },
  });
  return { actor: { kind: "user", user }, workspaceId: workspace.id, userId: user.id, memberId: member.id };
}

describe("ProductionValidationReceipt integration", () => {
  it("enforces a durable one-time execution tuple in PostgreSQL", async () => {
    const workspace = await createValidationWorkspace();
    await prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "1".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        workflowRunId: "100",
        workflowRunAttempt: 1,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    });

    await expect(prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "2".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        workflowRunId: "100",
        workflowRunAttempt: 1,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    })).rejects.toMatchObject({ code: "P2002" });

    await prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "1".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        workflowRunId: "100",
        workflowRunAttempt: 2,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    });

    await expect(prisma.productionValidationReceipt.count({
      where: { operationKey: PR976_ACTION_GOAL_OPERATION_KEY },
    })).resolves.toBe(2);
  });

  it("cascades only with the owning validation workspace", async () => {
    const workspace = await createValidationWorkspace();
    await prisma.productionValidationReceipt.create({
      data: {
        operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
        workspaceId: workspace.id,
        targetPullRequest: PR976_TARGET_PULL_REQUEST,
        targetReleaseSha: PR976_TARGET_RELEASE_SHA,
        deployedSha: "1".repeat(40),
        ancestorSha: PR976_TARGET_RELEASE_SHA,
        workflowRunId: "100",
        workflowRunAttempt: 1,
        syntheticMarker: PR976_SYNTHETIC_MARKER,
      },
    });

    await prisma.workspace.delete({ where: { id: workspace.id } });
    await expect(prisma.productionValidationReceipt.count()).resolves.toBe(0);
  });

  it("serializes concurrent same-tuple provisioning into one synthetic set", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const input = {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "100",
      workflowRunAttempt: 1,
    };

    const results = await Promise.allSettled([
      provisionPr976ActionGoalValidation(actor, input),
      provisionPr976ActionGoalValidation(actor, input),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const fulfilled = results.map((result) => {
      if (result.status !== "fulfilled") throw result.reason;
      return result.value;
    });
    expect(fulfilled.filter((result) => result.credentialToken).length).toBe(1);
    expect(new Set(fulfilled.map((result) => result.receipt.id)).size).toBe(1);
    await expect(prisma.productionValidationReceipt.count({
      where: { operationKey: PR976_ACTION_GOAL_OPERATION_KEY },
    })).resolves.toBe(1);
    await expect(prisma.action.count({
      where: { workspaceId, title: `${PR976_SYNTHETIC_MARKER}:Action` },
    })).resolves.toBe(1);
    await expect(prisma.goal.count({
      where: { workspaceId, title: `${PR976_SYNTHETIC_MARKER}:Goal` },
    })).resolves.toBe(1);
    await expect(prisma.agentCredential.count({
      where: { workspaceId, label: `${PR976_SYNTHETIC_MARKER}:credential` },
    })).resolves.toBe(1);
  });

  it("creates a distinct synthetic set for a later workflow attempt", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const first = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "200",
      workflowRunAttempt: 1,
    });
    const replay = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "200",
      workflowRunAttempt: 1,
    });
    const rerun = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "200",
      workflowRunAttempt: 2,
    });

    expect(first.credentialToken).toMatch(/^agentc-/);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(replay.credentialToken).toBeNull();
    expect(rerun.receipt.id).not.toBe(first.receipt.id);
    expect(rerun.credentialToken).toMatch(/^agentc-/);
    await expect(prisma.productionValidationReceipt.count({
      where: { operationKey: PR976_ACTION_GOAL_OPERATION_KEY },
    })).resolves.toBe(2);
    await expect(prisma.action.count({
      where: { workspaceId, title: `${PR976_SYNTHETIC_MARKER}:Action` },
    })).resolves.toBe(2);
    await expect(prisma.goal.count({
      where: { workspaceId, title: `${PR976_SYNTHETIC_MARKER}:Goal` },
    })).resolves.toBe(2);
    await expect(prisma.agentCredential.count({
      where: { workspaceId, label: `${PR976_SYNTHETIC_MARKER}:credential` },
    })).resolves.toBe(2);
  });

  it("rejects cross-tuple status, proof, and terminalize requests with zero effects", async () => {
    const { actor } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "201",
      workflowRunAttempt: 1,
    });
    const wrongTuple = {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "201",
      workflowRunAttempt: 2,
    };

    await expect(getPr976ActionGoalValidationStatus(actor, wrongTuple)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(recordPr976ActionGoalFeatureProof(actor, {
      ...wrongTuple,
      actionObservedBodyMd: PR976_ACTION_PROVEN_BODY,
      actionObservedVersion: 2,
      goalObservedProgress: PR976_GOAL_PROVEN_PROGRESS,
      goalObservedVersion: 2,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(terminalizePr976ActionGoalValidation(actor, {
      ...wrongTuple,
      mode: "all",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const unchanged = await prisma.productionValidationReceipt.findUniqueOrThrow({
      where: {
        ProductionValidationReceipt_operationKey_workflowRunId_work_key: {
          operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
          workflowRunId: "201",
          workflowRunAttempt: 1,
        },
      },
    });
    expect(unchanged.id).toBe(provisioned.receipt.id);
    expect(unchanged.outcome).toBe("PENDING");
    expect(unchanged.actionState).toBe("PROVISIONED");
    expect(unchanged.goalState).toBe("PROVISIONED");
    expect(unchanged.credentialState).toBe("PROVISIONED");
  });

  it("keeps prior target cleanup committed when a later target blocks", async () => {
    const { actor, memberId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "101",
      workflowRunAttempt: 1,
    });
    const { actionId, goalId } = provisioned.receipt;
    if (!actionId || !goalId) throw new Error("Provisioned receipt missing Action or Goal.");

    await prisma.action.update({
      where: { id: actionId },
      data: { bodyMd: PR976_ACTION_PROVEN_BODY, version: { increment: 1 } },
    });
    await prisma.goal.update({
      where: { id: goalId },
      data: { progressPercent: PR976_GOAL_PROVEN_PROGRESS, version: { increment: 1 } },
    });
    await prisma.goalUpdate.create({
      data: {
        goalId,
        authorMemberId: memberId,
        bodyMd: "intentional relation to block goal cleanup",
        newProgress: PR976_GOAL_PROVEN_PROGRESS,
      },
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "101",
      workflowRunAttempt: 1,
      mode: "all",
    });

    expect(terminalized.receipt.outcome).toBe("BLOCKED");
    expect(terminalized.receipt.actionState).toBe("CLEANED");
    expect(terminalized.receipt.goalState).toBe("BLOCKED");
    const action = await prisma.action.findUniqueOrThrow({ where: { id: actionId } });
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(action.archivedAt).toBeTruthy();
    expect(goal.archivedAt).toBeNull();
    await expect(prisma.workspaceArchiveRecord.count({
      where: { entityType: "Action", entityId: actionId },
    })).resolves.toBe(1);
    const receipt = await prisma.productionValidationReceipt.findUniqueOrThrow({
      where: {
        ProductionValidationReceipt_operationKey_workflowRunId_work_key: {
          operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
          workflowRunId: "101",
          workflowRunAttempt: 1,
        },
      },
    });
    expect(receipt.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TARGET_TERMINALIZED", target: "action", state: "CLEANED" }),
      expect.objectContaining({ type: "TARGET_TERMINALIZED", target: "goal", state: "BLOCKED" }),
    ]));
  });
});
