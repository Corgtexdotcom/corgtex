import { beforeEach, describe, expect, it } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
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

async function proveProvisionedFeature(actor: AppActor, workflowRunId: string) {
  const provisioned = await provisionPr976ActionGoalValidation(actor, {
    operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
    deployedSha: "1".repeat(40),
    ancestorSha: PR976_TARGET_RELEASE_SHA,
    workflowRunId,
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
  await recordPr976ActionGoalFeatureProof(actor, {
    operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
    workflowRunId,
    workflowRunAttempt: 1,
    actionObservedBodyMd: PR976_ACTION_PROVEN_BODY,
    actionObservedVersion: 2,
    goalObservedProgress: PR976_GOAL_PROVEN_PROGRESS,
    goalObservedVersion: 2,
  });
  return provisioned;
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
    await recordPr976ActionGoalFeatureProof(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "101",
      workflowRunAttempt: 1,
      actionObservedBodyMd: PR976_ACTION_PROVEN_BODY,
      actionObservedVersion: 2,
      goalObservedProgress: PR976_GOAL_PROVEN_PROGRESS,
      goalObservedVersion: 2,
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

  it("revokes and blocks credential cleanup when linked validation agent identities remain", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "102",
      workflowRunAttempt: 1,
    });
    const credentialId = provisioned.receipt.agentCredentialId;
    if (!credentialId) throw new Error("Provisioned receipt missing credential.");
    const credential = await prisma.agentCredential.findUniqueOrThrow({ where: { id: credentialId } });
    await prisma.agentIdentity.createMany({
      data: [
        {
          workspaceId,
          agentKey: "pv-a",
          memberType: "EXTERNAL",
          displayName: credential.label,
          linkedCredentialId: credential.id,
        },
        {
          workspaceId,
          agentKey: "pv-b",
          memberType: "EXTERNAL",
          displayName: credential.label,
          linkedCredentialId: credential.id,
        },
      ],
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "102",
      workflowRunAttempt: 1,
      mode: "credential",
    });

    expect(terminalized.receipt.outcome).toBe("BLOCKED");
    expect(terminalized.receipt.credentialState).toBe("BLOCKED");
    await expect(prisma.agentCredential.findUniqueOrThrow({ where: { id: credential.id } })).resolves.toMatchObject({ isActive: false });
    await expect(prisma.agentIdentity.count({
      where: {
        linkedCredentialId: credential.id,
        isActive: true,
        archivedAt: null,
      },
    })).resolves.toBe(2);
    await expect(prisma.agentIdentity.create({
      data: {
        workspaceId,
        agentKey: "pr976-validation-after-cleanup",
        memberType: "EXTERNAL",
        displayName: credential.label,
        linkedCredentialId: credential.id,
      },
    })).rejects.toThrow(/production validation credential cleanup already started/);
    await expect(prisma.agentCredential.update({
      where: { id: credential.id },
      data: { tokenHash: "rotated-after-cleanup" },
    })).rejects.toThrow(/production validation credential cleanup already started/);
    await expect(prisma.agentCredential.update({
      where: { id: credential.id },
      data: { isActive: true },
    })).rejects.toThrow(/production validation credential cleanup already started/);
    await expect(prisma.agentCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date("2026-08-26T12:00:00.000Z") },
    })).rejects.toThrow(/production validation credential cleanup already started/);
    await expect(prisma.agentCredential.update({
      where: { id: credential.id },
      data: { isActive: false },
    })).rejects.toThrow(/production validation credential cleanup already started/);
  });

  it("cleans a canonical receipt credential with zero linked identities", async () => {
    const { actor } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "102b",
      workflowRunAttempt: 1,
    });
    const credentialId = provisioned.receipt.agentCredentialId;
    if (!credentialId) throw new Error("Provisioned receipt missing credential.");

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "102b",
      workflowRunAttempt: 1,
      mode: "credential",
    });

    expect(terminalized.receipt.credentialState).toBe("CLEANED");
    await expect(prisma.agentCredential.findUniqueOrThrow({ where: { id: credentialId } })).resolves.toMatchObject({ isActive: false });
  });

  it("revokes and blocks credential cleanup when lastUsedAt or scopes drift", async () => {
    const { actor } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "102c",
      workflowRunAttempt: 1,
    });
    const credentialId = provisioned.receipt.agentCredentialId;
    if (!credentialId) throw new Error("Provisioned receipt missing credential.");
    await prisma.agentCredential.update({
      where: { id: credentialId },
      data: { lastUsedAt: new Date("2026-08-26T00:00:00.000Z"), scopes: ["goals:read"] },
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "102c",
      workflowRunAttempt: 1,
      mode: "credential",
    });

    expect(terminalized.receipt.outcome).toBe("BLOCKED");
    expect(terminalized.receipt.credentialState).toBe("BLOCKED");
    await expect(prisma.agentCredential.findUniqueOrThrow({
      where: { id: credentialId },
      select: { isActive: true, lastUsedAt: true, scopes: true },
    })).resolves.toMatchObject({
      isActive: false,
      lastUsedAt: new Date("2026-08-26T00:00:00.000Z"),
      scopes: ["goals:read"],
    });
  });

  it("blocks credential cleanup before mutating when any linked identity belongs to another workspace", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "105",
      workflowRunAttempt: 1,
    });
    const credentialId = provisioned.receipt.agentCredentialId;
    if (!credentialId) throw new Error("Provisioned receipt missing credential.");
    const foreignWorkspace = await prisma.workspace.create({
      data: {
        slug: "foreign-workspace",
        name: "Foreign Workspace",
      },
    });
    await prisma.agentIdentity.createMany({
      data: [
        {
          workspaceId,
          agentKey: "pv-local",
          memberType: "EXTERNAL",
          displayName: `${PR976_SYNTHETIC_MARKER}:credential`,
          linkedCredentialId: credentialId,
        },
        {
          workspaceId: foreignWorkspace.id,
          agentKey: "pv-foreign",
          memberType: "EXTERNAL",
          displayName: `${PR976_SYNTHETIC_MARKER}:credential`,
          linkedCredentialId: credentialId,
        },
      ],
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "105",
      workflowRunAttempt: 1,
      mode: "credential",
    });

    expect(terminalized.receipt.outcome).toBe("BLOCKED");
    expect(terminalized.receipt.credentialState).toBe("BLOCKED");
    await expect(prisma.agentCredential.findUniqueOrThrow({ where: { id: credentialId } })).resolves.toMatchObject({ isActive: false });
    await expect(prisma.agentIdentity.count({
      where: {
        linkedCredentialId: credentialId,
        isActive: true,
        archivedAt: null,
      },
    })).resolves.toBe(2);
  });

  it("revokes credential drift while preserving linked identities byte-for-byte", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "106",
      workflowRunAttempt: 1,
    });
    const credentialId = provisioned.receipt.agentCredentialId;
    if (!credentialId) throw new Error("Provisioned receipt missing credential.");
    const credential = await prisma.agentCredential.findUniqueOrThrow({ where: { id: credentialId } });
    await prisma.agentIdentity.createMany({
      data: [
        {
          workspaceId,
          agentKey: "pv-clean-before-blocker",
          memberType: "EXTERNAL",
          displayName: credential.label,
          linkedCredentialId: credential.id,
        },
        {
          workspaceId,
          agentKey: "pv-late-blocker",
          memberType: "EXTERNAL",
          displayName: "changed display name",
          linkedCredentialId: credential.id,
        },
      ],
    });
    const beforeCredential = await prisma.agentCredential.findUniqueOrThrow({ where: { id: credential.id } });
    const beforeIdentities = await prisma.agentIdentity.findMany({
      where: { linkedCredentialId: credential.id },
      orderBy: { agentKey: "asc" },
      select: {
        agentKey: true,
        displayName: true,
        isActive: true,
        archivedAt: true,
        archiveReason: true,
        linkedCredentialId: true,
      },
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "106",
      workflowRunAttempt: 1,
      mode: "credential",
    });

    expect(terminalized.receipt.outcome).toBe("BLOCKED");
    expect(terminalized.receipt.credentialState).toBe("BLOCKED");
    const afterCredential = await prisma.agentCredential.findUniqueOrThrow({ where: { id: credential.id } });
    const afterIdentities = await prisma.agentIdentity.findMany({
      where: { linkedCredentialId: credential.id },
      orderBy: { agentKey: "asc" },
      select: {
        agentKey: true,
        displayName: true,
        isActive: true,
        archivedAt: true,
        archiveReason: true,
        linkedCredentialId: true,
      },
    });
    expect(afterCredential.isActive).toBe(false);
    expect(afterCredential.tokenHash).toBe(beforeCredential.tokenHash);
    expect(afterIdentities).toEqual(beforeIdentities);
  });

  it("cancels pending Action-derived jobs and removes exact Action knowledge and graph outputs before cleanup", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await proveProvisionedFeature(actor, "107");
    const actionId = provisioned.receipt.actionId;
    if (!actionId) throw new Error("Provisioned receipt missing Action.");
    const circle = await prisma.circle.create({
      data: {
        workspaceId,
        name: "Shared circle",
      },
    });
    const actionObject = await prisma.contextGraphObject.create({
      data: {
        workspaceId,
        objectType: "Task",
        title: "Synthetic action object",
        sourceEntityType: "Action",
        sourceEntityId: actionId,
      },
    });
    const circleObject = await prisma.contextGraphObject.create({
      data: {
        workspaceId,
        objectType: "Team",
        title: "Shared circle object",
        sourceEntityType: "Circle",
        sourceEntityId: circle.id,
      },
    });
    await prisma.contextGraphRelationship.create({
      data: {
        workspaceId,
        sourceObjectId: actionObject.id,
        targetObjectId: circleObject.id,
        relationshipType: "part_of",
        sourceEntityType: "Action",
        sourceEntityId: actionId,
      },
    });
    await prisma.knowledgeChunk.create({
      data: {
        workspaceId,
        sourceType: "ACTION",
        accessDomain: "WORKSPACE",
        sourceId: actionId,
        sourceTitle: "Synthetic action",
        content: "Synthetic action content",
      },
    });
    await prisma.workflowJob.createMany({
      data: [
        {
          workspaceId,
          type: "knowledge.sync.action",
          payload: { actionId },
          status: "PENDING",
          dedupeKey: "pv-action-knowledge-pending",
        },
        {
          workspaceId,
          type: "context-graph.sync",
          payload: { sourceType: "ACTION", sourceId: actionId },
          status: "PENDING",
          dedupeKey: "pv-action-graph-pending",
        },
        {
          workspaceId,
          type: "knowledge.sync.action",
          payload: { actionId: "other-action" },
          status: "PENDING",
          dedupeKey: "pv-other-action-knowledge-pending",
        },
      ],
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "107",
      workflowRunAttempt: 1,
      mode: "action",
    });

    expect(terminalized.receipt.actionState).toBe("CLEANED");
    await expect(prisma.workflowJob.findMany({
      where: { dedupeKey: { in: ["pv-action-knowledge-pending", "pv-action-graph-pending"] } },
      select: { status: true },
      orderBy: { dedupeKey: "asc" },
    })).resolves.toEqual([{ status: "CANCELLED" }, { status: "CANCELLED" }]);
    await expect(prisma.workflowJob.findUniqueOrThrow({
      where: { dedupeKey: "pv-other-action-knowledge-pending" },
      select: { status: true },
    })).resolves.toEqual({ status: "PENDING" });
    await expect(prisma.knowledgeChunk.count({
      where: { workspaceId, sourceType: "ACTION", sourceId: actionId },
    })).resolves.toBe(0);
    await expect(prisma.contextGraphRelationship.count({
      where: { workspaceId, sourceEntityType: "Action", sourceEntityId: actionId },
    })).resolves.toBe(0);
    await expect(prisma.contextGraphObject.count({
      where: { workspaceId, sourceEntityType: "Action", sourceEntityId: actionId },
    })).resolves.toBe(0);
    await expect(prisma.contextGraphObject.count({
      where: { workspaceId, sourceEntityType: "Circle", sourceEntityId: circle.id },
    })).resolves.toBe(1);
  });

  it("leaves running Action-derived jobs unchanged and leaves the Action uncleaned for a later retry", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await proveProvisionedFeature(actor, "108");
    const actionId = provisioned.receipt.actionId;
    if (!actionId) throw new Error("Provisioned receipt missing Action.");
    await prisma.workflowJob.create({
      data: {
        workspaceId,
        type: "knowledge.sync.action",
        payload: { actionId },
        status: "RUNNING",
        startedAt: new Date(),
        lockedAt: new Date(),
        lockedBy: "worker-1",
        dedupeKey: "pv-action-knowledge-running",
      },
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "108",
      workflowRunAttempt: 1,
      mode: "action",
    });

    expect(terminalized.receipt.outcome).toBe("PENDING");
    expect(terminalized.receipt.actionState).toBe("FEATURE_PROVEN");
    expect(terminalized.receipt.failureCode).toBe("RETRYABLE_TARGET_CLEANUP_FAILED");
    await expect(prisma.action.findUniqueOrThrow({
      where: { id: actionId },
      select: { archivedAt: true },
    })).resolves.toEqual({ archivedAt: null });
    await expect(prisma.workflowJob.findUniqueOrThrow({
      where: { dedupeKey: "pv-action-knowledge-running" },
      select: { status: true, lockedAt: true, lockedBy: true, startedAt: true },
    })).resolves.toMatchObject({
      status: "RUNNING",
      lockedBy: "worker-1",
    });
    await prisma.workflowJob.update({
      where: { dedupeKey: "pv-action-knowledge-running" },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: "Worker finished before cleanup retry.",
      },
    });

    const retried = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "108",
      workflowRunAttempt: 1,
      mode: "action",
    });

    expect(retried.receipt.outcome).toBe("PENDING");
    expect(retried.receipt.actionState).toBe("CLEANED");
    expect(retried.receipt.failureCode).toBeNull();
    await expect(prisma.action.findUniqueOrThrow({
      where: { id: actionId },
      select: { archivedAt: true },
    })).resolves.toMatchObject({ archivedAt: expect.any(Date) });
  });

  it("allows failure-only cleanup but requires both proofs for successful all-mode cleanup", async () => {
    const { actor } = await createValidationAdmin();
    await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "104",
      workflowRunAttempt: 1,
    });

    await expect(terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "104",
      workflowRunAttempt: 1,
      mode: "all",
    })).rejects.toMatchObject({ code: "FEATURE_NOT_PROVEN" });

    const failed = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "104",
      workflowRunAttempt: 1,
      mode: "all",
      failureCode: "DRIVER_FAILURE",
      failureMessage: "Driver failed before feature proof.",
    });

    expect(failed.receipt.outcome).toBe("FAILED");
    expect(failed.receipt.completedAt).toBeNull();
    expect(failed.receipt.failureCode).toBe("DRIVER_FAILURE");
  });

  it("clears retryable cleanup diagnostics when a later all-target cleanup succeeds", async () => {
    const { actor } = await createValidationAdmin();
    const provisioned = await proveProvisionedFeature(actor, "108");
    await prisma.productionValidationReceipt.update({
      where: { id: provisioned.receipt.id },
      data: {
        failureCode: "RETRYABLE_TARGET_CLEANUP_FAILED",
        failureMessage: "transient database disconnect",
      },
    });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "108",
      workflowRunAttempt: 1,
      mode: "all",
    });

    expect(terminalized.receipt.outcome).toBe("COMPLETED");
    expect(terminalized.receipt.actionState).toBe("CLEANED");
    expect(terminalized.receipt.goalState).toBe("CLEANED");
    expect(terminalized.receipt.credentialState).toBe("CLEANED");
    expect(terminalized.receipt.failureCode).toBeNull();
    expect(terminalized.receipt.failureMessage).toBeNull();
    expect(terminalized.receipt.completedAt).toBeTruthy();
  });

  it("rejects restoring or mutating cleaned receipt Action and Goal targets", async () => {
    const { actor, workspaceId } = await createValidationAdmin();
    const provisioned = await proveProvisionedFeature(actor, "109");
    const { actionId, goalId } = provisioned.receipt;
    if (!actionId || !goalId) throw new Error("Provisioned receipt missing Action or Goal.");

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "109",
      workflowRunAttempt: 1,
      mode: "all",
    });

    expect(terminalized.receipt.outcome).toBe("COMPLETED");
    expect(terminalized.receipt.actionState).toBe("CLEANED");
    expect(terminalized.receipt.goalState).toBe("CLEANED");
    await expect(restoreWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Action",
      entityId: actionId,
    })).rejects.toThrow(/production validation Action cleanup already started/);
    await expect(restoreWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Goal",
      entityId: goalId,
    })).rejects.toThrow(/production validation Goal cleanup already started/);
    await expect(prisma.action.update({
      where: { id: actionId },
      data: { status: "OPEN", isPrivate: false },
    })).rejects.toThrow(/production validation Action cleanup already started/);
    await expect(prisma.goal.update({
      where: { id: goalId },
      data: { progressPercent: 12, version: { increment: 1 } },
    })).rejects.toThrow(/production validation Goal cleanup already started/);
    await expect(prisma.action.findUniqueOrThrow({
      where: { id: actionId },
      select: { archivedAt: true },
    })).resolves.toMatchObject({ archivedAt: expect.any(Date) });
    await expect(prisma.goal.findUniqueOrThrow({
      where: { id: goalId },
      select: { archivedAt: true },
    })).resolves.toMatchObject({ archivedAt: expect.any(Date) });
    await expect(prisma.workspaceArchiveRecord.count({
      where: { entityType: "Action", entityId: actionId, restoredAt: null },
    })).resolves.toBe(1);
    await expect(prisma.workspaceArchiveRecord.count({
      where: { entityType: "Goal", entityId: goalId, restoredAt: null },
    })).resolves.toBe(1);
  });

  it("allows ordinary non-receipt Action and Goal restore", async () => {
    const { actor, workspaceId, userId } = await createValidationAdmin();
    const action = await prisma.action.create({
      data: {
        workspaceId,
        authorUserId: userId,
        title: "Ordinary action",
        status: "DRAFT",
        isPrivate: true,
      },
    });
    const goal = await prisma.goal.create({
      data: {
        workspaceId,
        authorUserId: userId,
        title: "Ordinary goal",
        descriptionMd: "Non-receipt goal",
        status: "DRAFT",
        isPrivate: true,
      },
    });

    await archiveWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Action",
      entityId: action.id,
      reason: "ordinary restore proof",
    });
    await archiveWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      reason: "ordinary restore proof",
    });

    await expect(restoreWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Action",
      entityId: action.id,
    })).resolves.toMatchObject({ archivedAt: null });
    await expect(restoreWorkspaceArtifact(actor, {
      workspaceId,
      entityType: "Goal",
      entityId: goal.id,
    })).resolves.toMatchObject({ archivedAt: null });
  });

  it("allows non-action deliberation entries while blocking action relations after cleanup starts", async () => {
    const { actor, workspaceId, userId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "103",
      workflowRunAttempt: 1,
    });
    const actionId = provisioned.receipt.actionId;
    if (!actionId) throw new Error("Provisioned receipt missing Action.");

    await prisma.productionValidationReceipt.update({
      where: { id: provisioned.receipt.id },
      data: { cleanupStartedAt: new Date() },
    });

    await expect(prisma.deliberationEntry.create({
      data: {
        workspaceId,
        parentType: "TENSION",
        parentId: actionId,
        authorUserId: userId,
        entryType: "REACTION",
        bodyMd: "Non-action deliberation remains allowed after action cleanup starts.",
      },
    })).resolves.toMatchObject({ parentType: "TENSION", parentId: actionId });

    await expect(prisma.deliberationEntry.create({
      data: {
        workspaceId,
        parentType: "ACTION",
        parentId: actionId,
        authorUserId: userId,
        entryType: "REACTION",
        bodyMd: "Action deliberation should be blocked after action cleanup starts.",
      },
    })).rejects.toThrow(/production validation Action cleanup already started/);
  });

  it("counts existing Action advice processes as cleanup relations", async () => {
    const { actor, workspaceId, memberId } = await createValidationAdmin();
    const provisioned = await proveProvisionedFeature(actor, "106");
    const actionId = provisioned.receipt.actionId;
    if (!actionId) throw new Error("Provisioned receipt missing Action.");
    await prisma.adviceProcess.create({
      data: {
        workspaceId,
        authorMemberId: memberId,
        subjectType: "ACTION",
        subjectId: actionId,
      },
    });

    const status = await getPr976ActionGoalValidationStatus(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "106",
      workflowRunAttempt: 1,
    });
    expect(status.action?.relationCounts).toMatchObject({ adviceProcesses: 1 });

    const terminalized = await terminalizePr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      workflowRunId: "106",
      workflowRunAttempt: 1,
      mode: "action",
    });
    expect(terminalized.receipt.actionState).toBe("BLOCKED");
    await expect(prisma.action.findUniqueOrThrow({ where: { id: actionId } })).resolves.toMatchObject({ archivedAt: null });
  });

  it("blocks Action advice process inserts and subject updates after cleanup starts while allowing unrelated subjects", async () => {
    const { actor, workspaceId, memberId } = await createValidationAdmin();
    const provisioned = await provisionPr976ActionGoalValidation(actor, {
      operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
      deployedSha: "1".repeat(40),
      ancestorSha: PR976_TARGET_RELEASE_SHA,
      workflowRunId: "107",
      workflowRunAttempt: 1,
    });
    const actionId = provisioned.receipt.actionId;
    if (!actionId) throw new Error("Provisioned receipt missing Action.");
    await prisma.productionValidationReceipt.update({
      where: { id: provisioned.receipt.id },
      data: { cleanupStartedAt: new Date() },
    });

    await expect(prisma.adviceProcess.create({
      data: {
        workspaceId,
        authorMemberId: memberId,
        subjectType: "PROPOSAL",
        subjectId: actionId,
      },
    })).resolves.toMatchObject({ subjectType: "PROPOSAL", subjectId: actionId });
    await expect(prisma.adviceProcess.create({
      data: {
        workspaceId,
        authorMemberId: memberId,
        subjectType: "ACTION",
        subjectId: "unrelated-action",
      },
    })).resolves.toMatchObject({ subjectType: "ACTION", subjectId: "unrelated-action" });
    await expect(prisma.adviceProcess.create({
      data: {
        workspaceId,
        authorMemberId: memberId,
        subjectType: "ACTION",
        subjectId: actionId,
      },
    })).rejects.toThrow(/production validation Action cleanup already started/);

    const existing = await prisma.adviceProcess.create({
      data: {
        workspaceId,
        authorMemberId: memberId,
        subjectType: "PROPOSAL",
        subjectId: "proposal-subject",
      },
    });
    await expect(prisma.adviceProcess.update({
      where: { id: existing.id },
      data: {
        subjectType: "ACTION",
        subjectId: actionId,
      },
    })).rejects.toThrow(/production validation Action cleanup already started/);
  });
});
