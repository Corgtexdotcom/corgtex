import { createHash } from "node:crypto";

import { prisma } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";

const PENDING_OPERATION_TTL_MS = 15 * 60 * 1000;
const EXECUTING_OPERATION_LEASE_MS = 5 * 60 * 1000;

const STATUS = {
  PENDING: "PENDING",
  EXECUTING: "EXECUTING",
  EXECUTED: "EXECUTED",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;

type PendingOperationStatus = typeof STATUS[keyof typeof STATUS];

type PendingOperationContext = {
  workspaceId: string;
  sessionId: string;
  userId: string | null;
  agentKey: string;
  userMessage: string;
};

export type PendingOperationRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  userId: string | null;
  agentKey: string;
  toolName: string;
  argsJson: unknown;
  argsHash: string;
  idempotencyKey: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  riskLabel: string;
  status: PendingOperationStatus;
  resultJson: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  proposedAt: Date;
  expiresAt: Date;
  executedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PendingOperationIntent = {
  kind: "confirm" | "cancel";
  pendingOperationId: string | null;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSafe(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalize(entry);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function operationArgsHash(toolName: string, args: unknown) {
  return hash(stableJson({ toolName, args }));
}

function operationIdempotencyKey(ctx: PendingOperationContext, toolName: string, argsHash: string) {
  const messageHash = hash(ctx.userMessage.trim()).slice(0, 16);
  return `crm-pending:${ctx.sessionId}:${toolName}:${messageHash}:${argsHash.slice(0, 24)}`;
}

function retryIdempotencyKeyPrefix(idempotencyKey: string) {
  return `${idempotencyKey}:retry:`;
}

function relatedEntity(toolName: string, args: Record<string, unknown>) {
  if (toolName === "complete_relationship_activity" && typeof args.activityId === "string") {
    return { type: "CrmActivity", id: args.activityId };
  }
  if (typeof args.activityId === "string") return { type: "CrmActivity", id: args.activityId };
  if (typeof args.accountId === "string") return { type: "CrmAccount", id: args.accountId };
  if (typeof args.contactId === "string") return { type: "CrmContact", id: args.contactId };
  if (typeof args.dealId === "string") return { type: "CrmDeal", id: args.dealId };
  return { type: null, id: null };
}

function riskLabel(toolName: string) {
  if (toolName === "complete_relationship_activity") return "crm-write:complete-activity";
  if (toolName === "create_communication_suggestion") return "crm-write:create-suggestion";
  return "crm-write:record-activity";
}

function pendingOperationIdFromMessage(message: string) {
  return message.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0] ?? null;
}

function normalizedUserId(userId: string | null) {
  const trimmed = userId?.trim();
  return trimmed ? trimmed : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function crmPendingOperationIntent(message: string): PendingOperationIntent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const pendingOperationId = pendingOperationIdFromMessage(message);
  if (!pendingOperationId) return null;

  const idPattern = escapeRegExp(pendingOperationId);
  const cancelPattern = new RegExp(`^(?:cancel|abort|discard)\\s+(?:pending\\s+operation\\s+)?${idPattern}\\b`, "i");
  if (cancelPattern.test(trimmed)) {
    return { kind: "cancel", pendingOperationId };
  }

  const confirmPattern = new RegExp(
    `^(?:confirm|approve)\\s+(?:pending\\s+operation\\s+)?${idPattern}\\b`,
    "i"
  );
  if (confirmPattern.test(trimmed)) {
    return { kind: "confirm", pendingOperationId };
  }

  return null;
}

export function crmPendingOperationNotice(operation: PendingOperationRecord) {
  const storedArgs = stableJson(operation.argsJson);
  return [
    `Pending operation ID: ${operation.id}`,
    `CRM operation: ${operation.toolName}`,
    `Risk: ${operation.riskLabel}`,
    `Stored args: ${storedArgs}`,
    `Approve by replying "confirm ${operation.id}" or cancel with "cancel ${operation.id}".`,
  ].join("\n");
}

export function crmPendingOperationResultNotice(operation: PendingOperationRecord, result: unknown) {
  const json = jsonSafe(result) as Record<string, any>;
  const activityId = json.activity?.id;
  const suggestionId = json.suggestion?.id;
  const recordLine = activityId
    ? `Activity ID: ${activityId}`
    : suggestionId
      ? `Suggestion ID: ${suggestionId}`
      : "Record ID: unavailable";
  return [
    `Confirmed pending operation ID: ${operation.id}`,
    `CRM operation: ${operation.toolName}`,
    recordLine,
  ].join("\n");
}

export function crmPendingOperationCancelNotice(operation: PendingOperationRecord) {
  return `Canceled pending operation ID: ${operation.id}`;
}

export function crmPendingOperationExpiredNotice(operation: PendingOperationRecord) {
  return `Pending CRM operation ${operation.id} expired before confirmation. Please ask me to prepare the CRM change again.`;
}

export function crmPendingOperationFailedNotice(operation: PendingOperationRecord) {
  const message = operation.errorMessage ? ` ${operation.errorMessage}` : "";
  return `Pending CRM operation ${operation.id} cannot be confirmed because it is ${operation.status.toLowerCase()}.${message}`;
}

async function refreshReusableOperationState(operation: PendingOperationRecord | null, now: Date) {
  if (!operation) return null;

  if (operation.status === STATUS.PENDING && operation.expiresAt <= now) {
    await prisma.conversationPendingOperation.updateMany({
      where: {
        id: operation.id,
        status: STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: STATUS.EXPIRED,
        errorCode: "CRM_PENDING_OPERATION_EXPIRED",
        errorMessage: "The pending operation expired before confirmation.",
      },
    });
    return await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } }) as PendingOperationRecord | null;
  }

  if (operation.status === STATUS.EXECUTING) {
    const leaseCutoff = new Date(now.getTime() - EXECUTING_OPERATION_LEASE_MS);
    if (operation.updatedAt <= leaseCutoff) {
      await prisma.conversationPendingOperation.updateMany({
        where: {
          id: operation.id,
          status: STATUS.EXECUTING,
          updatedAt: { lte: leaseCutoff },
        },
        data: {
          status: STATUS.FAILED,
          errorCode: "CRM_PENDING_OPERATION_EXECUTION_ABANDONED",
          errorMessage: "Execution state is unknown after the operation lease timed out. Check CRM before preparing this change again.",
        },
      });
      return await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } }) as PendingOperationRecord | null;
    }
  }

  return operation;
}

function assertReusableOperationAvailable(operation: PendingOperationRecord | null) {
  if (!operation) return null;
  if (operation.status === STATUS.PENDING) return operation;
  if (operation.status === STATUS.EXECUTING) {
    throw new Error("A matching CRM operation is already executing. Wait for it to finish before preparing the same CRM change again.");
  }
  if (operation.status === STATUS.FAILED && operation.errorCode === "CRM_PENDING_OPERATION_EXECUTION_ABANDONED") {
    throw new Error(operation.errorMessage ?? "A matching CRM operation was left in an uncertain execution state. Check CRM before preparing this change again.");
  }
  return null;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

async function findReusableRetryOperation({
  ctx,
  userId,
  idempotencyKey,
  now,
}: {
  ctx: PendingOperationContext;
  userId: string | null;
  idempotencyKey: string;
  now: Date;
}) {
  const retry = await prisma.conversationPendingOperation.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      conversationId: ctx.sessionId,
      userId,
      agentKey: ctx.agentKey,
      idempotencyKey: { startsWith: retryIdempotencyKeyPrefix(idempotencyKey) },
      status: { in: [STATUS.PENDING, STATUS.EXECUTING] },
    },
    orderBy: { createdAt: "desc" },
  });
  const reusableRetry = await refreshReusableOperationState(retry as PendingOperationRecord | null, now);
  return assertReusableOperationAvailable(reusableRetry);
}

async function nextRetryIdempotencyKey(workspaceId: string, idempotencyKey: string) {
  const retryCount = await prisma.conversationPendingOperation.count({
    where: {
      workspaceId,
      idempotencyKey: { startsWith: retryIdempotencyKeyPrefix(idempotencyKey) },
    },
  });
  return `${retryIdempotencyKeyPrefix(idempotencyKey)}${retryCount + 1}`;
}

async function reloadReusableOperationAfterUniqueConflict({
  ctx,
  userId,
  idempotencyKey,
  attemptedIdempotencyKey,
  now,
}: {
  ctx: PendingOperationContext;
  userId: string | null;
  idempotencyKey: string;
  attemptedIdempotencyKey: string;
  now: Date;
}) {
  const collided = await prisma.conversationPendingOperation.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId: ctx.workspaceId,
        idempotencyKey: attemptedIdempotencyKey,
      },
    },
  });
  const reusableCollided = assertReusableOperationAvailable(
    await refreshReusableOperationState(collided as PendingOperationRecord | null, now)
  );
  if (reusableCollided) return reusableCollided;

  const latestBase = await prisma.conversationPendingOperation.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId: ctx.workspaceId,
        idempotencyKey,
      },
    },
  });
  const reusableBase = assertReusableOperationAvailable(
    await refreshReusableOperationState(latestBase as PendingOperationRecord | null, now)
  );
  if (reusableBase) return reusableBase;

  return await findReusableRetryOperation({ ctx, userId, idempotencyKey, now });
}

export async function createPendingCrmOperation({
  ctx,
  toolName,
  args,
}: {
  ctx: PendingOperationContext;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const argsJson = jsonSafe(args) as Record<string, unknown>;
  const argsHash = operationArgsHash(toolName, argsJson);
  const idempotencyKey = operationIdempotencyKey(ctx, toolName, argsHash);
  const userId = normalizedUserId(ctx.userId);
  const existing = await prisma.conversationPendingOperation.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId: ctx.workspaceId,
        idempotencyKey,
      },
    },
  });
  const now = new Date();
  const reusableExisting = await refreshReusableOperationState(existing as PendingOperationRecord | null, now);
  const reusableBase = assertReusableOperationAvailable(reusableExisting);
  if (reusableBase) return reusableBase;

  const reusablePendingRetry = await findReusableRetryOperation({ ctx, userId, idempotencyKey, now });
  if (reusablePendingRetry) {
    return reusablePendingRetry;
  }

  const related = relatedEntity(toolName, argsJson);
  const attemptedIdempotencyKey = existing
    ? await nextRetryIdempotencyKey(ctx.workspaceId, idempotencyKey)
    : idempotencyKey;
  try {
    return await prisma.conversationPendingOperation.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.sessionId,
        userId,
        agentKey: ctx.agentKey,
        toolName,
        argsJson: argsJson as Prisma.InputJsonValue,
        argsHash,
        idempotencyKey: attemptedIdempotencyKey,
        relatedEntityType: related.type,
        relatedEntityId: related.id,
        riskLabel: riskLabel(toolName),
        expiresAt: new Date(Date.now() + PENDING_OPERATION_TTL_MS),
      },
    }) as PendingOperationRecord;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const reusable = await reloadReusableOperationAfterUniqueConflict({
      ctx,
      userId,
      idempotencyKey,
      attemptedIdempotencyKey,
      now,
    });
    if (reusable) return reusable;
    throw error;
  }
}

export async function findCrmPendingOperationForIntent(ctx: PendingOperationContext, intent: PendingOperationIntent) {
  const userId = normalizedUserId(ctx.userId);
  const where = {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.sessionId,
    userId,
    agentKey: ctx.agentKey,
  };

  if (intent.pendingOperationId) {
    return await prisma.conversationPendingOperation.findFirst({
      where: { ...where, id: intent.pendingOperationId },
      orderBy: { createdAt: "desc" },
    }) as PendingOperationRecord | null;
  }

  return await prisma.conversationPendingOperation.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  }) as PendingOperationRecord | null;
}

export async function cancelCrmPendingOperation(operation: PendingOperationRecord) {
  if (operation.status !== STATUS.PENDING) return operation;
  const canceled = await prisma.conversationPendingOperation.updateMany({
    where: {
      id: operation.id,
      status: STATUS.PENDING,
    },
    data: {
      status: STATUS.CANCELED,
      canceledAt: new Date(),
    },
  });
  const latest = await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } });
  if (canceled.count === 1 && latest) return latest as PendingOperationRecord;
  return (latest ?? operation) as PendingOperationRecord;
}

export async function beginCrmPendingOperationExecution(operation: PendingOperationRecord) {
  if (operation.status === STATUS.EXECUTED) return { state: "already-executed" as const, operation };

  const now = new Date();
  if (operation.status !== STATUS.PENDING) {
    const refreshed = await refreshReusableOperationState(operation, now);
    if (refreshed?.status === STATUS.EXECUTED) {
      return { state: "already-executed" as const, operation: refreshed };
    }
    return { state: "unavailable" as const, operation: refreshed ?? operation };
  }

  if (operation.expiresAt <= now) {
    const expired = await prisma.conversationPendingOperation.updateMany({
      where: {
        id: operation.id,
        status: STATUS.PENDING,
        expiresAt: { lte: now },
      },
      data: {
        status: STATUS.EXPIRED,
        errorCode: "CRM_PENDING_OPERATION_EXPIRED",
        errorMessage: "The pending operation expired before confirmation.",
      },
    });
    const latest = await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } });
    if (expired.count === 1 && latest) return { state: "expired" as const, operation: latest as PendingOperationRecord };
    if (!latest) return { state: "unavailable" as const, operation };
    return { state: latest.status === STATUS.EXECUTED ? "already-executed" as const : "unavailable" as const, operation: latest as PendingOperationRecord };
  }

  const updated = await prisma.conversationPendingOperation.updateMany({
    where: {
      id: operation.id,
      status: STATUS.PENDING,
      expiresAt: { gt: now },
    },
    data: { status: STATUS.EXECUTING },
  });
  if (updated.count === 1) {
    const executing = await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } });
    return { state: "ready" as const, operation: executing as PendingOperationRecord };
  }

  const latest = await prisma.conversationPendingOperation.findUnique({ where: { id: operation.id } });
  if (!latest) return { state: "unavailable" as const, operation };
  return { state: latest?.status === STATUS.EXECUTED ? "already-executed" as const : "unavailable" as const, operation: latest as PendingOperationRecord };
}

export async function markCrmPendingOperationExecuted(operation: PendingOperationRecord, result: unknown) {
  return await prisma.conversationPendingOperation.update({
    where: { id: operation.id },
    data: {
      status: STATUS.EXECUTED,
      resultJson: jsonSafe(result),
      executedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    },
  }) as PendingOperationRecord;
}

export async function markCrmPendingOperationFailed(operation: PendingOperationRecord, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return await prisma.conversationPendingOperation.update({
    where: { id: operation.id },
    data: {
      status: STATUS.FAILED,
      errorCode: "CRM_PENDING_OPERATION_FAILED",
      errorMessage: message,
    },
  }) as PendingOperationRecord;
}
