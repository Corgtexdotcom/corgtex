import { DigestReadRelease } from "./digest-lineage";
import { createHash } from "node:crypto";
import type { MemberRole } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { incrementCacheVersion, prisma } from "@corgtex/shared";
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
import { appendEvents } from "./events";
import { findSourceArticleImpacts, sourceIdsInDerivation } from "./brain-source-impact";
import { lockActiveArticleSources, lockBrainSourceLink } from "./brain-source-links";
import { advanceArchivedArtifactEnvelopeLineage, assertArtifactInputWriteFence, isArtifactArchiveMetadataReadable, captureArtifactArchiveMetadataProof, isArtifactArchiveMetadataProofReadable, type ArchiveMetadataProof, isLineageKind, sealArtifactInputActor, isPurgedArchiveMetadataPolicyReadable, captureArtifactPermissionEpochs } from "./source-lineage";

import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  mergePermissionEpochProofs, parsePermissionEpochProof, type PermissionEpochProof } from "./source-permission-epochs";
import { artifactPermissionParents } from "./source-permission-parents";
import { categoryGovernorIdentities } from "./information-category-policy";

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
  | "CrmActivity"
  | "CrmContact"
  | "CrmDeal"
  | "DecisionRecord"
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
  restoreAllowedRoles?: MemberRole[] | null;
  canArchive?: (params: {
    tx: Prisma.TransactionClient;
    record: any;
    actor: AppActor;
    membership: MembershipSummary | null;
  }) => Promise<void>;
  canRestore?: (tx: Prisma.TransactionClient, record: any) => Promise<void>;
  canRestoreActor?: (params: { record: any; actor: AppActor; membership: MembershipSummary | null }) => Promise<void>;
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

const brainSourceFinanceImportGuards = financeImportArtifactGuards("brainSourceId");

function canCredentialAgentArchiveBrainSource(actor: AppActor, record: any) {
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return true;
  const scopes = actor.scopes ?? [];
  const hasSupportWrite = scopes.includes("support:write");
  const hasBrainWrite = scopes.includes("brain:write") || hasSupportWrite;
  const hasFinanceWrite = record.accessDomain !== "FINANCE"
    || scopes.includes("finance:write")
    || hasSupportWrite;
  return hasBrainWrite && hasFinanceWrite;
}

async function requireBrainSourceArchivePermission({
  tx,
  record,
  actor,
  membership,
}: Parameters<NonNullable<ArchiveConfig["canArchive"]>>[0]) {
  await brainSourceFinanceImportGuards.canArchive({ tx, record, actor, membership });
  invariant(
    canCredentialAgentArchiveBrainSource(actor, record),
    403,
    "FORBIDDEN",
    "Agent credential is missing the required Brain source archive scope.",
  );

  const canArchive = actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (record.authorMemberId !== null && record.authorMemberId === membership?.id);
  invariant(canArchive, 403, "FORBIDDEN", "Only the source author, workspace admins, or agents can archive this Brain source.");
}

const directWorkspace = (workspaceId: string, id: string) => ({ id, workspaceId });
const titleOrName = (record: any) => record.title ?? record.name ?? record.label ?? record.slug ?? record.email ?? record.id ?? null;
const WORK_ITEM_ARCHIVE_ENTITY_TYPES = new Set<ArchiveEntityType>([
  "Action",
  "Goal",
  "Proposal",
  "Tension",
]);
const CRM_ARCHIVE_ENTITY_TYPES = new Set<ArchiveEntityType>(["CrmAccount", "CrmActivity", "CrmContact", "CrmDeal"]);
type CrmParentSpec = readonly [ArchiveEntityType, "crmAccount" | "crmContact" | "crmDeal", "accountId" | "contactId" | "dealId"];

async function requireActiveCrmRestoreParents(tx: Prisma.TransactionClient, record: any, parents: readonly CrmParentSpec[]) {
  const ids = (type: ArchiveEntityType) => parents.flatMap(([entityType, , field]) =>
    entityType === type && record[field] ? [record[field] as string] : []);
  const dealIds = [...new Set(ids("CrmDeal"))].sort();
  for (const id of dealIds) await lockWorkspaceArchiveArtifact(tx, "CrmDeal", id);
  const deals = dealIds.length ? await tx.crmDeal.findMany({ where: { id: { in: dealIds }, workspaceId: record.workspaceId },
    select: { id: true, archivedAt: true, contactId: true, accountId: true } }) : [];
  const contactIds = [...new Set([...ids("CrmContact"), ...deals.map((deal) => deal.contactId)])].sort();
  for (const id of contactIds) await lockWorkspaceArchiveArtifact(tx, "CrmContact", id);
  const contacts = contactIds.length ? await tx.crmContact.findMany({ where: { id: { in: contactIds }, workspaceId: record.workspaceId },
    select: { id: true, archivedAt: true, accountId: true } }) : [];
  const accountIds = [...new Set([...ids("CrmAccount"), ...deals.flatMap((deal) => deal.accountId ? [deal.accountId] : []),
    ...contacts.flatMap((contact) => contact.accountId ? [contact.accountId] : [])])].sort();
  for (const id of accountIds) await lockWorkspaceArchiveArtifact(tx, "CrmAccount", id);
  const accounts = accountIds.length ? await tx.crmAccount.findMany({ where: { id: { in: accountIds }, workspaceId: record.workspaceId },
    select: { id: true, archivedAt: true } }) : [];
  const activeDeals = new Set(deals.filter((deal) => !deal.archivedAt).map((deal) => deal.id));
  const activeContacts = new Set(contacts.filter((contact) => !contact.archivedAt).map((contact) => contact.id));
  const activeAccounts = new Set(accounts.filter((account) => !account.archivedAt).map((account) => account.id));
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  invariant(dealIds.every((id) => { const deal = deals.find((item) => item.id === id); return deal && activeDeals.has(id)
    && activeContacts.has(deal.contactId) && (!deal.accountId || activeAccounts.has(deal.accountId)); }),
  409, "ARCHIVED_PARENT", "Restore the linked CrmDeal and its parents before restoring this record.");
  invariant(contactIds.every((id) => { const contact = contactById.get(id); return contact && activeContacts.has(id)
    && (!contact.accountId || activeAccounts.has(contact.accountId)); }),
  409, "ARCHIVED_PARENT", "Restore the linked CrmContact and its account before restoring this record.");
  invariant(ids("CrmAccount").every((id) => activeAccounts.has(id)), 409, "ARCHIVED_PARENT",
    "Restore the linked CrmAccount before restoring this record.");
}

async function requireNoActivityOrphan(tx: Prisma.TransactionClient, record: any, entityType: "CrmAccount" | "CrmContact" | "CrmDeal") {
  if (entityType === "CrmDeal") await tx.$queryRaw`SELECT "id" FROM "CrmDeal" WHERE "id" = ${record.id} FOR UPDATE`;
  else if (entityType === "CrmContact") await tx.$queryRaw`SELECT "id" FROM "CrmContact" WHERE "id" = ${record.id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${record.id} FOR UPDATE`;
  const where = entityType === "CrmDeal"
    ? { workspaceId: record.workspaceId, accountId: null, contactId: null, dealId: record.id }
    : entityType === "CrmContact" ? { workspaceId: record.workspaceId, accountId: null, OR: [
      { contactId: record.id, OR: [{ dealId: null }, { deal: { contactId: record.id } }] },
      { contactId: null, deal: { contactId: record.id } },
    ] } : { workspaceId: record.workspaceId, accountId: record.id, contactId: null, dealId: null };
  const activity = await tx.crmActivity.findFirst({ where, select: { id: true } });
  invariant(!activity, 409, "CRM_ACTIVITY_ORPHAN", "Relink or purge solely linked CRM activities before purging this record.");
}

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
    canArchive: async ({ record, actor, membership }) => {
      invariant(actor.kind === "agent" || membership?.role === "ADMIN"
        || (record.ownerMemberId !== null && record.ownerMemberId === membership?.id),
      403, "FORBIDDEN", "Only the article owner or a workspace admin can archive this article.");
    },
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
    canArchive: requireBrainSourceArchivePermission,
    canPurge: brainSourceFinanceImportGuards.canPurge,
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
    canPurge: (tx, record) => requireNoActivityOrphan(tx, record, "CrmAccount"),
  },
  CrmActivity: {
    entityType: "CrmActivity", delegate: "crmActivity", findWhere: directWorkspace, label: titleOrName,
    canRestore: (tx, record) => requireActiveCrmRestoreParents(tx, record, [
      ["CrmAccount", "crmAccount", "accountId"], ["CrmContact", "crmContact", "contactId"], ["CrmDeal", "crmDeal", "dealId"],
    ]),
  },
  CrmContact: {
    entityType: "CrmContact",
    delegate: "crmContact",
    findWhere: directWorkspace,
    label: titleOrName,
    canRestore: (tx, record) => requireActiveCrmRestoreParents(tx, record, [["CrmAccount", "crmAccount", "accountId"]]),
    canPurge: (tx, record) => requireNoActivityOrphan(tx, record, "CrmContact"),
  },
  CrmDeal: {
    entityType: "CrmDeal",
    delegate: "crmDeal",
    findWhere: directWorkspace,
    label: titleOrName,
    canRestore: (tx, record) => requireActiveCrmRestoreParents(tx, record, [
      ["CrmAccount", "crmAccount", "accountId"], ["CrmContact", "crmContact", "contactId"],
    ]),
    canPurge: (tx, record) => requireNoActivityOrphan(tx, record, "CrmDeal"),
  },
  DecisionRecord: {
    entityType: "DecisionRecord",
    delegate: "decisionRecord",
    findWhere: directWorkspace,
    label: titleOrName,
    archiveData: () => ({ version: { increment: 1 } }),
    restoreData: () => ({ version: { increment: 1 } }),
    restoreAllowedRoles: null,
    canArchive: async ({ record, actor, membership }) => {
      invariant(actor.kind === "agent" || membership?.role === "ADMIN" || record.createdByUserId === actor.user.id,
        403, "FORBIDDEN", "Only the decision author or a workspace admin can archive it.");
    },
    canRestoreActor: async ({ record, actor, membership }) => {
      invariant(actor.kind === "agent" || membership?.role === "ADMIN" || record.createdByUserId === actor.user.id,
        403, "FORBIDDEN", "Only the decision author or a workspace admin can restore it.");
    },
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

export async function lockWorkspaceArchiveArtifact(
  tx: Prisma.TransactionClient,
  entityType: ArchiveEntityType,
  entityId: string,
) {
  if (entityType === "BrainSource") {
    await lockBrainSourceLink(tx, entityId);
  } else if (entityType === "DecisionRecord" || CRM_ARCHIVE_ENTITY_TYPES.has(entityType)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace_archive:${entityType}:${entityId}`}, 0))`;
  }
  if (WORK_ITEM_ARCHIVE_ENTITY_TYPES.has(entityType)) {
    await acquireWorkItemAdvisoryLock(tx, entityType as WorkItemEntityType, entityId);
  }
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

const archiveMetadataSelect = {
  id: true, workspaceId: true, entityType: true, entityId: true,
  archivedAt: true, archivedByUserId: true, restoredAt: true, restoredByUserId: true,
  purgedAt: true, purgedByUserId: true, createdAt: true, updatedAt: true,
} as const;

function archiveMetadata(record: Prisma.WorkspaceArchiveRecordGetPayload<{ select: typeof archiveMetadataSelect }>) {
  return { id: record.id, workspaceId: record.workspaceId,
    entityType: record.entityType, entityId: record.entityId, entityLabel: record.entityType,
    archivedAt: record.archivedAt, archivedByUserId: record.archivedByUserId,
    restoredAt: record.restoredAt, restoredByUserId: record.restoredByUserId,
    purgedAt: record.purgedAt, purgedByUserId: record.purgedByUserId,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    archiveReason: null, archivedByLabel: null, purgeReason: null };
}

// Deliberately not a LineageKind: these heads authenticate purge status only,
// never artifact content, model inputs or generic source provenance.
const PURGED_AUDIT_KIND = "WorkspaceArchiveRecord";
const PURGED_POLICY_FIELDS = ["id", "workspaceId", "isPrivate", "status", "ownerMemberId", "authorUserId",
  "variantOfArticleId", "informationCategory", "accessDomain"] as const;
function auditHash(value: unknown): string {
  const canonical = (item: unknown): unknown => item instanceof Date ? item.toISOString()
    : Array.isArray(item) ? item.map(canonical)
      : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function auditHeadStamp(head: { id: string; revision: number; origin: string; contentHash: string;
  inputsJson: unknown; rootsJson: unknown; epochProofVersion: number | null; permissionEpochsJson: unknown }) {
  return auditHash([head.id, head.revision, head.origin, head.contentHash, head.inputsJson,
    head.rootsJson, head.epochProofVersion, head.permissionEpochsJson]);
}
type PurgedAuditReceipt = { version: 1; archiveRecordId: string; workspaceId: string; entityType: string; entityId: string;
  sourceHead: string; envelope: Record<string, unknown>; epochs: PermissionEpochProof };
type PurgedAuditProof = { record: ReturnType<typeof archiveMetadata>; receiptHash: string; head: string; epochs: PermissionEpochProof };

async function purgeAuditEnvelope(actor: AppActor, workspaceId: string, entityType: string,
  record: Record<string, unknown>, tx: Prisma.TransactionClient) {
  if (!isLineageKind(entityType) || artifactPermissionParents(entityType, record).length) return null;
  const head = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: entityType,
    artifactId: String(record.id) }, orderBy: { revision: "desc" } });
  if (!head || head.origin !== "HUMAN_ORIGINAL" || !await isArtifactArchiveMetadataReadable(actor, workspaceId,
    { kind: entityType, id: String(record.id) }, tx)) return null;
  const envelope = Object.fromEntries(PURGED_POLICY_FIELDS.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  if (!await isPurgedArchiveMetadataPolicyReadable(actor, workspaceId, entityType, envelope, tx)) return null;
  return { envelope, sourceHead: auditHeadStamp(head) };
}

async function readPurgedAudit(actor: AppActor, workspaceId: string, record: ReturnType<typeof archiveMetadata>,
  tx: Prisma.TransactionClient, expected?: PurgedAuditProof) {
  if (!record.purgedAt || record.workspaceId !== workspaceId) return null;
  // The JSON predicate excludes legacy body snapshots before hydration.
  const stored = await tx.workspaceArchiveRecord.findFirst({ where: { id: record.id, workspaceId,
    entityType: record.entityType, entityId: record.entityId, purgedAt: record.purgedAt, restoredAt: null,
    previousState: { path: ["purgedMetadata", "version"], equals: 1 } },
    select: { ...archiveMetadataSelect, previousState: true } });
  if (!stored || auditHash(archiveMetadata(stored)) !== auditHash(record)) return null;
  const wrapper = stored.previousState as { purgedMetadata?: PurgedAuditReceipt } | null;
  const receipt = wrapper?.purgedMetadata;
  if (!receipt || receipt.version !== 1 || receipt.archiveRecordId !== record.id || receipt.workspaceId !== workspaceId
    || receipt.entityType !== record.entityType || receipt.entityId !== record.entityId
    || !receipt.envelope || receipt.envelope.id !== record.entityId || receipt.envelope.workspaceId !== workspaceId
    || !parsePermissionEpochProof(receipt.epochs)) return null;
  const head = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: PURGED_AUDIT_KIND,
    artifactId: record.id }, orderBy: { revision: "desc" } });
  const source = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: record.entityType,
    artifactId: record.entityId }, orderBy: { revision: "desc" } });
  const receiptHash = auditHash(receipt);
  if (!head || head.revision !== 1 || head.origin !== "NATIVE_ORIGINAL" || head.contentHash !== receiptHash || head.epochProofVersion !== 1
    || auditHash(head.permissionEpochsJson) !== auditHash(receipt.epochs)
    || auditHash(head.inputsJson) !== auditHash([]) || auditHash(head.rootsJson) !== auditHash([])
    || !source || source.origin !== "HUMAN_ORIGINAL" || auditHeadStamp(source) !== receipt.sourceHead
    || expected && (expected.receiptHash !== receiptHash || expected.head !== auditHeadStamp(head))) return null;
  if (!await isArtifactPermissionEpochProofCurrent(workspaceId, receipt.epochs, tx)
    || expected && !await isArtifactPermissionEpochProofCurrent(workspaceId, expected.epochs, tx)
    || !await isPurgedArchiveMetadataPolicyReadable(actor, workspaceId, record.entityType, receipt.envelope, tx)) return null;
  return { receiptHash, head: auditHeadStamp(head) };
}

async function capturePurgedAudit(actor: AppActor, workspaceId: string, record: ReturnType<typeof archiveMetadata>) {
  return prisma.$transaction(async tx => {
    const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
    const captured = await readPurgedAudit(actor, workspaceId, record, tx);
    if (!captured) return null;
    const epochs = mergePermissionEpochProofs(await captureArtifactPermissionEpochs(actor, workspaceId, [], tx),
      membership?.id ? await capturePermissionEpochs(tx, workspaceId, [{ kind: "MemberRolePolicy", id: membership.id }]) : undefined)!;
    return { record, ...captured, epochs };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
}

/** Metadata authority stays separate from content proofs. A caller with later
 * awaits retains this collector and finishes it at its response boundary. */
export class ArchiveMetadataReadRelease {
  private readonly entries: Array<{record: ReturnType<typeof archiveMetadata>; proof?: ArchiveMetadataProof; purged?: PurgedAuditProof}> = [];
  constructor(readonly actor: AppActor, readonly workspaceId: string) {}
  async capture(record: ReturnType<typeof archiveMetadata>) {
    const purged = record.purgedAt ? await capturePurgedAudit(this.actor, this.workspaceId, record) : null;
    const proof = !record.purgedAt && isLineageKind(record.entityType)
      ? await captureArtifactArchiveMetadataProof(this.actor, this.workspaceId, {kind: record.entityType, id: record.entityId}) : null;
    if (!proof && !purged) return null;
    this.entries.push({record: structuredClone(record), proof: proof ?? undefined, purged: purged ?? undefined});
    return record;
  }
  async finish<T>(value: T, release = new DigestReadRelease(this.actor, this.workspaceId)): Promise<T> {
    invariant(release.actor === this.actor && release.workspaceId === this.workspaceId,
      409, "SOURCE_CHANGED", "Archive metadata release scope changed.");
    // Native replay must follow caller reads and remain outside the final RR.
    for (const {proof} of this.entries) if (proof) invariant(
      await isArtifactArchiveMetadataProofReadable(this.actor, this.workspaceId, proof),
      409, "SOURCE_CHANGED", "Archive metadata source access changed before release.");
    return release.finish(value, async tx => {
      for (const {record, proof, purged} of this.entries) {
        const current = await tx.workspaceArchiveRecord.findFirst({where: {id: record.id, workspaceId: this.workspaceId}, select: archiveMetadataSelect});
        invariant(current && auditHash(archiveMetadata(current)) === auditHash(record),
          409, "SOURCE_CHANGED", "Archive record changed before release.");
        invariant(proof ? await isArtifactArchiveMetadataProofReadable(this.actor, this.workspaceId, proof, tx)
          : purged && await readPurgedAudit(this.actor, this.workspaceId, record, tx, purged),
        409, "SOURCE_CHANGED", "Archive metadata permissions changed before release.");
      }
    });
  }
}

export async function getWorkspaceArchiveRecord(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  includePurged?: boolean;
  includeRestored?: boolean;
}, release?: ArchiveMetadataReadRelease) {
  invariant(!release || release.actor === actor && release.workspaceId === params.workspaceId,
    409, "SOURCE_CHANGED", "Archive metadata collection scope changed.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const record = await prisma.workspaceArchiveRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.includeRestored ? {} : { restoredAt: null }),
      ...(params.includePurged ? {} : { purgedAt: null }),
    },
    orderBy: { archivedAt: "desc" },
    select: archiveMetadataSelect,
  });
  if (!record) return null;
  const collector = release ?? new ArchiveMetadataReadRelease(actor, params.workspaceId);
  const admitted = await collector.capture(archiveMetadata(record));
  return release ? admitted : collector.finish(admitted);
}

export async function archiveWorkspaceArtifact(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
  expectedVersion?: number;
  _tx?: Prisma.TransactionClient;
}) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  if (params.expectedVersion !== undefined) {
    invariant(Number.isSafeInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "Expected version is invalid.");
  }
  const config = configFor(params.entityType);
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: config.archiveAllowedRoles,
  });
  const reason = params.reason?.trim() || null;

  const archive = async (tx: Prisma.TransactionClient) => {
    await assertArtifactInputWriteFence(tx);
    const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: config.archiveAllowedRoles, tx });
    await lockWorkspaceArchiveArtifact(tx, config.entityType, params.entityId);
    let record = await findRecord(tx, config, params.workspaceId, params.entityId);
    await config.canArchive?.({ tx, record, actor, membership });
    if (params.expectedVersion !== undefined) {
      invariant(record.version === params.expectedVersion, 409, "VERSION_CONFLICT", "The record changed. Reload and try again.");
    }
    if (record.archivedAt) {
      await assertArtifactInputWriteFence(tx);
      return { id: record.id };
    }

    if (config.entityType === "BrainSource" || config.entityType === "Document") {
      let documentSources = config.entityType === "Document" ? await tx.brainSource.findMany({
        where: {
          workspaceId: params.workspaceId,
          metadata: { path: ["documentId"], equals: record.id },
        },
        select: { id: true, archivedAt: true },
      }) : [];
      const sourceIds = config.entityType === "BrainSource" ? [record.id] : documentSources.map((source) => source.id);
      if (config.entityType === "Document") {
        for (const sourceId of sourceIds.sort()) await lockBrainSourceLink(tx, sourceId);
        // File replacement also locks sources before the document. Re-read after
        // waiting for its row lock; never acquire newly discovered source locks
        // here, which would invert that order.
        await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${record.id} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
        record = await findRecord(tx, config, params.workspaceId, params.entityId);
        if (record.archivedAt) { await assertArtifactInputWriteFence(tx); return { id: record.id }; }
        documentSources = await tx.brainSource.findMany({
          where: { workspaceId: params.workspaceId, metadata: { path: ["documentId"], equals: record.id } },
          select: { id: true, archivedAt: true },
        });
        invariant(documentSources.every((source) => sourceIds.includes(source.id)), 409, "SOURCE_CHANGED",
          "Document source links changed. Reload before archiving the document.");
      }
      const impacts = await findSourceArticleImpacts(tx, params.workspaceId, sourceIds);
      invariant(
        ![...impacts.values()].some((impact) => impact.articles.length > 0),
        409,
        "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED",
        "Linked Brain articles must be resolved before this source can be archived.",
      );
      if (config.entityType === "Document") {
        invariant(documentSources.every((source) => source.archivedAt), 409, "DOCUMENT_SOURCE_REMOVAL_REQUIRED",
          "Remove this document's Brain source entries through source review, then retry document deletion.");
      }
    }

    const previousState = jsonSnapshot(record);
    const archivedAt = new Date();
    let updated;
    try {
      updated = await delegate(tx, config).update({
        where: { id: record.id, ...(params.expectedVersion !== undefined ? { version: params.expectedVersion } : {}) },
        data: {
          archivedAt,
          archivedByUserId: actorUserId(actor),
          archiveReason: reason,
          ...(config.archiveData ? config.archiveData(record) : {}),
        },
      });
    } catch (error) {
      if (params.expectedVersion !== undefined && isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The record changed. Reload and try again.");
      }
      throw error;
    }
    if (isLineageKind(config.entityType)) await advanceArchivedArtifactEnvelopeLineage({
      tx, workspaceId: params.workspaceId, artifact: { kind: config.entityType, id: record.id }, before: record, after: updated,
    });
    if (config.entityType === "BrainArticle") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${record.id}`}, 0))`;
      await tx.knowledgeChunk.deleteMany({ where: {
        workspaceId: params.workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: record.id,
      } });
    }
    if (config.entityType === "Document") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document_index:${params.workspaceId}:${record.id}`}, 0))`;
      await tx.knowledgeChunk.deleteMany({ where: {
        workspaceId: params.workspaceId, sourceType: "DOCUMENT", sourceId: record.id,
      } });
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "document.updated",
        aggregateType: "Document", aggregateId: record.id, payload: { documentId: record.id } }]);
    }
    if (config.entityType === "BrainArticle" || config.entityType === "Document") {
      await incrementCacheVersion(`knowledge:${params.workspaceId}`, tx);
    }
    if (config.entityType === "Goal") {
      await recomputeGoalParentProgressForArchiveTransition(tx, actor, record);
    }
    if (config.entityType === "BrainArticle") {
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-article.updated",
        aggregateType: "BrainArticle", aggregateId: record.id, payload: { articleId: record.id } }]);
    }

    if (isWorkspacePermalinkEntityType(config.entityType)) {
      await ensureWorkspacePermalink(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: config.entityType,
        entityId: record.id,
        canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, config.entityType, record),
      });
    }

    if (["BrainSource", "Document"].includes(config.entityType)) await appendEvents(tx, [{
      workspaceId: params.workspaceId, type: "source-lineage.changed",
      aggregateType: config.entityType, aggregateId: record.id,
      payload: { kind: config.entityType, id: record.id, change: "archived" },
    }]);

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

    const finalMembership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: config.archiveAllowedRoles, tx });
    await config.canArchive?.({ tx, record: updated, actor, membership: finalMembership });
    await assertArtifactInputWriteFence(tx);
    return { id: updated.id };
  };
  return params._tx ? archive(params._tx) : prisma.$transaction(archive);
}

export async function restoreWorkspaceArtifact(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  expectedVersion?: number;
}) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  const config = configFor(params.entityType);
  if (params.expectedVersion !== undefined) {
    invariant(Number.isSafeInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "Expected version is invalid.");
  }
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: config.restoreAllowedRoles === null ? undefined : config.restoreAllowedRoles ?? ["ADMIN"],
  });

  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId,
      allowedRoles: config.restoreAllowedRoles === null ? undefined : config.restoreAllowedRoles ?? ["ADMIN"], tx });
    await lockWorkspaceArchiveArtifact(tx, config.entityType, params.entityId);
    const record = await findRecord(tx, config, params.workspaceId, params.entityId);
    invariant(record.archivedAt, 400, "INVALID_STATE", `${config.entityType} is not archived.`);
    await config.canRestoreActor?.({ record, actor, membership });
    if (params.expectedVersion !== undefined) {
      invariant(record.version === params.expectedVersion, 409, "VERSION_CONFLICT", "The record changed. Reload and try again.");
    }
    await config.canRestore?.(tx, record);
    if (config.entityType === "BrainArticle") {
      const sourceIds = [...new Set([...(record.sourceIds as string[]), ...sourceIdsInDerivation(record.derivationJson)])];
      await lockActiveArticleSources(tx, params.workspaceId, sourceIds);
    }
    const archiveRecord = await activeArchiveRecord(tx, params.workspaceId, config.entityType, record.id);
    const previousState = archiveRecord?.previousState && typeof archiveRecord.previousState === "object"
      ? archiveRecord.previousState as Record<string, unknown>
      : null;
    const restoredAt = new Date();

    let updated;
    try {
      updated = await delegate(tx, config).update({
        where: { id: record.id, ...(params.expectedVersion !== undefined ? { version: params.expectedVersion } : {}) },
        data: {
          archivedAt: null,
          archivedByUserId: null,
          archiveReason: null,
          ...(config.restoreData ? config.restoreData(previousState) : {}),
        },
      });
    } catch (error) {
      if (params.expectedVersion !== undefined && isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The record changed. Reload and try again.");
      }
      throw error;
    }
    if (isLineageKind(config.entityType)) await advanceArchivedArtifactEnvelopeLineage({
      tx, workspaceId: params.workspaceId, artifact: { kind: config.entityType, id: record.id }, before: record, after: updated,
    });
    if (config.entityType === "BrainArticle") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${record.id}`}, 0))`;
    }
    if (config.entityType === "Document") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document_index:${params.workspaceId}:${record.id}`}, 0))`;
      await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "document.updated",
        aggregateType: "Document", aggregateId: record.id, payload: { documentId: record.id } }]);
    }
    if (config.entityType === "BrainArticle" || config.entityType === "Document") {
      await incrementCacheVersion(`knowledge:${params.workspaceId}`, tx);
    }
    if (config.entityType === "Goal") {
      await recomputeGoalParentProgressForArchiveTransition(tx, actor, updated);
    }
    if (config.entityType === "BrainSource") {
      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "brain-source.created",
          aggregateType: "BrainSource",
          aggregateId: record.id,
          payload: { sourceId: record.id },
        },
      ]);
    }
    if (config.entityType === "BrainArticle") {
      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "brain-article.updated",
          aggregateType: "BrainArticle",
          aggregateId: record.id,
          payload: { articleId: record.id },
        },
      ]);
    }

    // BrainSource restore already emits brain-source.created above, whose
    // absorption dependency schedules exactly one complete lineage rebuild.
    if (config.entityType === "Document") await appendEvents(tx, [{
      workspaceId: params.workspaceId, type: "source-lineage.changed",
      aggregateType: config.entityType, aggregateId: record.id,
      payload: { kind: config.entityType, id: record.id, change: "restored" },
    }]);

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

    const finalMembership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId,
      allowedRoles: config.restoreAllowedRoles === null ? undefined : config.restoreAllowedRoles ?? ["ADMIN"], tx });
    await config.canRestoreActor?.({ record: updated, actor, membership: finalMembership });
    await assertArtifactInputWriteFence(tx);
    return { id: updated.id };
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
    await lockWorkspaceArchiveArtifact(tx, config.entityType, params.entityId);
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
    const auditEnvelope = await purgeAuditEnvelope(actor, params.workspaceId, config.entityType, record, tx);
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
    if (["BrainSource", "Document"].includes(config.entityType)) await appendEvents(tx, [{
      workspaceId: params.workspaceId, type: "source-lineage.changed",
      aggregateType: config.entityType, aggregateId: record.id,
      payload: { kind: config.entityType, id: record.id, change: "purged" },
    }]);
    await tx.workspaceArchiveRecord.update({
      where: { id: archiveRecord.id },
      data: {
        previousState: Prisma.DbNull,
        purgedAt: new Date(),
        purgedByUserId: actorUserId(actor),
        purgeReason: reason,
      },
    });
    let receipt: PurgedAuditReceipt | null = null;
    if (auditEnvelope) {
      // Capture after DELETE: the tombstone binds the new absence epoch, never
      // a pre-deletion content proof or the publisher's current authority.
      const epochs = await capturePermissionEpochs(tx, params.workspaceId, [
        { kind: PURGED_AUDIT_KIND, id: archiveRecord.id },
        ...artifactPermissionEpochIdentities(config.entityType, auditEnvelope.envelope),
        ...await categoryGovernorIdentities(config.entityType, auditEnvelope.envelope, params.workspaceId, tx),
      ]);
      receipt = { version: 1, archiveRecordId: archiveRecord.id, workspaceId: params.workspaceId,
        entityType: config.entityType, entityId: record.id, ...auditEnvelope, epochs };
      await tx.artifactInputLineage.create({ data: { workspaceId: params.workspaceId, artifactType: PURGED_AUDIT_KIND,
        artifactId: archiveRecord.id, revision: 1, origin: "NATIVE_ORIGINAL", contentHash: auditHash(receipt),
        inputsJson: [], rootsJson: [], epochProofVersion: 1, permissionEpochsJson: epochs as unknown as Prisma.InputJsonValue } });
    }
    if (receipt) await tx.workspaceArchiveRecord.update({ where: { id: archiveRecord.id },
      data: { previousState: { purgedMetadata: receipt } as unknown as Prisma.InputJsonValue } });

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
  invariant(Number.isInteger(take) && take >= 0 && take <= 5_000 && Number.isInteger(skip) && skip >= 0,
    400, "INVALID_INPUT", "Archive pagination is invalid.");

  if (take === 0) return [];
  const page: Array<{ record: ReturnType<typeof archiveMetadata>; proof?: ArchiveMetadataProof; purged?: PurgedAuditProof }> = [];
  let readablePosition = 0;
  let cursor: { archivedAt: Date; id: string } | undefined;
  while (page.length < take) {
    const records = await prisma.workspaceArchiveRecord.findMany({
      where: {
        workspaceId: params.workspaceId,
        ...(params.entityType ? { entityType: params.entityType } : {}),
        ...(params.includeRestored ? {} : { restoredAt: null }),
        ...(params.includePurged ? {} : { purgedAt: null }),
        ...(cursor ? { OR: [
          { archivedAt: { lt: cursor.archivedAt } },
          { archivedAt: cursor.archivedAt, id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ archivedAt: "desc" }, { id: "asc" }],
      // Bound hydration, not the size of the workspace. Denied candidates do
      // not consume readable skip/take; the deterministic cursor replenishes.
      select: archiveMetadataSelect,
      take: 100,
    });
    if (!records.length) break;
    for (const record of records) {
      if (record.purgedAt) {
        const purged = await capturePurgedAudit(actor, params.workspaceId, archiveMetadata(record));
        if (!purged || readablePosition++ < skip) continue;
        page.push({ record: purged.record, purged });
        if (page.length === take) break;
        continue;
      }
      if (!isLineageKind(record.entityType)) continue;
      const proof = await captureArtifactArchiveMetadataProof(actor, params.workspaceId,
        { kind: record.entityType, id: record.entityId });
      if (!proof) continue;
      if (readablePosition++ < skip) continue;
      page.push({ record: archiveMetadata(record), proof });
      if (page.length === take) break;
    }
    const last = records[records.length - 1];
    cursor = { archivedAt: last.archivedAt, id: last.id };
    if (records.length < 100) break;
  }
  const permalinkEligibleRecords = page.map(({ record }) => record)
    .filter(record => isWorkspacePermalinkEntityType(record.entityType));
  const permalinks = permalinkEligibleRecords.length ? await prisma.workspacePermalink.findMany({
    where: {
      workspaceId: params.workspaceId,
      OR: permalinkEligibleRecords.map(record => ({ entityType: record.entityType, entityId: record.entityId })),
    },
  }) : [];
  const permalinkByEntity = new Map(permalinks.map(permalink => [`${permalink.entityType}:${permalink.entityId}`, permalink]));
  // Restored active copies can depend on live provider authority. Replay the
  // original admitted receipts after discovery, outside the local release tx.
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  for (const { proof } of page) {
    if (!proof) continue;
    invariant(await isArtifactArchiveMetadataProofReadable(actor, params.workspaceId, proof),
      409, "SOURCE_CHANGED", "Archive metadata source access changed before release.");
  }
  // All later archive discovery and permalink reads finish before this fresh
  // shared snapshot. Never replace an admitted proof with today's receipt.
  return prisma.$transaction(async tx => {
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"], tx });
    for (const { proof, purged } of page) {
      invariant(proof ? await isArtifactArchiveMetadataProofReadable(actor, params.workspaceId, proof, tx)
        : purged && await readPurgedAudit(actor, params.workspaceId, purged.record, tx, purged),
      409, "SOURCE_CHANGED", "Archive metadata permissions changed before release.");
    }
    return page.map(({ record }) => {
      const permalink = permalinkByEntity.get(`${record.entityType}:${record.entityId}`);
      return { ...record, permanentPath: permalink ? workspacePermanentPath(params.workspaceId, permalink.id) : null };
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
}
