import { checkRateLimit, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { AppError, invariant } from "./errors";
import { requireGlobalOperator } from "./auth";
import { appendEvents } from "./events";

export const TRIAL_STATUS_ACTIVE = "ACTIVE";
export const TRIAL_STATUS_REVIEW_REQUIRED = "REVIEW_REQUIRED";
export const TRIAL_STATUS_SUSPENDED = "SUSPENDED";
export const TRIAL_STATUS_EXPIRED = "EXPIRED";
export const TRIAL_STATUS_CONVERTED = "CONVERTED";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORT_EMAIL_DOMAIN = "corgtex.local";

type TrialLike = {
  id: string;
  workspaceId: string | null;
  agentCredentialId: string | null;
  status: string;
  trialExpiresAt: Date;
  memberLimit: number;
  storageLimitMb: number;
  mcpDailyCallLimit: number;
};

const TRIAL_ENABLED_FEATURE_FLAGS = [
  ["GOALS", true],
  ["AGENT_GOVERNANCE", true],
  ["TOOL_LINKS", true],
  ["CONTEXT_MAPS", true],
  ["SETTINGS_GENERAL", true],
  ["AI_WORKSPACES", true],
  ["OPENWORK_DEFAULT", true],
  ["EXECUTION_PACKETS", true],
  ["MEETING_TRANSCRIPT_SOURCES", false],
  ["MEETING_RECORDERS", false],
] as const;

function procurementTrialDelegate() {
  return (prisma as typeof prisma & { procurementTrial?: typeof prisma.procurementTrial }).procurementTrial;
}

function documentStorageBytes(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const size = (metadata as Record<string, unknown>).size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

export async function applyTrialFeatureFlags(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.workspaceFeatureFlag.createMany({
    data: TRIAL_ENABLED_FEATURE_FLAGS.map(([flag, enabled]) => ({
      workspaceId,
      flag,
      enabled,
    })),
    skipDuplicates: true,
  });
}

async function expireTrial(trial: Pick<TrialLike, "id" | "workspaceId" | "agentCredentialId" | "trialExpiresAt">) {
  await prisma.$transaction(async (tx) => {
    await tx.procurementTrial.update({
      where: { id: trial.id },
      data: {
        status: TRIAL_STATUS_EXPIRED,
      },
    });
    if (trial.workspaceId) {
      await tx.workspace.update({
        where: { id: trial.workspaceId },
        data: {
          plan: "CORE_FREE",
          planActivatedAt: new Date(),
          trialEndsAt: trial.trialExpiresAt,
        },
      });
      await tx.modelUsageBudget.upsert({
        where: { workspaceId: trial.workspaceId },
        create: {
          workspaceId: trial.workspaceId,
          monthlyCostCapUsd: 0,
        },
        update: {
          monthlyCostCapUsd: 0,
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: trial.workspaceId,
          actorUserId: null,
          action: "procurement_trial.expired",
          entityType: "ProcurementTrial",
          entityId: trial.id,
          meta: { downgradePlan: "CORE_FREE" },
        },
      });
      await appendEvents(tx, [
        {
          workspaceId: trial.workspaceId,
          type: "procurement_trial.expired",
          aggregateType: "ProcurementTrial",
          aggregateId: trial.id,
          payload: { trialId: trial.id, downgradePlan: "CORE_FREE" },
        },
      ]);
    }
    if (trial.agentCredentialId) {
      await tx.agentCredential.update({
        where: { id: trial.agentCredentialId },
        data: { isActive: false },
      });
    }
  });
}

function assertActiveTrial(trial: TrialLike) {
  if (trial.status !== TRIAL_STATUS_ACTIVE) {
    throw new AppError(403, "TRIAL_INACTIVE", "This trial is not active.");
  }
  if (trial.trialExpiresAt.getTime() <= Date.now()) {
    throw new AppError(403, "TRIAL_EXPIRED", "This trial has expired.");
  }
}

export async function requireTrialMcpAccess(workspaceId: string) {
  const trials = procurementTrialDelegate();
  if (!trials) return null;

  const trial = await trials.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      status: true,
      trialExpiresAt: true,
      memberLimit: true,
      storageLimitMb: true,
      mcpDailyCallLimit: true,
    },
  });
  if (!trial) return null;

  try {
    assertActiveTrial(trial);
  } catch (error) {
    if (error instanceof AppError && error.code === "TRIAL_EXPIRED") {
      await expireTrial(trial);
    }
    throw error;
  }

  const result = await checkRateLimit(`procurement-trial:${trial.id}:mcp:day`, {
    windowMs: DAY_MS,
    limit: trial.mcpDailyCallLimit,
    failClosed: true,
  });
  invariant(result.allowed, 429, "TRIAL_MCP_LIMIT_EXCEEDED", "Trial MCP call limit exceeded.");

  return trial;
}

export async function assertTrialMemberCapacity(workspaceId: string) {
  const trials = procurementTrialDelegate();
  if (!trials) return;

  const trial = await trials.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      status: true,
      trialExpiresAt: true,
      memberLimit: true,
      storageLimitMb: true,
      mcpDailyCallLimit: true,
    },
  });
  if (!trial) return;
  assertActiveTrial(trial);

  const activeMembers = await prisma.member.count({
    where: {
      workspaceId,
      isActive: true,
      NOT: {
        user: {
          email: {
            startsWith: "support+",
            endsWith: `@${SUPPORT_EMAIL_DOMAIN}`,
          },
        },
      },
    },
  });
  invariant(activeMembers < trial.memberLimit, 403, "TRIAL_MEMBER_LIMIT_EXCEEDED", "Trial member limit exceeded.");
}

export async function assertTrialStorageCapacity(workspaceId: string, bytesToAdd: number) {
  if (!Number.isFinite(bytesToAdd) || bytesToAdd <= 0) return;

  const trials = procurementTrialDelegate();
  if (!trials) return;

  const trial = await trials.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      status: true,
      trialExpiresAt: true,
      memberLimit: true,
      storageLimitMb: true,
      mcpDailyCallLimit: true,
    },
  });
  if (!trial) return;
  if (trial.status === TRIAL_STATUS_CONVERTED) return;
  assertActiveTrial(trial);

  const documents = await prisma.document.findMany({
    where: { workspaceId },
    select: { metadata: true },
  });
  const currentBytes = documents.reduce(
    (sum, document) => sum + documentStorageBytes(document.metadata),
    0,
  );
  const limitBytes = trial.storageLimitMb * 1024 * 1024;
  invariant(currentBytes + bytesToAdd <= limitBytes, 403, "TRIAL_STORAGE_LIMIT_EXCEEDED", "Trial storage limit exceeded.");
}

export async function lockAndAssertTrialStorageCapacity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  incomingBytes: number,
  options?: { replacingDocumentId?: string },
) {
  if (!Number.isFinite(incomingBytes) || incomingBytes <= 0) return;

  const trial = await tx.procurementTrial.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      status: true,
      trialExpiresAt: true,
      memberLimit: true,
      storageLimitMb: true,
      mcpDailyCallLimit: true,
    },
  });
  if (!trial) return;
  if (trial.status === TRIAL_STATUS_CONVERTED) return;
  assertActiveTrial(trial);

  const lockKey = `trial-storage-capacity:${workspaceId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  const documents = await tx.document.findMany({
    where: { workspaceId },
    select: { id: true, metadata: true },
  });
  let replacedBytes = 0;
  const currentBytes = documents.reduce((sum, document) => {
    const size = documentStorageBytes(document.metadata);
    if (document.id === options?.replacingDocumentId) replacedBytes = size;
    return sum + size;
  }, 0);
  const bytesToAdd = options?.replacingDocumentId
    ? Math.max(0, incomingBytes - replacedBytes)
    : incomingBytes;
  if (bytesToAdd <= 0) return;
  const limitBytes = trial.storageLimitMb * 1024 * 1024;
  invariant(currentBytes + bytesToAdd <= limitBytes, 403, "TRIAL_STORAGE_LIMIT_EXCEEDED", "Trial storage limit exceeded.");
}

export async function suspendProcurementTrial(actor: AppActor, params: {
  trialId: string;
  reason: string;
}) {
  requireGlobalOperator(actor);
  const reason = params.reason.trim();
  invariant(reason.length > 0, 400, "INVALID_INPUT", "Suspension reason is required.");

  const trial = await prisma.procurementTrial.findUnique({
    where: { id: params.trialId },
    select: {
      id: true,
      workspaceId: true,
      agentCredentialId: true,
      status: true,
    },
  });
  invariant(trial, 404, "NOT_FOUND", "Procurement trial not found.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.procurementTrial.update({
      where: { id: trial.id },
      data: {
        status: TRIAL_STATUS_SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: reason,
      },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        suspendedAt: true,
        suspensionReason: true,
      },
    });

    if (trial.agentCredentialId) {
      await tx.agentCredential.update({
        where: { id: trial.agentCredentialId },
        data: { isActive: false },
      });
    }
    if (trial.workspaceId) {
      await tx.workspace.update({
        where: { id: trial.workspaceId },
        data: {
          plan: "CORE_FREE",
          planActivatedAt: new Date(),
        },
      });
      await tx.modelUsageBudget.upsert({
        where: { workspaceId: trial.workspaceId },
        create: {
          workspaceId: trial.workspaceId,
          monthlyCostCapUsd: 0,
        },
        update: {
          monthlyCostCapUsd: 0,
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: trial.workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "procurement_trial.suspended",
          entityType: "ProcurementTrial",
          entityId: trial.id,
          meta: { reason },
        },
      });
      await appendEvents(tx, [
        {
          workspaceId: trial.workspaceId,
          type: "procurement_trial.suspended",
          aggregateType: "ProcurementTrial",
          aggregateId: trial.id,
          payload: { trialId: trial.id, reason },
        },
      ]);
    }

    return updated;
  });
}
