import type { MemberRole } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { defaultStorage } from "@corgtex/storage";

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
  | "CrmContact"
  | "CrmDeal"
  | "Cycle"
  | "Document"
  | "ExpertiseTag"
  | "ExternalDataSource"
  | "Goal"
  | "LedgerAccount"
  | "Meeting"
  | "OAuthApp"
  | "Proposal"
  | "Role"
  | "SpendRequest"
  | "Tension"
  | "WebhookEndpoint"
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
};

const directWorkspace = (workspaceId: string, id: string) => ({ id, workspaceId });
const titleOrName = (record: any) => record.title ?? record.name ?? record.label ?? record.slug ?? record.email ?? record.id ?? null;
const FINANCE_ARCHIVE_ROLES = new Set<MemberRole>(["FINANCE_STEWARD", "ADMIN"]);

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
    beforePurge: async (tx, record) => {
      await tx.knowledgeChunk.deleteMany({
        where: {
          workspaceId: record.workspaceId,
          sourceId: record.id,
        },
      });
      if (record.fileStorageKey) {
        await defaultStorage.delete(record.fileStorageKey).catch(() => undefined);
      }
    },
  },
  Circle: {
    entityType: "Circle",
    delegate: "circle",
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
  Cycle: {
    entityType: "Cycle",
    delegate: "cycle",
    findWhere: directWorkspace,
    label: titleOrName,
  },
  Document: {
    entityType: "Document",
    delegate: "document",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["ADMIN"],
    beforePurge: async (_tx, record) => {
      if (record.storageKey) {
        await defaultStorage.delete(record.storageKey).catch(() => undefined);
      }
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
  LedgerAccount: {
    entityType: "LedgerAccount",
    delegate: "ledgerAccount",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveAllowedRoles: ["FINANCE_STEWARD", "ADMIN"],
    canPurge: async (tx, record) => {
      const [entries, activeSpends] = await Promise.all([
        tx.ledgerEntry.count({ where: { accountId: record.id } }),
        tx.spendRequest.count({ where: { ledgerAccountId: record.id, archivedAt: null } }),
      ]);
      invariant(entries === 0, 400, "INVALID_STATE", "Ledger accounts with ledger entries cannot be purged.");
      invariant(activeSpends === 0, 400, "INVALID_STATE", "Ledger accounts linked to active spend requests cannot be purged.");
    },
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
    archiveData: () => ({ status: "ARCHIVED" }),
    restoreData: (previousState) => {
      const previousStatus = typeof previousState?.status === "string" ? previousState.status : "DRAFT";
      return { status: previousStatus };
    },
    canPurge: async (_tx, record) => {
      invariant(record.status === "DRAFT" || record.status === "ARCHIVED", 400, "INVALID_STATE", "Only draft or archived proposals can be purged.");
    },
  },
  Role: {
    entityType: "Role",
    delegate: "role",
    findWhere: (workspaceId, id) => ({ id, circle: { workspaceId } }),
    label: titleOrName,
  },
  SpendRequest: {
    entityType: "SpendRequest",
    delegate: "spendRequest",
    findWhere: directWorkspace,
    label: (record) => record.description ?? record.id,
    canArchive: async ({ actor, membership, record }) => {
      if (membership && FINANCE_ARCHIVE_ROLES.has(membership.role as MemberRole)) {
        return;
      }

      const actorUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, record.workspaceId);
      invariant(
        record.status === "DRAFT" && record.requesterUserId === actorUserId,
        403,
        "FORBIDDEN",
        "Only the requester can archive their own draft spend request. Finance stewards or admins are required for submitted or shared spend requests.",
      );
    },
    canPurge: async (tx, record) => {
      invariant(record.status === "DRAFT", 400, "INVALID_STATE", "Only draft spend requests can be purged.");
      const ledgerEntries = await tx.ledgerEntry.count({
        where: {
          referenceType: "SpendRequest",
          referenceId: record.id,
        },
      });
      invariant(ledgerEntries === 0, 400, "INVALID_STATE", "Spend requests with posted ledger entries cannot be purged.");
    },
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

  return prisma.$transaction(async (tx) => {
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

    return { id: record.id };
  });
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

  return prisma.workspaceArchiveRecord.findMany({
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
}
