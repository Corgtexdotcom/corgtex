import type { MemberRole } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { defaultStorage } from "@corgtex/storage";
import { withdrawActiveApprovalFlowForSubject } from "./approvals";
import { acquireConstitutionCorpusAdvisoryLock } from "./constitutions";
import { lockFinanceImportArtifactOwnership } from "./finance-import-artifact-ownership";
import {
  ensureWorkspacePermalink,
  isWorkspacePermalinkEntityType,
  workspaceEntityCanonicalPath,
  workspacePermanentPath,
} from "./permalinks";
import {
  acquireWorkItemAdvisoryLock,
  pickJsonSnapshot,
  recordWorkItemVersion,
  type WorkItemEntityType,
} from "./work-item-versions";

export type ArchiveFilter = "active" | "archived" | "all";

export function archiveFilterWhere(filter: ArchiveFilter = "active") {
  if (filter === "all") return {};
  if (filter === "archived") return { archivedAt: { not: null } };
  return { archivedAt: null };
}

type ArchiveEntityType =
  | "Action"
  | "AgentIdentity"
  | "BrainArticle"
  | "BrainSource"
  | "Circle"
  | "CrmAccount"
  | "CrmContact"
  | "CrmDeal"
  | "Document"
  | "ExpertiseTag"
  | "ExternalDataSource"
  | "Goal"
  | "Meeting"
  | "OAuthApp"
  | "Proposal"
  | "Role"
  | "Tension"
  | "WebhookEndpoint"
  | "WorkspaceToolLink"
  | "WorkspaceAgentConfig";

type ArchiveConfig = {
  delegate: string;
  entityType: ArchiveEntityType;
  label: (record: any) => string | null;
  findWhere: (workspaceId: string, entityId: string) => Record<string, unknown>;
  archiveData?: (record: any) => Record<string, unknown>;
  restoreData?: (previousState: Record<string, unknown> | null) => Record<string, unknown>;
  archiveAllowedRoles?: MemberRole[];
  canArchive?: (params: {
    tx: Prisma.TransactionClient;
    record: any;
    actor: AppActor;
    membership: MembershipSummary | null;
  }) => Promise<void>;
  canPurge?: (tx: Prisma.TransactionClient, record: any) => Promise<void>;
  beforePurge?: (tx: Prisma.TransactionClient, record: any) => Promise<void>;
  afterPurge?: (record: any) => Promise<void>;
};

async function requireFinanceImportArtifactUnlinked(
  tx: Prisma.TransactionClient,
  record: { id: string; workspaceId: string },
  field: "documentId" | "brainSourceId",
) {
  await lockFinanceImportArtifactOwnership(tx, {
    workspaceId: record.workspaceId,
    kind: field === "documentId" ? "DOCUMENT" : "BRAIN_SOURCE",
    id: record.id,
  });
  const link = field === "documentId" ? { documentId: record.id } : { brainSourceId: record.id };
  const batch = await tx.financeImportBatch.findFirst({
    where: { workspaceId: record.workspaceId, ...link },
    select: { id: true },
  });
  invariant(
    !batch,
    409,
    "FINANCE_IMPORT_ARTIFACT_MANAGED",
    "Finance report import artifacts must be managed from Finance.",
  );
}

function financeImportArtifactGuards(field: "documentId" | "brainSourceId") {
  return {
    canArchive: async ({ tx, record }: Parameters<NonNullable<ArchiveConfig["canArchive"]>>[0]) => {
      await requireFinanceImportArtifactUnlinked(tx, record, field);
    },
    canPurge: async (tx: Prisma.TransactionClient, record: any) => {
      await requireFinanceImportArtifactUnlinked(tx, record, field);
    },
  };
}

const directWorkspace = (workspaceId: string, id: string) => ({ id, workspaceId });
const titleOrName = (record: any) => record.title ?? record.name ?? record.label ?? record.slug ?? record.email ?? record.id ?? null;
const WORK_ITEM_ARCHIVE_ENTITY_TYPES = new Set<ArchiveEntityType>([
  "Action",
  "Goal",
  "Proposal",
  "Tension",
]);

const ENTITY_CONFIGS: Record<ArchiveEntityType, ArchiveConfig> = {
  Action: {
    entityType: "Action",
    delegate: "action",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  AgentIdentity: {
    entityType: "AgentIdentity",
    delegate: "agentIdentity",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveData: () => ({ isActive: false }),
    restoreData: () => ({ isActive: true }),
  },
  BrainArticle: {
    entityType: "BrainArticle",
    delegate: "brainArticle",
    findWhere: (workspaceId, slugOrId) => ({ workspaceId, OR: [{ id: slugOrId }, { slug: slugOrId }] }),
    label: titleOrName,
    beforePurge: async (tx, record) => {
      await tx.knowledgeChunk.deleteMany({
        where: {
          workspaceId: record.workspaceId,
          sourceType: "BRAIN_ARTICLE",
          sourceId: record.id,
        },
      });
    },
  },
  BrainSource: {
    entityType: "BrainSource",
    delegate: "brainSource",
    findWhere: directWorkspace,
    label: titleOrName,
    ...financeImportArtifactGuards("brainSourceId"),
    beforePurge: async (tx, record) => {
      await tx.knowledgeChunk.deleteMany({
        where: {
          workspaceId: record.workspaceId,
          sourceId: record.id,
        },
      });
    },
    afterPurge: async (record) => {
      if (record.fileStorageKey) await defaultStorage.delete(record.fileStorageKey).catch(() => undefined);
    },
  },
  Circle: {
    entityType: "Circle",
    delegate: "circle",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  CrmAccount: {
    entityType: "CrmAccount",
    delegate: "crmAccount",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  CrmContact: {
    entityType: "CrmContact",
    delegate: "crmContact",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  CrmDeal: {
    entityType: "CrmDeal",
    delegate: "crmDeal",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  Document: {
    entityType: "Document",
    delegate: "document",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["ADMIN"],
    ...financeImportArtifactGuards("documentId"),
    afterPurge: async (record) => {
      if (record.storageKey) await defaultStorage.delete(record.storageKey).catch(() => undefined);
    },
  },
  ExpertiseTag: {
    entityType: "ExpertiseTag",
    delegate: "expertiseTag",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  ExternalDataSource: {
    entityType: "ExternalDataSource",
    delegate: "externalDataSource",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["ADMIN"],
    archiveData: () => ({ isActive: false }),
    restoreData: () => ({ isActive: true }),
    beforePurge: async (tx, record) => {
      await tx.knowledgeChunk.deleteMany({
        where: {
          workspaceId: record.workspaceId,
          sourceType: "EXTERNAL_DATABASE",
          OR: [
            { sourceId: record.id },
            { sourceId: { startsWith: `byodb:${record.id}:` } },
          ],
        },
      });
    },
  },
  Goal: {
    entityType: "Goal",
    delegate: "goal",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  Meeting: {
    entityType: "Meeting",
    delegate: "meeting",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["ADMIN"],
  },
  OAuthApp: {
    entityType: "OAuthApp",
    delegate: "oAuthApp",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveData: () => ({ isActive: false }),
    restoreData: () => ({ isActive: true }),
  },
  Proposal: {
    entityType: "Proposal",
    delegate: "proposal",
    findWhere: directWorkspace,
    label: titleOrName,
    restoreData: (previousState) => {
      const previousStatus = typeof previousState?.status === "string" ? previousState.status : "DRAFT";
      const status = previousStatus === "SUBMITTED" || previousStatus === "ADVICE_GATHERING"
        ? "OPEN"
        : previousStatus === "APPROVED" || previousStatus === "REJECTED" || previousStatus === "ARCHIVED"
          ? "RESOLVED"
          : previousStatus;
      return { status };
    },
    canPurge: async (_tx, record) => {
      invariant(record.status === "DRAFT" || record.archivedAt, 400, "INVALID_STATE", "Only draft or archived proposals can be purged.");
    },
  },
  Role: {
    entityType: "Role",
    delegate: "role",
    findWhere: (workspaceId, id) => ({ id, circle: { workspaceId } }),
    label: titleOrName,
  },
  Tension: {
    entityType: "Tension",
    delegate: "tension",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  WebhookEndpoint: {
    entityType: "WebhookEndpoint",
    delegate: "webhookEndpoint",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["ADMIN"],
    archiveData: () => ({ status: "DISABLED" }),
    restoreData: () => ({ status: "ACTIVE" }),
  },
  WorkspaceToolLink: {
    entityType: "WorkspaceToolLink",
    delegate: "workspaceToolLink",
    findWhere: directWorkspace,
    label: titleOrName,
    canArchive: async ({ actor, membership, record }) => {
      if (actor.kind === "agent") return;
      if (membership && (membership.role === "ADMIN" || membership.role === "FACILITATOR")) return;
      invariant(
        record.createdByUserId && actor.kind === "user" && record.createdByUserId === actor.user.id,
        403,
        "FORBIDDEN",
        "Only the creator, facilitators, or admins can archive this tool link.",
      );
    },
  },
  WorkspaceAgentConfig: {
    entityType: "WorkspaceAgentConfig",
    delegate: "workspaceAgentConfig",
    findWhere: (workspaceId, idOrKey) => ({ workspaceId, OR: [{ id: idOrKey }, { agentKey: idOrKey }] }),
    label: (record) => record.agentKey ?? record.id,
    archiveData: () => ({ enabled: false }),
    restoreData: () => ({ enabled: true }),
  },
};

function configFor(entityType: string) {
  const config = ENTITY_CONFIGS[entityType as ArchiveEntityType];
  invariant(config, 400, "INVALID_INPUT", `Unsupported archive entity type: ${entityType}.`);
  return config;
}

function delegate(tx: Prisma.TransactionClient | typeof prisma, config: ArchiveConfig) {
  return (tx as any)[config.delegate];
}

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function actorLabel(actor: AppActor) {
  if (actor.kind === "user") return actor.user.displayName ?? actor.user.email;
  return actor.label ?? actor.authProvider ?? "agent";
}

function jsonSnapshot(record: unknown) {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
}

async function lockArchiveWorkItem(
  tx: Prisma.TransactionClient,
  entityType: ArchiveEntityType,
  entityId: string,
) {
  if (!WORK_ITEM_ARCHIVE_ENTITY_TYPES.has(entityType)) return;
  await acquireWorkItemAdvisoryLock(tx, entityType as WorkItemEntityType, entityId);
}

async function recomputeGoalProgressInTransaction(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  goalId: string,
) {
  await acquireWorkItemAdvisoryLock(tx, "Goal", goalId);
  const goal = await tx.goal.findUnique({
    where: { id: goalId },
    include: {
      keyResults: true,
      childGoals: {
        where: {
          archivedAt: null,
          NOT: {
            isPrivate: true,
            status: "DRAFT",
          },
        },
      },
    },
  });
  if (!goal) return;

  let computedProgress = goal.progressPercent;
  if (goal.keyResults.length > 0) {
    const total = goal.keyResults.reduce((acc, kr) => acc + kr.progressPercent, 0);
    computedProgress = Math.round(total / goal.keyResults.length);
  } else if (goal.childGoals.length > 0) {
    const total = goal.childGoals.reduce((acc, childGoal) => acc + childGoal.progressPercent, 0);
    computedProgress = Math.round(total / goal.childGoals.length);
  }

  if (computedProgress !== goal.progressPercent) {
    const nextVersion = await recordWorkItemVersion(tx, actor, {
      workspaceId: goal.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      currentVersion: goal.version,
      changedFields: ["progressPercent"],
      previousState: pickJsonSnapshot(goal as unknown as Record<string, unknown>, [
        "id",
        "workspaceId",
        "title",
        "descriptionMd",
        "level",
        "cadence",
        "progressPercent",
        "targetDate",
        "startDate",
        "parentGoalId",
        "circleId",
        "ownerMemberId",
        "authorUserId",
        "isPrivate",
        "publishedAt",
        "status",
        "version",
      ]),
    });

    try {
      await tx.goal.update({
        where: { id: goalId, version: goal.version },
        data: { progressPercent: computedProgress, version: nextVersion },
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
      }
      throw error;
    }

    if (goal.parentGoalId) {
      await recomputeGoalProgressInTransaction(tx, actor, goal.parentGoalId);
    }
  }
}

async function recomputeGoalParentProgressForArchiveTransition(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  record: any,
) {
  const parentGoalId = typeof record.parentGoalId === "string" ? record.parentGoalId : null;
  if (parentGoalId) {
    await recomputeGoalProgressInTransaction(tx, actor, parentGoalId);
  }
}

async function findRecord(tx: Prisma.TransactionClient | typeof prisma, config: ArchiveConfig, workspaceId: string, entityId: string) {
  const record = await delegate(tx, config).findFirst({
    where: config.findWhere(workspaceId, entityId),
  });
  invariant(record, 404, "NOT_FOUND", `${config.entityType} not found.`);
  return record;
}

async function activeArchiveRecord(tx: Prisma.TransactionClient, workspaceId: string, entityType: string, entityId: string) {
  return tx.workspaceArchiveRecord.findFirst({
    where: {
      workspaceId,
      entityType,
      entityId,
      restoredAt: null,
      purgedAt: null,
    },
    orderBy: { archivedAt: "desc" },
  });
}

export async function getWorkspaceArchiveRecord(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  includePurged?: boolean;
  includeRestored?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.workspaceArchiveRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.includeRestored ? {} : { restoredAt: null }),
      ...(params.includePurged ? {} : { purgedAt: null }),
    },
    orderBy: { archivedAt: "desc" },
  });
}

export async function archiveWorkspaceArtifact(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
}) {
  const config = configFor(params.entityType);
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: config.archiveAllowedRoles,
  });
  const reason = params.reason?.trim() || null;

  return prisma.$transaction(async (tx) => {
    await lockArchiveWorkItem(tx, config.entityType, params.entityId);
    const record = await findRecord(tx, config, params.workspaceId, params.entityId);
    await config.canArchive?.({ tx, record, actor, membership });
    if (record.archivedAt) {
      return record;
    }

    const previousState = jsonSnapshot(record);
    const archivedAt = new Date();
    const updated = await delegate(tx, config).update({
      where: { id: record.id },
      data: {
        archivedAt,
        archivedByUserId: actorUserId(actor),
        archiveReason: reason,
        ...(config.archiveData ? config.archiveData(record) : {}),
      },
    });
    if (config.entityType === "Goal") {
      await recomputeGoalParentProgressForArchiveTransition(tx, actor, record);
    }

    if (isWorkspacePermalinkEntityType(config.entityType)) {
      await ensureWorkspacePermalink(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: config.entityType,
        entityId: record.id,
        canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, config.entityType, record),
      });
    }

    await tx.workspaceArchiveRecord.create({
      data: {
        workspaceId: params.workspaceId,
        entityType: config.entityType,
        entityId: record.id,
        entityLabel: config.label(record),
        previousState: previousState as Prisma.InputJsonObject,
        archiveReason: reason,
        archivedByUserId: actorUserId(actor),
        archivedByLabel: actorLabel(actor),
        archivedAt,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actorUserId(actor),
        action: "workspace-artifact.archived",
        entityType: config.entityType,
        entityId: record.id,
        meta: {
          label: config.label(record),
          reason,
        },
      },
    });

    if (config.entityType === "Proposal") {
      await withdrawActiveApprovalFlowForSubject(tx, {
        workspaceId: params.workspaceId,
        subjectType: "PROPOSAL",
        subjectId: record.id,
        cleanupReason: `${config.entityType} archived`,
        actorUserId: actorUserId(actor),
        now: archivedAt,
      });
    }

    return updated;
  });
}

export async function restoreWorkspaceArtifact(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const config = configFor(params.entityType);

  return prisma.$transaction(async (tx) => {
    await lockArchiveWorkItem(tx, config.entityType, params.entityId);
    const record = await findRecord(tx, config, params.workspaceId, params.entityId);
    invariant(record.archivedAt, 400, "INVALID_STATE", `${config.entityType} is not archived.`);
    const archiveRecord = await activeArchiveRecord(tx, params.workspaceId, config.entityType, record.id);
    const previousState = archiveRecord?.previousState && typeof archiveRecord.previousState === "object"
      ? archiveRecord.previousState as Record<string, unknown>
      : null;
    const restoredAt = new Date();

    const updated = await delegate(tx, config).update({
      where: { id: record.id },
      data: {
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
        ...(config.restoreData ? config.restoreData(previousState) : {}),
      },
    });
    if (config.entityType === "Goal") {
      await recomputeGoalParentProgressForArchiveTransition(tx, actor, updated);
    }

    if (archiveRecord) {
      await tx.workspaceArchiveRecord.update({
        where: { id: archiveRecord.id },
        data: {
          restoredAt,
          restoredByUserId: actorUserId(actor),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actorUserId(actor),
        action: "workspace-artifact.restored",
        entityType: config.entityType,
        entityId: record.id,
        meta: { label: config.label(record) },
      },
    });

    return updated;
  });
}

export async function purgeWorkspaceArtifact(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  reason: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const config = configFor(params.entityType);
  const reason = params.reason.trim();
  invariant(reason.length > 0, 400, "INVALID_INPUT", "Purge reason is required.");

  const purged = await prisma.$transaction(async (tx) => {
    await lockArchiveWorkItem(tx, config.entityType, params.entityId);
    if (config.entityType === "Proposal") {
      await acquireConstitutionCorpusAdvisoryLock(tx, params.workspaceId);
    }
    const record = await findRecord(tx, config, params.workspaceId, params.entityId);
    invariant(record.archivedAt, 400, "INVALID_STATE", "Archive the artifact before purging it.");
    const archiveRecord = await activeArchiveRecord(tx, params.workspaceId, config.entityType, record.id);
    invariant(archiveRecord, 400, "INVALID_STATE", "Active archive record not found.");

    if (config.canPurge) {
      await config.canPurge(tx, record);
    }
    if (config.beforePurge) {
      await config.beforePurge(tx, record);
    }
    if (WORK_ITEM_ARCHIVE_ENTITY_TYPES.has(config.entityType)) {
      await tx.workItemVersion.deleteMany({
        where: {
          workspaceId: params.workspaceId,
          entityType: config.entityType,
          entityId: record.id,
        },
      });
    }

    await delegate(tx, config).delete({ where: { id: record.id } });
    await tx.workspaceArchiveRecord.update({
      where: { id: archiveRecord.id },
      data: {
        purgedAt: new Date(),
        purgedByUserId: actorUserId(actor),
        purgeReason: reason,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actorUserId(actor),
        action: "workspace-artifact.purged",
        entityType: config.entityType,
        entityId: record.id,
        meta: {
          label: config.label(record),
          reason,
        },
      },
    });

    return { result: { id: record.id }, record };
  });
  await config.afterPurge?.(purged.record);
  return purged.result;
}

export async function listArchivedWorkspaceArtifacts(actor: AppActor, params: {
  workspaceId: string;
  entityType?: string | null;
  take?: number;
  skip?: number;
  includeRestored?: boolean;
  includePurged?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const take = params.take ?? 100;
  const skip = params.skip ?? 0;

  const records = await prisma.workspaceArchiveRecord.findMany({
    where: {
      workspaceId: params.workspaceId,
      ...(params.entityType ? { entityType: params.entityType } : {}),
      ...(params.includeRestored ? {} : { restoredAt: null }),
      ...(params.includePurged ? {} : { purgedAt: null }),
    },
    orderBy: { archivedAt: "desc" },
    take,
    skip,
  });
  if (records.length === 0) return records;

  const permalinkEligibleRecords = records.filter((record) => isWorkspacePermalinkEntityType(record.entityType));
  if (permalinkEligibleRecords.length === 0) {
    return records.map((record) => ({ ...record, permanentPath: null }));
  }

  const permalinks = await prisma.workspacePermalink.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: permalinkEligibleRecords.map((record) => ({
        entityType: record.entityType,
        entityId: record.entityId,
      })),
    },
  });
  const permalinkByEntity = new Map(
    permalinks.map((permalink) => [`${permalink.entityType}:${permalink.entityId}`, permalink]),
  );

  return records.map((record) => {
    const permalink = permalinkByEntity.get(`${record.entityType}:${record.entityId}`);
    return {
      ...record,
      permanentPath: permalink ? workspacePermanentPath(params.workspaceId, permalink.id) : null,
    };
  });
}
