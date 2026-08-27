import { isDeepStrictEqual } from "node:util";
import { Prisma, type ProductionValidationLifecycleState, type ProductionValidationOutcome } from "@prisma/client";
import { prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { acquireWorkItemAdvisoryLock } from "./work-item-versions";

export const PR976_ACTION_GOAL_OPERATION_KEY = "pr976-action-goal-production-validation";
export const PR976_TARGET_PULL_REQUEST = 976;
export const PR976_TARGET_RELEASE_SHA = "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771";
export const PR976_VALIDATION_WORKSPACE_SLUG = "corgtex-validation";
export const PR976_SYNTHETIC_MARKER = "corgtex:production-validation:pr976:action-goal";
export const PR976_ACTION_BASELINE_BODY = `${PR976_SYNTHETIC_MARKER}:action:baseline`;
export const PR976_ACTION_PROVEN_BODY = `${PR976_SYNTHETIC_MARKER}:action:proven`;
export const PR976_GOAL_UPDATE_BODY = `${PR976_SYNTHETIC_MARKER}:goal:progress-proof`;
export const PR976_GOAL_PROVEN_PROGRESS = 37;

type ReceiptTarget = "action" | "goal" | "credential";
type TerminalizeMode = "all" | ReceiptTarget;

type ValidationReceipt = Prisma.ProductionValidationReceiptGetPayload<Record<string, never>>;

type TargetCleanupResult = {
  state: ProductionValidationLifecycleState;
  archiveRecordId: string | null;
};

type CleanupTargetHistory = {
  id: string | null;
};

type ActionDerivedWorkState = {
  pendingJobIds: string[];
  runningJobIds: string[];
};

type ExecutionIdentity = {
  operationKey: string;
  workflowRunId: string;
  workflowRunAttempt: number;
};

export type Pr976ProvisionInput = {
  operationKey: string;
  deployedSha: string;
  ancestorSha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
};

export type Pr976FeatureProofInput = {
  operationKey: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  actionObservedBodyMd: string;
  actionObservedVersion: number;
  goalObservedProgress: number;
  goalObservedVersion: number;
};

export type Pr976TerminalizeInput = {
  operationKey: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  mode?: TerminalizeMode;
  failureCode?: string | null;
  failureMessage?: string | null;
};

function digest(value: string) {
  return sha256(value);
}

function appendTransition(receipt: { transitions: unknown }, entry: Record<string, unknown>) {
  const existing = Array.isArray(receipt.transitions) ? receipt.transitions : [];
  return [...existing, { ...entry, at: new Date().toISOString() }] as Prisma.InputJsonArray;
}

function syntheticTitle(target: "Action" | "Goal") {
  return `${PR976_SYNTHETIC_MARKER}:${target}`;
}

function publicReceipt(receipt: ValidationReceipt) {
  return {
    id: receipt.id,
    operationKey: receipt.operationKey,
    workspaceId: receipt.workspaceId,
    targetPullRequest: receipt.targetPullRequest,
    targetReleaseSha: receipt.targetReleaseSha,
    deployedSha: receipt.deployedSha,
    ancestorSha: receipt.ancestorSha,
    workflowRunId: receipt.workflowRunId,
    workflowRunAttempt: receipt.workflowRunAttempt,
    syntheticMarker: receipt.syntheticMarker,
    actionId: receipt.actionId,
    goalId: receipt.goalId,
    agentCredentialId: receipt.agentCredentialId,
    actionBaselineVersion: receipt.actionBaselineVersion,
    goalBaselineVersion: receipt.goalBaselineVersion,
    actionExpectedDigest: receipt.actionExpectedDigest,
    actionObservedDigest: receipt.actionObservedDigest,
    goalExpectedProgress: receipt.goalExpectedProgress,
    goalObservedProgress: receipt.goalObservedProgress,
    actionState: receipt.actionState,
    goalState: receipt.goalState,
    credentialState: receipt.credentialState,
    outcome: receipt.outcome,
    actionArchiveRecordId: receipt.actionArchiveRecordId,
    goalArchiveRecordId: receipt.goalArchiveRecordId,
    cleanupStartedAt: receipt.cleanupStartedAt,
    completedAt: receipt.completedAt,
    claimedAt: receipt.claimedAt,
    featureProvenAt: receipt.featureProvenAt,
    terminalizedAt: receipt.terminalizedAt,
    failureCode: receipt.failureCode,
    failureMessage: receipt.failureMessage,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

async function requireValidationAdmin(actor: AppActor) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: PR976_VALIDATION_WORKSPACE_SLUG },
    select: { id: true, slug: true },
  });
  invariant(workspace, 404, "VALIDATION_WORKSPACE_NOT_FOUND", "Production validation workspace not found.");
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: workspace.id,
    allowedRoles: ["ADMIN"],
  });
  return { workspace, membership };
}

function assertFixedProvisionInput(input: Pr976ProvisionInput) {
  invariant(input.operationKey === PR976_ACTION_GOAL_OPERATION_KEY, 400, "INVALID_OPERATION", "Unsupported production validation operation.");
  invariant(input.deployedSha.length === 40 && input.ancestorSha === PR976_TARGET_RELEASE_SHA, 400, "INVALID_TARGET", "Invalid production validation target.");
  assertExecutionIdentity(input);
}

function assertExecutionIdentity(input: ExecutionIdentity) {
  invariant(input.operationKey === PR976_ACTION_GOAL_OPERATION_KEY, 400, "INVALID_OPERATION", "Unsupported production validation operation.");
  invariant(input.workflowRunId.length > 0 && input.workflowRunId.length <= 80, 400, "INVALID_INPUT", "workflowRunId is required.");
  invariant(Number.isInteger(input.workflowRunAttempt) && input.workflowRunAttempt > 0 && input.workflowRunAttempt <= 100, 400, "INVALID_INPUT", "workflowRunAttempt must be a positive integer.");
}

function assertReceiptClaim(receipt: { operationKey: string; targetPullRequest: number; targetReleaseSha: string; syntheticMarker: string }) {
  invariant(receipt.operationKey === PR976_ACTION_GOAL_OPERATION_KEY, 409, "RECEIPT_MISMATCH", "Receipt operation mismatch.");
  invariant(receipt.targetPullRequest === PR976_TARGET_PULL_REQUEST, 409, "RECEIPT_MISMATCH", "Receipt pull request mismatch.");
  invariant(receipt.targetReleaseSha === PR976_TARGET_RELEASE_SHA, 409, "RECEIPT_MISMATCH", "Receipt target SHA mismatch.");
  invariant(receipt.syntheticMarker === PR976_SYNTHETIC_MARKER, 409, "RECEIPT_MISMATCH", "Receipt marker mismatch.");
}

function assertImmutableReceiptClaim(
  receipt: ValidationReceipt,
  input: Pr976ProvisionInput,
  workspaceId: string,
) {
  assertReceiptClaim(receipt);
  invariant(receipt.workspaceId === workspaceId, 403, "FORBIDDEN", "Receipt is outside the validation workspace.");
  invariant(
    receipt.deployedSha === input.deployedSha
    && receipt.ancestorSha === input.ancestorSha
    && receipt.workflowRunId === input.workflowRunId
    && receipt.workflowRunAttempt === input.workflowRunAttempt,
    409,
    "RECEIPT_ALREADY_CLAIMED",
    "Production validation receipt is already claimed for a different run.",
  );
}

async function readLockedReceiptById(tx: Prisma.TransactionClient, receiptId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ProductionValidationReceipt" WHERE "id" = ${receiptId} FOR UPDATE
  `;
  invariant(rows.length === 1, 404, "NOT_FOUND", "Production validation receipt not found.");
  return tx.productionValidationReceipt.findUniqueOrThrow({ where: { id: receiptId } });
}

async function readLockedReceiptByExecution(tx: Prisma.TransactionClient, input: ExecutionIdentity) {
  assertExecutionIdentity(input);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ProductionValidationReceipt"
    WHERE "operationKey" = ${input.operationKey}
      AND "workflowRunId" = ${input.workflowRunId}
      AND "workflowRunAttempt" = ${input.workflowRunAttempt}
    FOR UPDATE
  `;
  invariant(rows.length === 1, 404, "NOT_FOUND", "Production validation receipt not found.");
  return tx.productionValidationReceipt.findUniqueOrThrow({ where: { id: rows[0]!.id } });
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function actorLabel(actor: AppActor) {
  return actor.kind === "user"
    ? (actor.user.displayName || actor.user.email || actor.user.id)
    : (actor.label || actor.authProvider || "agent");
}

function requireUserActor(actor: AppActor) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Production validation requires a user ADMIN session.");
}

async function createReceipt(
  actor: AppActor,
  input: Pr976ProvisionInput,
  workspaceId: string,
) {
  try {
    return {
      receipt: await prisma.productionValidationReceipt.create({
        data: {
          operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
          workspaceId,
          targetPullRequest: PR976_TARGET_PULL_REQUEST,
          targetReleaseSha: PR976_TARGET_RELEASE_SHA,
          deployedSha: input.deployedSha,
          ancestorSha: input.ancestorSha,
          workflowRunId: input.workflowRunId,
          workflowRunAttempt: input.workflowRunAttempt,
          syntheticMarker: PR976_SYNTHETIC_MARKER,
          transitions: appendTransition({ transitions: [] }, {
            type: "CLAIMED",
            actor: actorLabel(actor),
            deployedSha: input.deployedSha,
            workflowRunId: input.workflowRunId,
            workflowRunAttempt: input.workflowRunAttempt,
          }),
        },
      }),
      created: true,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.productionValidationReceipt.findUniqueOrThrow({
        where: {
          ProductionValidationReceipt_operationKey_workflowRunId_work_key: {
            operationKey: PR976_ACTION_GOAL_OPERATION_KEY,
            workflowRunId: input.workflowRunId,
            workflowRunAttempt: input.workflowRunAttempt,
          },
        },
      });
      assertReceiptClaim(existing);
      return { receipt: existing, created: false };
    }
    throw error;
  }
}

async function ensureProvisionedResources(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  receipt: ValidationReceipt,
  membership: MembershipSummary | null,
) {
  if (receipt.outcome !== "PENDING") return { receipt, token: null };
  if (receipt.actionId && receipt.goalId && receipt.agentCredentialId) return { receipt, token: null };

  const authorUserId = actorUserId(actor);
  invariant(authorUserId, 403, "FORBIDDEN", "Production validation provisioning requires a user ADMIN session.");

  const action = receipt.actionId
    ? await tx.action.findUniqueOrThrow({ where: { id: receipt.actionId } })
    : await tx.action.create({
      data: {
        workspaceId: receipt.workspaceId,
        authorUserId,
        title: syntheticTitle("Action"),
        bodyMd: PR976_ACTION_BASELINE_BODY,
        status: "DRAFT",
        priority: 0,
        isPrivate: true,
        publishedAt: null,
      },
    });

  const goal = receipt.goalId
    ? await tx.goal.findUniqueOrThrow({ where: { id: receipt.goalId } })
    : await tx.goal.create({
      data: {
        workspaceId: receipt.workspaceId,
        authorUserId,
        title: syntheticTitle("Goal"),
        descriptionMd: PR976_SYNTHETIC_MARKER,
        level: "COMPANY",
        cadence: "QUARTERLY",
        status: "DRAFT",
        progressPercent: 0,
        isPrivate: true,
        publishedAt: null,
      },
    });

  let credentialId = receipt.agentCredentialId;
  let token: string | null = null;
  if (!credentialId) {
    const secret = randomOpaqueToken();
    const credential = await tx.agentCredential.create({
      data: {
        workspaceId: receipt.workspaceId,
        createdByUserId: authorUserId,
        label: `${PR976_SYNTHETIC_MARKER}:credential`,
        tokenHash: sha256(secret),
        scopes: ["goals:read", "goals:write"],
        reasonMd: `Temporary credential for ${PR976_ACTION_GOAL_OPERATION_KEY}.`,
        monthlyBudgetCents: 0,
        dailyCallLimit: 10,
        isActive: true,
      },
      select: { id: true },
    });
    credentialId = credential.id;
    token = `agentc-${secret}`;
  }

  const updated = await tx.productionValidationReceipt.update({
    where: { id: receipt.id },
    data: {
      actionId: action.id,
      goalId: goal.id,
      agentCredentialId: credentialId,
      actionBaselineVersion: action.version,
      goalBaselineVersion: goal.version,
      actionExpectedDigest: digest(PR976_ACTION_PROVEN_BODY),
      goalExpectedProgress: PR976_GOAL_PROVEN_PROGRESS,
      actionState: "PROVISIONED",
      goalState: "PROVISIONED",
      credentialState: "PROVISIONED",
      transitions: appendTransition(receipt, {
        type: "PROVISIONED",
        actionId: action.id,
        goalId: goal.id,
        agentCredentialId: credentialId,
        membershipId: membership?.id ?? null,
      }),
    },
  });

  return { receipt: updated, token };
}

export async function provisionPr976ActionGoalValidation(actor: AppActor, input: Pr976ProvisionInput) {
  assertFixedProvisionInput(input);
  requireUserActor(actor);
  const { workspace, membership } = await requireValidationAdmin(actor);
  const claim = await createReceipt(actor, input, workspace.id);

  return prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptById(tx, claim.receipt.id);
    assertImmutableReceiptClaim(receipt, input, workspace.id);
    const provisioned = await ensureProvisionedResources(tx, actor, receipt, membership);
    return {
      receipt: publicReceipt(provisioned.receipt),
      credentialToken: provisioned.token,
    };
  });
}

export async function getPr976ActionGoalValidationStatus(actor: AppActor, input: ExecutionIdentity) {
  assertExecutionIdentity(input);
  const { workspace } = await requireValidationAdmin(actor);
  const receipt = await prisma.productionValidationReceipt.findUnique({
    where: {
      ProductionValidationReceipt_operationKey_workflowRunId_work_key: {
        operationKey: input.operationKey,
        workflowRunId: input.workflowRunId,
        workflowRunAttempt: input.workflowRunAttempt,
      },
    },
  });
  invariant(receipt && receipt.workspaceId === workspace.id, 404, "NOT_FOUND", "Production validation receipt not found.");
  assertReceiptClaim(receipt);

  const [action, goal, credential, actionRelations, goalRelations] = await Promise.all([
    receipt.actionId ? prisma.action.findUnique({ where: { id: receipt.actionId } }) : null,
    receipt.goalId ? prisma.goal.findUnique({ where: { id: receipt.goalId } }) : null,
    receipt.agentCredentialId ? prisma.agentCredential.findUnique({ where: { id: receipt.agentCredentialId }, select: { id: true, isActive: true, label: true, scopes: true } }) : null,
    receipt.actionId ? actionCleanupRelations(prisma, receipt.workspaceId, receipt.actionId) : null,
    receipt.goalId ? goalCleanupRelations(prisma, receipt.goalId) : null,
  ]);

  return {
    receipt: publicReceipt(receipt),
    action: action ? {
      id: action.id,
      title: action.title,
      bodyMd: action.bodyMd,
      status: action.status,
      version: action.version,
      isPrivate: action.isPrivate,
      archivedAt: action.archivedAt,
      digest: digest(action.bodyMd ?? ""),
      relationCounts: actionRelations,
    } : null,
    goal: goal ? {
      id: goal.id,
      title: goal.title,
      descriptionMd: goal.descriptionMd,
      status: goal.status,
      progressPercent: goal.progressPercent,
      version: goal.version,
      isPrivate: goal.isPrivate,
      archivedAt: goal.archivedAt,
      relationCounts: goalRelations,
    } : null,
    credential: credential ? {
      id: credential.id,
      label: credential.label,
      scopes: credential.scopes,
      isActive: credential.isActive,
    } : null,
  };
}

export async function recordPr976ActionGoalFeatureProof(actor: AppActor, input: Pr976FeatureProofInput) {
  assertExecutionIdentity(input);
  const { workspace } = await requireValidationAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptByExecution(tx, input);
    assertReceiptClaim(receipt);
    invariant(receipt.workspaceId === workspace.id, 403, "FORBIDDEN", "Receipt is outside the validation workspace.");
    invariant(receipt.outcome === "PENDING", 409, "RECEIPT_TERMINAL", "Receipt is already terminal.");
    invariant(receipt.actionId && receipt.goalId, 409, "NOT_PROVISIONED", "Receipt has not been provisioned.");
    invariant(input.actionObservedBodyMd === PR976_ACTION_PROVEN_BODY, 409, "FEATURE_PROOF_MISMATCH", "Action proof body mismatch.");
    invariant(input.goalObservedProgress === PR976_GOAL_PROVEN_PROGRESS, 409, "FEATURE_PROOF_MISMATCH", "Goal proof progress mismatch.");

    const [action, goal] = await Promise.all([
      tx.action.findUnique({ where: { id: receipt.actionId } }),
      tx.goal.findUnique({ where: { id: receipt.goalId } }),
    ]);
    invariant(action && action.workspaceId === receipt.workspaceId && !action.archivedAt, 409, "FEATURE_PROOF_MISMATCH", "Receipt Action is unavailable.");
    invariant(goal && goal.workspaceId === receipt.workspaceId && !goal.archivedAt, 409, "FEATURE_PROOF_MISMATCH", "Receipt Goal is unavailable.");
    invariant(action.bodyMd === input.actionObservedBodyMd && action.version === input.actionObservedVersion, 409, "FEATURE_PROOF_MISMATCH", "Action proof is not committed.");
    invariant(goal.progressPercent === input.goalObservedProgress && goal.version === input.goalObservedVersion, 409, "FEATURE_PROOF_MISMATCH", "Goal proof is not committed.");

    const updated = await tx.productionValidationReceipt.update({
      where: { id: receipt.id },
      data: {
        actionObservedDigest: digest(action.bodyMd ?? ""),
        goalObservedProgress: goal.progressPercent,
        actionState: "FEATURE_PROVEN",
        goalState: "FEATURE_PROVEN",
        featureProvenAt: new Date(),
        transitions: appendTransition(receipt, {
          type: "FEATURE_PROVEN",
          actionVersion: action.version,
          goalVersion: goal.version,
        }),
      },
    });
    return { receipt: publicReceipt(updated) };
  });
}

async function actionCleanupRelations(db: Pick<Prisma.TransactionClient, "actionChecklistItem" | "workItemEvidence" | "workspaceExternalResourceAttachment" | "deliberationEntry" | "adviceProcess">, workspaceId: string, actionId: string) {
  const [checklistItems, evidence, externalAttachments, deliberationEntries, adviceProcesses] = await Promise.all([
    db.actionChecklistItem.count({ where: { workspaceId, actionId } }),
    db.workItemEvidence.count({ where: { workspaceId, entityType: "Action", entityId: actionId } }),
    db.workspaceExternalResourceAttachment.count({ where: { workspaceId, entityType: "Action", entityId: actionId } }),
    db.deliberationEntry.count({ where: { workspaceId, parentType: "ACTION", parentId: actionId } }),
    db.adviceProcess.count({ where: { workspaceId, subjectType: "ACTION", subjectId: actionId } }),
  ]);
  return { checklistItems, evidence, externalAttachments, deliberationEntries, adviceProcesses };
}

async function actionDerivedWorkState(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actionId: string,
): Promise<ActionDerivedWorkState> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: "PENDING" | "RUNNING" }>>`
    SELECT "id", "status"
    FROM "WorkflowJob"
    WHERE "workspaceId" = ${workspaceId}
      AND "status" IN ('PENDING', 'RUNNING')
      AND (
        ("type" = 'knowledge.sync.action' AND "payload" @> ${JSON.stringify({ actionId })}::jsonb)
        OR ("type" = 'context-graph.sync' AND "payload" @> ${JSON.stringify({ sourceType: "ACTION", sourceId: actionId })}::jsonb)
      )
    ORDER BY "id" ASC
    FOR UPDATE
  `;
  return {
    pendingJobIds: rows.filter((row) => row.status === "PENDING").map((row) => row.id),
    runningJobIds: rows.filter((row) => row.status === "RUNNING").map((row) => row.id),
  };
}

async function clearActionDerivedWork(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actionId: string,
): Promise<"CLEARED"> {
  const jobs = await actionDerivedWorkState(tx, workspaceId, actionId);
  if (jobs.runningJobIds.length > 0) {
    throw new Error("Action-derived workflow job is still running; retry cleanup after the worker releases it.");
  }
  if (jobs.pendingJobIds.length > 0) {
    await tx.workflowJob.updateMany({
      where: { id: { in: jobs.pendingJobIds }, workspaceId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        error: "Cancelled by production validation cleanup for synthetic Action.",
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
  await tx.knowledgeChunk.deleteMany({
    where: { workspaceId, sourceType: "ACTION", sourceId: actionId },
  });
  await tx.contextGraphRelationship.deleteMany({
    where: { workspaceId, sourceEntityType: "Action", sourceEntityId: actionId },
  });
  await tx.contextGraphObject.deleteMany({
    where: { workspaceId, sourceEntityType: "Action", sourceEntityId: actionId },
  });
  return "CLEARED";
}

async function goalCleanupRelations(db: Pick<Prisma.TransactionClient, "goal" | "goalUpdate" | "goalLink" | "keyResult" | "recognition">, goalId: string) {
  const [childGoals, keyResults, updates, links, recognitions] = await Promise.all([
    db.goal.count({ where: { parentGoalId: goalId } }),
    db.keyResult.count({ where: { goalId } }),
    db.goalUpdate.count({ where: { goalId } }),
    db.goalLink.count({ where: { goalId } }),
    db.recognition.count({ where: { goalId } }),
  ]);
  return { childGoals, keyResults, updates, links, recognitions };
}

function allZero(values: Record<string, number>) {
  return Object.values(values).every((value) => value === 0);
}

function jsonEqual(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, JSON.parse(JSON.stringify(right)));
}

async function readCanonicalTargetHistory(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    entityType: "Action" | "Goal";
    entityId: string;
    baselineVersion: number | null;
    changedFields: string[];
    previousState: Prisma.InputJsonValue;
    required: boolean;
  },
): Promise<CleanupTargetHistory | null> {
  await acquireWorkItemAdvisoryLock(tx, params.entityType, params.entityId);
  const history = await tx.workItemVersion.findMany({
    where: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    orderBy: { version: "asc" },
    select: {
      id: true,
      workspaceId: true,
      entityType: true,
      entityId: true,
      version: true,
      changedFields: true,
      previousState: true,
      source: true,
    },
  });
  if (!params.required) return history.length === 0 ? { id: null } : null;
  if (params.baselineVersion === null) return null;
  if (history.length !== 1) return null;
  const [row] = history;
  if (!row) return null;
  const canonical = row.workspaceId === params.workspaceId
    && row.entityType === params.entityType
    && row.entityId === params.entityId
    && row.version === params.baselineVersion
    && row.source === "WEB"
    && jsonEqual(row.changedFields, params.changedFields)
    && jsonEqual(row.previousState, params.previousState);
  return canonical ? { id: row.id } : null;
}

async function deleteCanonicalTargetHistory(
  tx: Prisma.TransactionClient,
  history: CleanupTargetHistory,
) {
  if (history.id === null) return;
  const deleted = await tx.workItemVersion.deleteMany({ where: { id: history.id } });
  invariant(deleted.count === 1, 409, "TARGET_HISTORY_CHANGED", "Production validation target history changed during cleanup.");
}

function terminalOutcome(states: {
  actionState: ProductionValidationLifecycleState;
  goalState: ProductionValidationLifecycleState;
  credentialState: ProductionValidationLifecycleState;
  hasFailure: boolean;
}): ProductionValidationOutcome {
  if (states.actionState === "CLEANED" && states.goalState === "CLEANED" && states.credentialState === "CLEANED" && states.hasFailure) return "FAILED";
  if (states.actionState === "CLEANED" && states.goalState === "CLEANED" && states.credentialState === "CLEANED") return "COMPLETED";
  if (states.actionState === "BLOCKED" || states.goalState === "BLOCKED" || states.credentialState === "BLOCKED") return "BLOCKED";
  return "PENDING";
}

function isConfirmedCleanupBlocker(error: unknown) {
  return error instanceof AppError;
}

async function terminalizeAction(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  receipt: ValidationReceipt,
): Promise<TargetCleanupResult> {
  if (receipt.actionState === "CLEANED" || receipt.actionState === "BLOCKED") {
    return { state: receipt.actionState, archiveRecordId: receipt.actionArchiveRecordId };
  }
  if (!receipt.actionId) return { state: "BLOCKED" as const, archiveRecordId: null };
  await acquireWorkItemAdvisoryLock(tx, "Action", receipt.actionId);
  const action = await tx.action.findUnique({ where: { id: receipt.actionId } });
  const counts = await actionCleanupRelations(tx, receipt.workspaceId, receipt.actionId);
  const expectedBody = receipt.failureCode ? [PR976_ACTION_BASELINE_BODY, PR976_ACTION_PROVEN_BODY] : [PR976_ACTION_PROVEN_BODY];
  const proven = action?.bodyMd === PR976_ACTION_PROVEN_BODY;
  const expectedVersion = receipt.failureCode && action?.bodyMd === PR976_ACTION_BASELINE_BODY
    ? receipt.actionBaselineVersion
    : receipt.actionBaselineVersion! + 1;
  const targetHistory = action ? await readCanonicalTargetHistory(tx, {
    workspaceId: receipt.workspaceId,
    entityType: "Action",
    entityId: receipt.actionId,
    baselineVersion: receipt.actionBaselineVersion,
    changedFields: ["bodyMd"],
    previousState: {
      id: action.id,
      workspaceId: action.workspaceId,
      title: action.title,
      bodyMd: PR976_ACTION_BASELINE_BODY,
      priority: action.priority,
      circleId: action.circleId,
      assigneeMemberId: action.assigneeMemberId,
      dueAt: action.dueAt,
      proposalId: action.proposalId,
      status: action.status,
      version: receipt.actionBaselineVersion,
    },
    required: proven,
  }) : null;
  const canArchive = action
    && action.workspaceId === receipt.workspaceId
    && action.title === syntheticTitle("Action")
    && expectedBody.includes(action.bodyMd ?? "")
    && action.status === "DRAFT"
    && action.isPrivate
    && action.version === expectedVersion
    && !action.archivedAt
    && allZero(counts)
    && targetHistory;
  if (!canArchive) return { state: "BLOCKED" as const, archiveRecordId: null };
  await clearActionDerivedWork(tx, receipt.workspaceId, receipt.actionId);
  const archivedAt = new Date();
  await deleteCanonicalTargetHistory(tx, targetHistory);
  await tx.action.update({
    where: { id: action.id, workspaceId: receipt.workspaceId, archivedAt: null, version: action.version },
    data: {
      archivedAt,
      archivedByUserId: actorUserId(actor),
      archiveReason: `Archived by ${PR976_ACTION_GOAL_OPERATION_KEY}.`,
    },
  });
  const archiveRecord = await tx.workspaceArchiveRecord.create({
    data: {
      workspaceId: receipt.workspaceId,
      entityType: "Action",
      entityId: action.id,
      entityLabel: action.title,
      previousState: JSON.parse(JSON.stringify(action)) as Prisma.InputJsonObject,
      archiveReason: `Archived by ${PR976_ACTION_GOAL_OPERATION_KEY}.`,
      archivedByUserId: actorUserId(actor),
      archivedByLabel: actorLabel(actor),
      archivedAt,
    },
    select: { id: true },
  });
  return { state: "CLEANED" as const, archiveRecordId: archiveRecord.id };
}

async function terminalizeGoal(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  receipt: ValidationReceipt,
): Promise<TargetCleanupResult> {
  if (receipt.goalState === "CLEANED" || receipt.goalState === "BLOCKED") {
    return { state: receipt.goalState, archiveRecordId: receipt.goalArchiveRecordId };
  }
  if (!receipt.goalId) return { state: "BLOCKED" as const, archiveRecordId: null };
  await acquireWorkItemAdvisoryLock(tx, "Goal", receipt.goalId);
  const goal = await tx.goal.findUnique({ where: { id: receipt.goalId } });
  const counts = await goalCleanupRelations(tx, receipt.goalId);
  const expectedProgress = receipt.failureCode && goal?.progressPercent === 0
    ? 0
    : PR976_GOAL_PROVEN_PROGRESS;
  const proven = goal?.progressPercent === PR976_GOAL_PROVEN_PROGRESS;
  const expectedVersion = receipt.failureCode && goal?.progressPercent === 0
    ? receipt.goalBaselineVersion
    : receipt.goalBaselineVersion! + 1;
  const targetHistory = goal ? await readCanonicalTargetHistory(tx, {
    workspaceId: receipt.workspaceId,
    entityType: "Goal",
    entityId: receipt.goalId,
    baselineVersion: receipt.goalBaselineVersion,
    changedFields: ["progressPercent"],
    previousState: {
      id: goal.id,
      workspaceId: goal.workspaceId,
      title: goal.title,
      descriptionMd: goal.descriptionMd,
      level: goal.level,
      cadence: goal.cadence,
      progressPercent: 0,
      targetDate: goal.targetDate,
      startDate: goal.startDate,
      parentGoalId: goal.parentGoalId,
      circleId: goal.circleId,
      ownerMemberId: goal.ownerMemberId,
      authorUserId: goal.authorUserId,
      isPrivate: goal.isPrivate,
      publishedAt: goal.publishedAt,
      status: goal.status,
      version: receipt.goalBaselineVersion,
    },
    required: proven,
  }) : null;
  const canArchive = goal
    && goal.workspaceId === receipt.workspaceId
    && goal.title === syntheticTitle("Goal")
    && goal.descriptionMd === PR976_SYNTHETIC_MARKER
    && goal.status === "DRAFT"
    && goal.isPrivate
    && goal.progressPercent === expectedProgress
    && goal.version === expectedVersion
    && !goal.archivedAt
    && allZero(counts)
    && targetHistory;
  if (!canArchive) return { state: "BLOCKED" as const, archiveRecordId: null };
  const archivedAt = new Date();
  await deleteCanonicalTargetHistory(tx, targetHistory);
  await tx.goal.update({
    where: { id: goal.id, workspaceId: receipt.workspaceId, archivedAt: null, version: goal.version },
    data: {
      archivedAt,
      archivedByUserId: actorUserId(actor),
      archiveReason: `Archived by ${PR976_ACTION_GOAL_OPERATION_KEY}.`,
    },
  });
  const archiveRecord = await tx.workspaceArchiveRecord.create({
    data: {
      workspaceId: receipt.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      entityLabel: goal.title,
      previousState: JSON.parse(JSON.stringify(goal)) as Prisma.InputJsonObject,
      archiveReason: `Archived by ${PR976_ACTION_GOAL_OPERATION_KEY}.`,
      archivedByUserId: actorUserId(actor),
      archivedByLabel: actorLabel(actor),
      archivedAt,
    },
    select: { id: true },
  });
  return { state: "CLEANED" as const, archiveRecordId: archiveRecord.id };
}

async function terminalizeCredential(tx: Prisma.TransactionClient, receipt: ValidationReceipt) {
  if (receipt.credentialState === "CLEANED" || receipt.credentialState === "BLOCKED") return receipt.credentialState;
  if (!receipt.agentCredentialId) return "BLOCKED" as const;
  const credentials = await tx.$queryRaw<Array<{
    id: string;
    workspaceId: string;
    catalogItemId: string | null;
    label: string;
    scopes: string[];
    reasonMd: string | null;
    monthlyBudgetCents: number | null;
    dailyCallLimit: number | null;
    isActive: boolean;
    lastUsedAt: Date | null;
  }>>`
    SELECT
      "id",
      "workspaceId",
      "catalogItemId",
      "label",
      "scopes",
      "reasonMd",
      "monthlyBudgetCents",
      "dailyCallLimit",
      "isActive",
      "lastUsedAt"
    FROM "AgentCredential"
    WHERE "id" = ${receipt.agentCredentialId}
    FOR UPDATE
  `;
  const credential = credentials[0];
  if (!credential) return "BLOCKED" as const;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('production_validation_credential'), hashtext(${credential.id}))
  `;
  const linkedIdentityCount = await tx.agentIdentity.count({
    where: { linkedCredentialId: credential.id },
  });
  const canonicalScopes = ["goals:read", "goals:write"];
  const isCanonicalCredential = credential.workspaceId === receipt.workspaceId
    && credential.label === `${PR976_SYNTHETIC_MARKER}:credential`
    && credential.catalogItemId === null
    && credential.reasonMd === `Temporary credential for ${PR976_ACTION_GOAL_OPERATION_KEY}.`
    && credential.monthlyBudgetCents === 0
    && credential.dailyCallLimit === 10
    && credential.isActive
    && credential.lastUsedAt === null
    && credential.scopes.length === canonicalScopes.length
    && credential.scopes.every((scope, index) => scope === canonicalScopes[index])
    && linkedIdentityCount === 0;
  if (!isCanonicalCredential) {
    if (credential.isActive) {
      await tx.agentCredential.update({
        where: { id: credential.id },
        data: { isActive: false },
      });
    }
    return "BLOCKED" as const;
  }
  await tx.agentCredential.update({
    where: { id: credential.id },
    data: { isActive: false },
  });
  return "CLEANED" as const;
}

function boundedFailureMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown production validation cleanup failure.";
}

function isRetryableCleanupFailureCode(code: string | null) {
  return code === "RETRYABLE_TARGET_CLEANUP_FAILED";
}

async function markTargetBlocked(
  input: ExecutionIdentity,
  target: ReceiptTarget,
  error: unknown,
): Promise<TargetCleanupResult> {
  return prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptByExecution(tx, input);
    const stateField = target === "action" ? "actionState" : target === "goal" ? "goalState" : "credentialState";
    const failureMessage = boundedFailureMessage(error);
    await tx.productionValidationReceipt.update({
      where: { id: receipt.id },
      data: {
        [stateField]: "BLOCKED",
        failureCode: receipt.failureCode ?? "TARGET_CLEANUP_FAILED",
        failureMessage: receipt.failureMessage ?? failureMessage,
        transitions: appendTransition(receipt, {
          type: "TARGET_CLEANUP_FAILED",
          target,
          code: "TARGET_CLEANUP_FAILED",
          message: failureMessage,
        }),
      },
    });
    return { state: "BLOCKED", archiveRecordId: null };
  });
}

async function markTargetRetryable(
  input: ExecutionIdentity,
  target: ReceiptTarget,
  error: unknown,
): Promise<TargetCleanupResult> {
  return prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptByExecution(tx, input);
    const failureMessage = boundedFailureMessage(error);
    await tx.productionValidationReceipt.update({
      where: { id: receipt.id },
      data: {
        failureCode: "RETRYABLE_TARGET_CLEANUP_FAILED",
        failureMessage,
        transitions: appendTransition(receipt, {
          type: "TARGET_CLEANUP_RETRYABLE",
          target,
          code: "RETRYABLE_TARGET_CLEANUP_FAILED",
          message: failureMessage,
        }),
      },
    });
    const state = target === "action" ? receipt.actionState : target === "goal" ? receipt.goalState : receipt.credentialState;
    const archiveRecordId = target === "action" ? receipt.actionArchiveRecordId : target === "goal" ? receipt.goalArchiveRecordId : null;
    return { state, archiveRecordId };
  });
}

async function runTargetCleanup(
  actor: AppActor,
  input: ExecutionIdentity,
  target: ReceiptTarget,
): Promise<TargetCleanupResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const receipt = await readLockedReceiptByExecution(tx, input);
      const result = target === "action"
        ? await terminalizeAction(tx, actor, receipt)
        : target === "goal"
          ? await terminalizeGoal(tx, actor, receipt)
          : { state: await terminalizeCredential(tx, receipt), archiveRecordId: null };
      const stateField = target === "action" ? "actionState" : target === "goal" ? "goalState" : "credentialState";
      const archiveField = target === "action" ? "actionArchiveRecordId" : target === "goal" ? "goalArchiveRecordId" : null;
      await tx.productionValidationReceipt.update({
        where: { id: receipt.id },
        data: {
          [stateField]: result.state,
          ...(archiveField ? { [archiveField]: result.archiveRecordId } : {}),
          transitions: appendTransition(receipt, {
            type: "TARGET_TERMINALIZED",
            target,
            state: result.state,
            archiveRecordId: result.archiveRecordId,
          }),
        },
      });
      return result;
    });
  } catch (error) {
    if (isConfirmedCleanupBlocker(error)) {
      return markTargetBlocked(input, target, error);
    }
    return markTargetRetryable(input, target, error);
  }
}

export async function terminalizePr976ActionGoalValidation(actor: AppActor, input: Pr976TerminalizeInput) {
  assertExecutionIdentity(input);
  const { workspace } = await requireValidationAdmin(actor);
  const mode = input.mode ?? "all";
  const explicitFailureCode = input.failureCode?.trim() || null;

  await prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptByExecution(tx, input);
    assertReceiptClaim(receipt);
    invariant(receipt.workspaceId === workspace.id, 403, "FORBIDDEN", "Receipt is outside the validation workspace.");
    const existingFailureCode = receipt.failureCode?.trim() || null;
    const hasFailure = Boolean(explicitFailureCode ?? (isRetryableCleanupFailureCode(existingFailureCode) ? null : existingFailureCode));
    invariant(
      hasFailure
      || mode !== "all"
      || ((receipt.actionState === "FEATURE_PROVEN" || receipt.actionState === "CLEANED")
        && (receipt.goalState === "FEATURE_PROVEN" || receipt.goalState === "CLEANED")),
      409,
      "FEATURE_NOT_PROVEN",
      "Action and Goal feature proofs are required before successful cleanup.",
    );
    invariant(receipt.actionState === "FEATURE_PROVEN" || receipt.actionState === "CLEANED" || mode !== "action", 409, "FEATURE_NOT_PROVEN", "Action feature proof is incomplete.");
    invariant(receipt.goalState === "FEATURE_PROVEN" || receipt.goalState === "CLEANED" || mode !== "goal", 409, "FEATURE_NOT_PROVEN", "Goal feature proof is incomplete.");

    await tx.productionValidationReceipt.update({
      where: { id: receipt.id },
      data: {
        cleanupStartedAt: receipt.cleanupStartedAt ?? new Date(),
        failureCode: explicitFailureCode ?? (isRetryableCleanupFailureCode(existingFailureCode) ? null : receipt.failureCode),
        failureMessage: input.failureMessage?.slice(0, 500) ?? (isRetryableCleanupFailureCode(existingFailureCode) ? null : receipt.failureMessage),
        transitions: appendTransition(receipt, { type: "TERMINALIZE_STARTED", mode }),
      },
    });
  });

  if (mode === "all" || mode === "action") {
    await runTargetCleanup(actor, input, "action");
  }
  if (mode === "all" || mode === "goal") {
    await runTargetCleanup(actor, input, "goal");
  }
  if (mode === "all" || mode === "credential") {
    await runTargetCleanup(actor, input, "credential");
  }

  const finalized = await prisma.$transaction(async (tx) => {
    const receipt = await readLockedReceiptByExecution(tx, input);
    const outcome = terminalOutcome({
      actionState: receipt.actionState,
      goalState: receipt.goalState,
      credentialState: receipt.credentialState,
      hasFailure: Boolean(receipt.failureCode && !isRetryableCleanupFailureCode(receipt.failureCode)),
    });
    return tx.productionValidationReceipt.update({
      where: { id: receipt.id },
      data: {
        outcome,
        terminalizedAt: outcome === "PENDING" ? null : new Date(),
        completedAt: outcome === "COMPLETED" ? new Date() : null,
        transitions: appendTransition(receipt, {
          type: "TERMINALIZED",
          mode,
          actionState: receipt.actionState,
          goalState: receipt.goalState,
          credentialState: receipt.credentialState,
          outcome,
        }),
      },
    });
  });

  const committed = await prisma.productionValidationReceipt.findUniqueOrThrow({
    where: { id: finalized.id },
  });
  return { receipt: publicReceipt(committed) };
}
