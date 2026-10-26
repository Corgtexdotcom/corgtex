import { createHash } from "node:crypto";

import { prisma, type AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import {
  AppError, assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof,
  currentArtifactInputRoots, isArtifactInputProofReadable, lineageContentFingerprint, mergeArtifactInputProofs, recordArtifactInputLineage,
  requireWorkspaceMembership, type ArtifactInputWriteFence, type LineageInput, type LineageRoot,
  prepareArtifactCommitPreflight, withArtifactCommitPreflight, withAdditionalArtifactInputWriteFence,
  sealArtifactInputActor,
} from "@corgtex/domain";

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

export type PendingOperationContext = {
  workspaceId: string;
  sessionId: string;
  userId: string | null;
  agentKey: string;
  userMessage: string;
  actor?: AppActor;
  lineageRoots?: readonly LineageRoot[];
  persistenceFence?: ArtifactInputWriteFence;
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

export type PendingOperationMetadata = { id: string; status: PendingOperationStatus; contentWithheld: true };
export type PendingOperationView = PendingOperationRecord | PendingOperationMetadata;
type Db = Prisma.TransactionClient | typeof prisma;
type ExecutionState = {
  owner: { workspaceId: string; sessionId: string; userId: string; agentKey: string };
  operation: PendingOperationRecord;
  argsHash: string;
  leaseAt: number;
  roots: readonly LineageRoot[];
  finalizing?: { tx: Prisma.TransactionClient; row: PendingOperationRecord; roots: readonly LineageRoot[] };
};
const executions = new WeakMap<PendingOperationRecord, ExecutionState>();
const CRM_WRITE_TOOLS = new Set(["record_relationship_activity", "complete_relationship_activity", "create_communication_suggestion"]);

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

function metadata(operation: PendingOperationRecord): PendingOperationMetadata {
  return { id: operation.id, status: operation.status, contentWithheld: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRoots(...proofs: (readonly LineageRoot[])[]) {
  return mergeArtifactInputProofs(...proofs);
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

async function requireContext(ctx: PendingOperationContext, db: Db = prisma) {
  const actor = ctx.actor;
  if (actor?.kind !== "user" || normalizedUserId(ctx.userId) !== actor.user.id) {
    throw new AppError(401, "AUTH_REQUIRED", "CRM operations require the authenticated conversation owner.");
  }
  await requireWorkspaceMembership({ actor, workspaceId: ctx.workspaceId, tx: db });
  const session = await db.conversationSession.findFirst({ where: { id: ctx.sessionId, workspaceId: ctx.workspaceId, userId: actor.user.id, agentKey: ctx.agentKey } });
  if (!session) throw new AppError(404, "NOT_FOUND", "Conversation not found.");
  return actor;
}

async function writeFence(ctx: PendingOperationContext, tx: Prisma.TransactionClient) {
  await assertArtifactInputWriteFence(tx);
  await ctx.persistenceFence?.(tx);
}

function ownedWhere(ctx: PendingOperationContext) {
  return { workspaceId: ctx.workspaceId, conversationId: ctx.sessionId, userId: normalizedUserId(ctx.userId), agentKey: ctx.agentKey };
}

function validArgs(operation: PendingOperationRecord) {
  return CRM_WRITE_TOOLS.has(operation.toolName) && isRecord(operation.argsJson)
    && operation.argsHash === operationArgsHash(operation.toolName, operation.argsJson)
    && operation.riskLabel === riskLabel(operation.toolName);
}

async function scopedRow(ctx: PendingOperationContext, id: string, db: Db = prisma) {
  await requireContext(ctx, db);
  return await db.conversationPendingOperation.findFirst({ where: { ...ownedWhere(ctx), id } }) as PendingOperationRecord | null;
}

async function operationProof(ctx: PendingOperationContext, operation: PendingOperationRecord, db: Db) {
  const actor = await requireContext(ctx, db);
  if (!validArgs(operation)) return null;
  const prior = await currentArtifactInputRoots(db, ctx.workspaceId, { kind: "ConversationPendingOperation", id: operation.id }, operation);
  if (!prior?.length) return null;
  try {
    return await captureArtifactInputProof(actor, ctx.workspaceId, [{ kind: "ConversationPendingOperation", id: operation.id, snapshot: operation }], db);
  } catch (error) {
    if (error instanceof AppError && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) return null;
    throw error;
  }
}

async function view(ctx: PendingOperationContext, operation: PendingOperationRecord, db: Db = prisma): Promise<PendingOperationView> {
  return await operationProof(ctx, operation, db) ? immutable(structuredClone(operation)) : metadata(operation);
}

async function currentView(ctx: PendingOperationContext, operation: PendingOperationView, db: Db = prisma) {
  const row = await scopedRow(ctx, operation.id, db);
  if (!row) throw new AppError(404, "NOT_FOUND", "CRM operation not found.");
  return view(ctx, row, db);
}

export async function crmPendingOperationNotice(ctx: PendingOperationContext, operation: PendingOperationView) {
  const current = await currentView(ctx, operation);
  if ("contentWithheld" in current) return `Pending CRM operation ${current.id} is ${current.status.toLowerCase()}. Its source permissions could not be verified.`;
  if (current.status === STATUS.EXECUTED) return crmPendingOperationResultNotice(ctx, current);
  if (current.status !== STATUS.PENDING) return crmPendingOperationFailedNotice(current);
  return [
    `Pending operation ID: ${current.id}`, `CRM operation: ${current.toolName}`, `Risk: ${current.riskLabel}`,
    `Stored args: ${stableJson(current.argsJson)}`,
    `Approve by replying "confirm ${current.id}" or cancel with "cancel ${current.id}".`,
  ].join("\n");
}

export async function crmPendingOperationResultNotice(ctx: PendingOperationContext, operation: PendingOperationView) {
  const current = await currentView(ctx, operation);
  if ("contentWithheld" in current) return `Pending CRM operation ${current.id} is ${current.status.toLowerCase()}. Its result is withheld.`;
  if (current.status !== STATUS.EXECUTED) return crmPendingOperationFailedNotice(current);
  const result = isRecord(current.resultJson) ? current.resultJson : {};
  const activity = isRecord(result.activity) ? result.activity : {};
  const suggestion = isRecord(result.suggestion) ? result.suggestion : {};
  const id = typeof activity.id === "string" ? `Activity ID: ${activity.id}`
    : typeof suggestion.id === "string" ? `Suggestion ID: ${suggestion.id}` : "Record ID: unavailable";
  return [`Confirmed pending operation ID: ${current.id}`, `CRM operation: ${current.toolName}`, id].join("\n");
}

export function crmPendingOperationCancelNotice(operation: PendingOperationView) { return `Canceled pending operation ID: ${operation.id}`; }
export function crmPendingOperationExpiredNotice(operation: PendingOperationView) {
  return `Pending CRM operation ${operation.id} expired before confirmation. Please ask me to prepare the CRM change again.`;
}
export function crmPendingOperationFailedNotice(operation: PendingOperationView) {
  // Stored/provider error strings may contain restricted context and are never published.
  return `Pending CRM operation ${operation.id} cannot be confirmed because it is ${operation.status.toLowerCase()}. Check CRM before preparing this change again.`;
}

async function refreshState(ctx: PendingOperationContext, operation: PendingOperationRecord, tx: Prisma.TransactionClient, now: Date) {
  let data: Prisma.ConversationPendingOperationUpdateManyMutationInput | null = null;
  if (operation.status === STATUS.PENDING && operation.expiresAt <= now) {
    data = { status: STATUS.EXPIRED, errorCode: "CRM_PENDING_OPERATION_EXPIRED", errorMessage: "The pending operation expired before confirmation." };
  } else if (operation.status === STATUS.EXECUTING && operation.updatedAt.getTime() <= now.getTime() - EXECUTING_OPERATION_LEASE_MS) {
    data = { status: STATUS.FAILED, errorCode: "CRM_PENDING_OPERATION_EXECUTION_ABANDONED", errorMessage: "Execution state is uncertain. Check CRM before preparing this change again." };
  }
  if (!data) return operation;
  await writeFence(ctx, tx);
  await tx.conversationPendingOperation.updateMany({ where: { ...ownedWhere(ctx), id: operation.id, status: operation.status, updatedAt: operation.updatedAt }, data });
  return await scopedRow(ctx, operation.id, tx) ?? operation;
}

function assertRetrySafe(operation: PendingOperationRecord) {
  if (operation.status === STATUS.EXECUTING || (operation.status === STATUS.FAILED && operation.errorCode !== "CRM_PENDING_OPERATION_NO_EFFECTS")) {
    throw new AppError(409, "CRM_EXECUTION_UNCERTAIN", "A matching CRM change may already have executed. Check CRM before preparing it again.");
  }
}

function relatedInputs(args: Record<string, unknown>): LineageInput[] {
  const inputs: LineageInput[] = [];
  for (const [field, kind] of [["accountId", "CrmAccount"], ["contactId", "CrmContact"], ["dealId", "CrmDeal"], ["activityId", "CrmActivity"]] as const) {
    if (args[field] == null) continue;
    if (typeof args[field] !== "string" || !args[field].trim()) throw new AppError(400, "INVALID_INPUT", "A CRM reference is invalid.");
    inputs.push({ kind, id: args[field] });
  }
  if (!inputs.length) throw new AppError(400, "INVALID_INPUT", "A related CRM record is required.");
  return inputs;
}

async function contextRoots(ctx: PendingOperationContext, tx: Prisma.TransactionClient) {
  const actor = await requireContext(ctx, tx);
  if (!ctx.lineageRoots?.length) throw new AppError(409, "UNKNOWN_LINEAGE", "CRM model output requires its complete captured inputs.");
  if (!await isArtifactInputProofReadable(actor, ctx.workspaceId, ctx.lineageRoots, tx)) throw new AppError(409, "SOURCE_CHANGED", "CRM input permissions changed. Please retry.");
  return [...ctx.lineageRoots];
}

export async function createPendingCrmOperation(params: { ctx: PendingOperationContext; toolName: string; args: Record<string, unknown> }) {
  const { ctx, toolName } = params;
  if (!CRM_WRITE_TOOLS.has(toolName)) throw new AppError(400, "INVALID_INPUT", "Unsupported pending CRM operation.");
  const argsJson = jsonSafe(params.args) as Record<string, unknown>;
  if (!isRecord(argsJson)) throw new AppError(400, "INVALID_INPUT", "CRM arguments must be an object.");
  const argsHash = operationArgsHash(toolName, argsJson);
  const baseKey = operationIdempotencyKey(ctx, toolName, argsHash);
  let attemptedKey = baseKey;
  try {
    return await prisma.$transaction(async (tx) => {
    await writeFence(ctx, tx);
    const actor = await requireContext(ctx, tx);
    const captured = await contextRoots(ctx, tx);
    const dependencies = await captureArtifactInputProof(actor, ctx.workspaceId, relatedInputs(argsJson), tx);
    const roots = mergeRoots(captured, dependencies);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('crm-pending-proposal'), hashtext(${`${ctx.workspaceId}:${baseKey}`}))`;
    const existing = await tx.conversationPendingOperation.findFirst({ where: { ...ownedWhere(ctx), idempotencyKey: baseKey } }) as PendingOperationRecord | null;
    const retries = await tx.conversationPendingOperation.findMany({ where: { ...ownedWhere(ctx), idempotencyKey: { startsWith: retryIdempotencyKeyPrefix(baseKey) } },
      orderBy: { createdAt: "desc" }, take: 1001 }) as PendingOperationRecord[];
    if (retries.length > 1000) throw new AppError(503, "INPUT_SCAN_LIMIT", "CRM retry history exceeds its supported size.");
    for (const candidate of [existing, ...retries]) {
      if (!candidate) continue;
      const refreshed = await refreshState(ctx, candidate, tx, new Date());
      assertRetrySafe(refreshed);
      if (refreshed.status === STATUS.EXECUTED) {
        if (await operationProof(ctx, refreshed, tx)) return immutable(structuredClone(refreshed));
        throw new AppError(409, "CRM_EXECUTION_UNCERTAIN", "A matching CRM change already executed but its result is withheld. Check CRM before preparing it again.");
      }
      if (refreshed.status === STATUS.PENDING && await operationProof(ctx, refreshed, tx)) return immutable(structuredClone(refreshed));
    }
    const key = existing || retries.length ? `${retryIdempotencyKeyPrefix(baseKey)}${retries.length + 1}` : baseKey;
    attemptedKey = key;
    const related = relatedEntity(toolName, argsJson);
    await writeFence(ctx, tx);
    const created = await tx.conversationPendingOperation.create({ data: {
      workspaceId: ctx.workspaceId, conversationId: ctx.sessionId, userId: normalizedUserId(ctx.userId), agentKey: ctx.agentKey, toolName,
      argsJson: argsJson as Prisma.InputJsonValue, argsHash, idempotencyKey: key, relatedEntityType: related.type, relatedEntityId: related.id,
      riskLabel: riskLabel(toolName), expiresAt: new Date(Date.now() + PENDING_OPERATION_TTL_MS),
    } }) as PendingOperationRecord;
    await recordArtifactInputLineage({ tx, actor, workspaceId: ctx.workspaceId, artifact: { kind: "ConversationPendingOperation", id: created.id },
      content: created, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    return immutable(structuredClone(created));
    });
  } catch (error) {
    if (!isRecord(error) || error.code !== "P2002") throw error;
    // A competing committed proposal can be reused only through its complete
    // current receipt and exact owner/arguments. Unknown outcomes are never replayed.
    return prisma.$transaction(async tx => {
      await writeFence(ctx, tx);
      await requireContext(ctx, tx);
      await contextRoots(ctx, tx);
      const winner = await tx.conversationPendingOperation.findFirst({ where: { ...ownedWhere(ctx), idempotencyKey: attemptedKey } }) as PendingOperationRecord | null;
      if (!winner || winner.argsHash !== argsHash || !validArgs(winner)
        || (winner.status !== STATUS.EXECUTED && (winner.status !== STATUS.PENDING || winner.expiresAt <= new Date()))
        || !await operationProof(ctx, winner, tx)) throw error;
      await writeFence(ctx, tx);
      return immutable(structuredClone(winner));
    });
  }
}

/** Scope admission uses only owner-bound control metadata. Arguments and
 * results stay behind the exact tool's operation and source-permission gates. */
export async function peekCrmPendingOperationForIntent(ctx: PendingOperationContext, intent: PendingOperationIntent,
  allowedToolNames: readonly string[]) {
  await requireContext(ctx);
  const row = await prisma.conversationPendingOperation.findFirst({ where: { ...ownedWhere(ctx),
    toolName: { in: [...allowedToolNames] }, ...(intent.pendingOperationId ? { id: intent.pendingOperationId } : {}) },
    select: { id: true, status: true, toolName: true }, orderBy: { createdAt: "desc" } });
  return row && allowedToolNames.includes(row.toolName) ? { id: row.id, status: row.status, toolName: row.toolName } : null;
}

export async function findCrmPendingOperationForIntent(ctx: PendingOperationContext, intent: PendingOperationIntent,
  expectedToolName?: string) {
  await requireContext(ctx);
  const row = await prisma.conversationPendingOperation.findFirst({ where: { ...ownedWhere(ctx),
    ...(expectedToolName ? { toolName: expectedToolName } : {}), ...(intent.pendingOperationId ? { id: intent.pendingOperationId } : {}) },
    orderBy: { createdAt: "desc" } }) as PendingOperationRecord | null;
  return row ? view(ctx, row) : null;
}

export async function cancelCrmPendingOperation(ctx: PendingOperationContext, operation: PendingOperationView) {
  return prisma.$transaction(async (tx) => {
    await writeFence(ctx, tx);
    const current = await scopedRow(ctx, operation.id, tx);
    if (!current) throw new AppError(404, "NOT_FOUND", "CRM operation not found.");
    if (current.status === STATUS.PENDING) await tx.conversationPendingOperation.updateMany({ where: { ...ownedWhere(ctx), id: current.id, status: STATUS.PENDING },
      data: { status: STATUS.CANCELED, canceledAt: new Date() } });
    return view(ctx, await scopedRow(ctx, current.id, tx) ?? current, tx);
  });
}

async function assertExecutionAuthority(ctx: PendingOperationContext, operation: PendingOperationRecord, state: ExecutionState, tx: Prisma.TransactionClient) {
  const actor = await requireContext(ctx, tx);
  if (state.owner.workspaceId !== ctx.workspaceId || state.owner.sessionId !== ctx.sessionId || state.owner.userId !== ctx.userId || state.owner.agentKey !== ctx.agentKey
    || state.owner.userId !== actor.user.id || operation.id !== state.operation.id || operationArgsHash(operation.toolName, operation.argsJson) !== state.argsHash) {
    throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution ownership changed.");
  }
  // The earlier begin transaction cannot fence an effect transaction. Retain
  // this exact owner's row lock through the effect/receipt commit so refresh,
  // cancellation and competing finalization cannot replace its checked lease.
  await tx.$queryRaw`SELECT id FROM "ConversationPendingOperation"
    WHERE id = ${operation.id} AND "workspaceId" = ${state.owner.workspaceId}
    AND "conversationId" = ${state.owner.sessionId} AND "userId" = ${state.owner.userId}
    AND "agentKey" = ${state.owner.agentKey} FOR UPDATE`;
  const row = await scopedRow(ctx, operation.id, tx);
  const finishing = state.finalizing?.tx === tx ? state.finalizing : undefined;
  if (!row || !validArgs(row) || row.argsHash !== state.argsHash || (finishing
    ? row.status !== finishing.row.status || lineageContentFingerprint("ConversationPendingOperation", row) !== lineageContentFingerprint("ConversationPendingOperation", finishing.row)
    : row.status !== STATUS.EXECUTING || row.updatedAt.getTime() !== state.leaseAt || Date.now() - state.leaseAt >= EXECUTING_OPERATION_LEASE_MS)) {
    throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution lease is unavailable.");
  }
  return { actor, roots: finishing?.roots ?? state.roots };
}

async function assertExecution(ctx: PendingOperationContext, operation: PendingOperationRecord, state: ExecutionState, tx: Prisma.TransactionClient) {
  const { actor, roots } = await assertExecutionAuthority(ctx, operation, state, tx);
  if (!await isArtifactInputProofReadable(actor, ctx.workspaceId, roots, tx)) throw new AppError(409, "SOURCE_CHANGED", "CRM input permissions changed.");
}

export async function beginCrmPendingOperationExecution(ctx: PendingOperationContext, operation: PendingOperationView) {
  return prisma.$transaction(async (tx) => {
    await writeFence(ctx, tx);
    await requireContext(ctx, tx);
    await tx.$queryRaw`SELECT id FROM "ConversationPendingOperation" WHERE id = ${operation.id} AND "workspaceId" = ${ctx.workspaceId} FOR UPDATE`;
    const current = await scopedRow(ctx, operation.id, tx);
    if (!current) throw new AppError(404, "NOT_FOUND", "CRM operation not found.");
    const refreshed = await refreshState(ctx, current, tx, new Date());
    const proof = await operationProof(ctx, refreshed, tx);
    if (!proof) return { state: "withheld" as const, operation: metadata(refreshed) };
    if (refreshed.status === STATUS.EXECUTED) return { state: "already-executed" as const, operation: immutable(structuredClone(refreshed)) };
    if (refreshed.status === STATUS.EXPIRED) return { state: "expired" as const, operation: immutable(structuredClone(refreshed)) };
    if (refreshed.status !== STATUS.PENDING) return { state: "unavailable" as const, operation: immutable(structuredClone(refreshed)) };
    const actor = await requireContext(ctx, tx);
    const roots = immutable(await captureImmutableArtifactInputProof(actor, ctx.workspaceId, mergeRoots(proof, await contextRoots(ctx, tx)), tx));
    const now = new Date();
    const executing = await tx.conversationPendingOperation.update({ where: { id: refreshed.id }, data: { status: STATUS.EXECUTING, updatedAt: now } }) as PendingOperationRecord;
    await recordArtifactInputLineage({ tx, actor, workspaceId: ctx.workspaceId, artifact: { kind: "ConversationPendingOperation", id: executing.id },
      content: executing, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    const ready = immutable(structuredClone(executing));
    const state: ExecutionState = { owner: { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, userId: actor.user.id, agentKey: ctx.agentKey },
      operation: ready, argsHash: ready.argsHash, leaseAt: ready.updatedAt.getTime(), roots };
    executions.set(ready, state);
    const executionFence: ArtifactInputWriteFence = (mutationTx) => assertExecution(ctx, ready, state, mutationTx);
    return { state: "ready" as const, operation: ready, lineageRoots: roots, executionFence };
  });
}

function nativeResultInput(operation: PendingOperationRecord, result: unknown): LineageInput {
  if (!isRecord(result) || result.success !== true) throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM execution did not return a proven result.");
  const key = operation.toolName === "create_communication_suggestion" ? "suggestion" : "activity";
  const value = result[key];
  if (!isRecord(value) || typeof value.id !== "string") throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result identity is unavailable.");
  return { kind: key === "suggestion" ? "CrmCommunicationSuggestion" : "CrmActivity", id: value.id };
}

async function resultProof(ctx: PendingOperationContext, operation: PendingOperationRecord, state: ExecutionState, result: unknown, tx: Prisma.TransactionClient) {
  const actor = await requireContext(ctx, tx);
  const input = nativeResultInput(operation, result);
  const row = input.kind === "CrmActivity" ? await tx.crmActivity.findFirst({ where: { id: input.id, workspaceId: ctx.workspaceId } })
    : await tx.crmCommunicationSuggestion.findFirst({ where: { id: input.id, workspaceId: ctx.workspaceId } });
  if (!row) throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result is unavailable.");
  const value = isRecord(result) ? result : {};
  const expected = input.kind === "CrmActivity" ? { success: true, activity: {
    id: row.id, title: row.title, type: "type" in row ? row.type : undefined, accountId: row.accountId ?? null,
    dueAt: "dueAt" in row ? row.dueAt ?? null : undefined, completedAt: "completedAt" in row ? row.completedAt ?? null : undefined,
    webUrl: row.accountId ? `/workspaces/${ctx.workspaceId}/leads/accounts/${row.accountId}?view=activity` : `/workspaces/${ctx.workspaceId}/leads/activity`,
  } } : { success: true, emailSent: false, suggestion: { id: row.id, title: row.title, status: "status" in row ? row.status : undefined, accountId: row.accountId ?? null,
    webUrl: row.accountId ? `/workspaces/${ctx.workspaceId}/leads/accounts/${row.accountId}?view=suggestions` : `/workspaces/${ctx.workspaceId}/leads/suggestions` } };
  if (stableJson(jsonSafe(value)) !== stableJson(jsonSafe(expected))) throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result does not match its committed record.");
  if (operation.toolName === "complete_relationship_activity" && input.id !== (operation.argsJson as Record<string, unknown>).activityId) {
    throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result does not match the approved activity.");
  }
  const args = operation.argsJson as Record<string, unknown>;
  const record = row as unknown as Record<string, unknown>;
  const trim = (entry: unknown) => typeof entry === "string" ? entry.trim() || null : null;
  const date = (entry: unknown) => entry == null ? null : new Date(String(entry)).toISOString();
  if (operation.toolName === "complete_relationship_activity") {
    if (!record.completedAt || (args.completedAt != null && date(record.completedAt) !== date(args.completedAt))) {
      throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM completion does not match its approved arguments.");
    }
  } else {
    if (record.actorUserId !== actor.user.id || record.source !== "workspace-chat" || !(record.createdAt instanceof Date) || record.createdAt.getTime() < state.leaseAt
      || record.title !== trim(args.title) || record.bodyMd !== trim(args.bodyMd)
      || ["accountId", "contactId", "dealId", "activityId"].some((field) => args[field] != null && record[field] !== args[field])
      || (operation.toolName === "record_relationship_activity" && (record.type !== (args.type ?? "NOTE") || date(record.dueAt) !== date(args.dueAt)))
      || (operation.toolName === "create_communication_suggestion" && (record.subject !== trim(args.subject)
        || record.status !== "SUGGESTED" || record.channel !== (trim(args.channel) ?? "EMAIL").toUpperCase().replace(/[\s-]+/g, "_")
        || (args.recipientEmail != null && record.recipientEmail !== trim(args.recipientEmail)?.toLowerCase())
        || (args.recipientName != null && record.recipientName !== trim(args.recipientName))))) {
      throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result does not match its approved arguments.");
    }
  }
  const proof = await captureArtifactInputProof(actor, ctx.workspaceId, [{ ...input, snapshot: row }], tx);
  if (operation.toolName !== "complete_relationship_activity") {
    const anchors = state.roots.filter((root) => root.kind === "ArtifactInputSnapshot");
    let matchesExecution = false;
    for (const anchor of anchors) {
      const saved = await tx.artifactInputSnapshot.findFirst({ where: { id: anchor.id, workspaceId: ctx.workspaceId,
        sourceKind: "ConversationPendingOperation", sourceId: operation.id } });
      if (saved && proof.some((root) => root.kind === anchor.kind && root.id === anchor.id && root.fingerprint === anchor.fingerprint)) matchesExecution = true;
    }
    if (!matchesExecution) throw new AppError(409, "CRM_RESULT_UNPROVEN", "CRM result has no receipt for this approved execution.");
  }
  return proof;
}

async function markCrmPendingOperationExecutedInTransaction(ctx: PendingOperationContext, operation: PendingOperationRecord,
  result: unknown, state: ExecutionState, tx: Prisma.TransactionClient) {
  await writeFence(ctx, tx); await assertExecution(ctx, operation, state, tx);
  const actor = await requireContext(ctx, tx);
  const current = await scopedRow(ctx, operation.id, tx);
  if (!current) throw new AppError(404, "NOT_FOUND", "CRM operation not found.");
  const supplied = await contextRoots(ctx, tx);
  const snapshot = await captureArtifactInputSnapshotProof(actor, ctx.workspaceId,
    { kind: "ConversationPendingOperation", id: current.id, fingerprint: lineageContentFingerprint("ConversationPendingOperation", current) }, tx);
  const roots = mergeRoots(state.roots, snapshot,
    supplied.filter((root) => root.kind !== "ConversationPendingOperation" || root.id !== current.id), await resultProof(ctx, current, state, result, tx));
  const updated = await tx.conversationPendingOperation.update({ where: { id: current.id }, data: { status: STATUS.EXECUTED, resultJson: jsonSafe(result), executedAt: new Date(), errorCode: null, errorMessage: null } }) as PendingOperationRecord;
  state.finalizing = { tx, row: updated, roots };
  await writeFence(ctx, tx);
  await recordArtifactInputLineage({ tx, actor, workspaceId: ctx.workspaceId, artifact: { kind: "ConversationPendingOperation", id: updated.id },
    content: updated, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return immutable(structuredClone(updated));
}

export async function markCrmPendingOperationExecuted(ctx: PendingOperationContext, operation: PendingOperationRecord, result: unknown) {
  const state = executions.get(operation);
  if (!state) throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution capability is unavailable.");
  try {
    const executed = await prisma.$transaction(tx => markCrmPendingOperationExecutedInTransaction(ctx, operation, result, state, tx));
    executions.delete(operation); return executed;
  } finally { state.finalizing = undefined; }
}

/** The effect, complete manifest, audit and canonical EXECUTED result commit on
 * one connection. Only the ready native capability can enter this callback. */
export async function commitCrmPendingOperationExecution(ctx: PendingOperationContext, operation: PendingOperationRecord,
  work: (execution: Readonly<{ tx: Prisma.TransactionClient; lineageRoots: readonly LineageRoot[];
    persistenceFence: ArtifactInputWriteFence }>) => Promise<unknown>) {
  const state = executions.get(operation);
  if (!state || ctx.actor?.kind !== "user") throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution capability is unavailable.");
  sealArtifactInputActor(ctx.actor);
  ctx = Object.freeze({ ...ctx, lineageRoots: immutable(structuredClone([...(ctx.lineageRoots ?? [])])) });
  const actor = ctx.actor!;
  const roots = immutable(structuredClone(mergeRoots(state.roots, ctx.lineageRoots ?? [])));
  const preflight = await prepareArtifactCommitPreflight(actor, ctx.workspaceId, roots);
  try {
    const committed = await prisma.$transaction(async tx => {
      // Ownership locks precede native/source locks in the publication adapter.
      await writeFence(ctx, tx); await assertExecutionAuthority(ctx, operation, state, tx);
      return withArtifactCommitPreflight(actor, ctx.workspaceId, tx, roots, preflight, async () => {
        await writeFence(ctx, tx); await assertExecution(ctx, operation, state, tx);
        const persistenceFence: ArtifactInputWriteFence = async mutationTx => {
          if (mutationTx !== tx) throw new AppError(409, "CRM_TRANSACTION_REQUIRED", "CRM effect must join its exact publication transaction.");
          await ctx.persistenceFence?.(tx);
          await assertExecution(ctx, operation, state, tx);
        };
        return withAdditionalArtifactInputWriteFence(persistenceFence, async () => {
          const result = await work(Object.freeze({ tx, lineageRoots: roots, persistenceFence }));
          const executed = await markCrmPendingOperationExecutedInTransaction(ctx, operation, result, state, tx);
          return Object.freeze({ operation: executed, result });
        });
      });
    }, { timeout: 15000 });
    executions.delete(operation);
    return committed;
  } finally { state.finalizing = undefined; }
}

export async function markCrmPendingOperationFailed(ctx: PendingOperationContext, operation: PendingOperationRecord, _error: unknown, options?: { noEffects?: boolean }) {
  const state = executions.get(operation);
  if (!state) throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution capability is unavailable.");
  const failed = await prisma.$transaction(async (tx) => {
    await writeFence(ctx, tx);
    const actor = await requireContext(ctx, tx);
    if (state.owner.workspaceId !== ctx.workspaceId || state.owner.sessionId !== ctx.sessionId || state.owner.userId !== ctx.userId
      || state.owner.agentKey !== ctx.agentKey || actor.user.id !== state.owner.userId || operation.id !== state.operation.id
      || operationArgsHash(operation.toolName, operation.argsJson) !== state.argsHash) {
      throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution ownership changed.");
    }
    // A standalone failure finalizer must serialize with success finalization too.
    // Read status and the exact lease only after holding the same owner-bound lock.
    await tx.$queryRaw`SELECT id FROM "ConversationPendingOperation"
      WHERE id = ${operation.id} AND "workspaceId" = ${state.owner.workspaceId}
      AND "conversationId" = ${state.owner.sessionId} AND "userId" = ${state.owner.userId}
      AND "agentKey" = ${state.owner.agentKey} FOR UPDATE`;
    const current = await scopedRow(ctx, operation.id, tx);
    if (!current || !validArgs(current) || current.argsHash !== state.argsHash || current.status !== STATUS.EXECUTING || current.updatedAt.getTime() !== state.leaseAt) {
      throw new AppError(409, "CRM_EXECUTION_STALE", "CRM execution lease is unavailable.");
    }
    const updated = await tx.conversationPendingOperation.update({ where: { id: current.id }, data: {
      status: STATUS.FAILED, errorCode: options?.noEffects ? "CRM_PENDING_OPERATION_NO_EFFECTS" : "CRM_PENDING_OPERATION_EXECUTION_UNCERTAIN",
      errorMessage: options?.noEffects ? "The CRM change did not execute." : "The CRM execution outcome is uncertain. Check CRM before preparing this change again.",
    } }) as PendingOperationRecord;
    return view(ctx, updated, tx);
  });
  executions.delete(operation);
  return failed;
}
