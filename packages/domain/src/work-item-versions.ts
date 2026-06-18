import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { privacyFilter } from "./privacy";

export const WORK_ITEM_ENTITY_TYPES = ["Action", "Tension", "Proposal", "SpendRequest", "Goal"] as const;
export type WorkItemEntityType = typeof WORK_ITEM_ENTITY_TYPES[number];

const WORK_ITEM_ENTITY_TYPE_ALIASES: Record<string, WorkItemEntityType> = {
  ACTION: "Action",
  Action: "Action",
  TENSION: "Tension",
  Tension: "Tension",
  PROPOSAL: "Proposal",
  Proposal: "Proposal",
  SPEND: "SpendRequest",
  SPEND_REQUEST: "SpendRequest",
  SpendRequest: "SpendRequest",
  GOAL: "Goal",
  Goal: "Goal",
};

export function normalizeWorkItemEntityType(entityType: string): WorkItemEntityType {
  const normalized = WORK_ITEM_ENTITY_TYPE_ALIASES[entityType.trim()];
  invariant(normalized, 400, "INVALID_INPUT", "Unsupported work item entity type.");
  return normalized;
}

export function workItemEntityTypeToMcp(entityType: WorkItemEntityType) {
  if (entityType === "SpendRequest") return "SPEND";
  return entityType.toUpperCase();
}

export function requireSubmittedWorkItemAuthor(actor: AppActor, effectiveAuthorUserId?: string | null) {
  if (actor.kind === "user" && effectiveAuthorUserId && actor.user.id === effectiveAuthorUserId) {
    return;
  }
  throw new AppError(403, "FORBIDDEN", "Only the author can edit submitted work items.");
}

export function requireSubmittedWorkItemEditor(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  record: {
    authorUserId?: string | null;
    assigneeMemberId?: string | null;
  },
) {
  if (actor.kind === "user" && record.authorUserId && actor.user.id === record.authorUserId) {
    return;
  }
  if (actor.kind === "user" && membership?.isActive && record.assigneeMemberId && membership.id === record.assigneeMemberId) {
    return;
  }
  throw new AppError(403, "FORBIDDEN", "Only the author or assigned member can edit submitted work items.");
}

export async function resolveWorkspaceMemberUserId(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  memberId: string,
  message = "Member must be an active member of this workspace.",
) {
  const member = await tx.member.findFirst({
    where: {
      id: memberId,
      workspaceId,
      isActive: true,
    },
    select: {
      id: true,
      userId: true,
    },
  });
  invariant(member, 400, "INVALID_INPUT", message);
  return member.userId;
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  return value ?? null;
}

export function changedDataFields<T extends Record<string, unknown>>(
  current: T,
  data: Record<string, unknown>,
) {
  return Object.keys(data).filter((field) => comparable(current[field]) !== comparable(data[field]));
}

export function pickJsonSnapshot(
  current: Record<string, unknown>,
  fields: string[],
): Prisma.InputJsonValue {
  const snapshot = Object.fromEntries(fields.map((field) => [field, current[field] ?? null]));
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
}

function actorLabel(actor: AppActor) {
  if (actor.kind === "user") {
    return actor.user.displayName || actor.user.email || actor.user.id;
  }
  return actor.label || actor.authProvider || "agent";
}

export async function recordWorkItemVersion(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    entityType: WorkItemEntityType;
    entityId: string;
    currentVersion?: number | null;
    changedFields: string[];
    previousState: Prisma.InputJsonValue;
    source?: string;
  },
) {
  const currentVersion = params.currentVersion ?? 1;
  if (params.changedFields.length === 0) {
    return currentVersion;
  }

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('work_item_version'), hashtext(${`${params.entityType}:${params.entityId}`}))
  `;

  const existing = await tx.workItemVersion.findUnique({
    where: {
      entityType_entityId_version: {
        entityType: params.entityType,
        entityId: params.entityId,
        version: currentVersion,
      },
    },
    select: { id: true },
  });
  invariant(!existing, 409, "CONFLICT", "Work item version already exists.");

  await tx.workItemVersion.create({
    data: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
      version: currentVersion,
      changedFields: params.changedFields,
      previousState: params.previousState,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      actorLabel: actorLabel(actor),
      source: params.source ?? (actor.kind === "agent" ? "MCP_AGENT" : "WEB"),
    },
  });

  return currentVersion + 1;
}

async function assertCanReadWorkItemVersions(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null,
  params: {
    workspaceId: string;
    entityType: WorkItemEntityType;
    entityId: string;
  },
) {
  if (params.entityType === "Tension") {
    const item = await tx.tension.findFirst({
      where: {
        id: params.entityId,
        workspaceId: params.workspaceId,
        archivedAt: null,
        ...privacyFilter(actor, membership),
      },
      select: { id: true, version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Tension not found.");
    return item.version;
  }

  if (params.entityType === "Proposal") {
    const item = await tx.proposal.findFirst({
      where: {
        id: params.entityId,
        workspaceId: params.workspaceId,
        archivedAt: null,
        ...privacyFilter(actor, membership),
      },
      select: { id: true, version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Proposal not found.");
    return item.version;
  }

  if (params.entityType === "Action") {
    const item = await tx.action.findFirst({
      where: {
        id: params.entityId,
        workspaceId: params.workspaceId,
        archivedAt: null,
        ...privacyFilter(actor, membership),
      },
      select: { id: true, version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Action not found.");
    return item.version;
  }

  if (params.entityType === "SpendRequest") {
    const where: Prisma.SpendRequestWhereInput = {
      id: params.entityId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    };
    if (actor.kind === "user" && membership?.role !== "ADMIN") {
      where.OR = [
        { status: { not: "DRAFT" } },
        { status: "DRAFT", requesterUserId: actor.user.id },
      ];
    }
    const item = await tx.spendRequest.findFirst({
      where,
      select: { id: true, version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Spend request not found.");
    return item.version;
  }

  const item = await tx.goal.findFirst({
    where: {
      id: params.entityId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    select: { id: true, version: true },
  });
  invariant(item, 404, "NOT_FOUND", "Goal not found.");
  return item.version;
}

export async function listWorkItemVersions(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
}) {
  const entityType = normalizeWorkItemEntityType(params.entityType);
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const currentVersion = await assertCanReadWorkItemVersions(tx, actor, membership, {
      workspaceId: params.workspaceId,
      entityType,
      entityId: params.entityId,
    });
    const versions = await tx.workItemVersion.findMany({
      where: {
        workspaceId: params.workspaceId,
        entityType,
        entityId: params.entityId,
      },
      orderBy: { version: "desc" },
    });

    return {
      entityType,
      entityId: params.entityId,
      currentVersion,
      versions,
    };
  });
}

export async function getWorkItemVersion(actor: AppActor, params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  version: number;
}) {
  const entityType = normalizeWorkItemEntityType(params.entityType);
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  return prisma.$transaction(async (tx) => {
    const currentVersion = await assertCanReadWorkItemVersions(tx, actor, membership, {
      workspaceId: params.workspaceId,
      entityType,
      entityId: params.entityId,
    });
    const version = await tx.workItemVersion.findUnique({
      where: {
        entityType_entityId_version: {
          entityType,
          entityId: params.entityId,
          version: params.version,
        },
      },
    });
    invariant(version && version.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Work item version not found.");
    return { entityType, entityId: params.entityId, currentVersion, version };
  });
}

export async function getParentWorkItemVersion(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    parentType: string;
    parentId: string;
  },
) {
  if (params.parentType === "TENSION") {
    const item = await tx.tension.findFirst({
      where: { id: params.parentId, workspaceId: params.workspaceId },
      select: { version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Tension not found.");
    return item.version;
  }
  if (params.parentType === "PROPOSAL") {
    const item = await tx.proposal.findFirst({
      where: { id: params.parentId, workspaceId: params.workspaceId },
      select: { version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Proposal not found.");
    return item.version;
  }
  if (params.parentType === "ACTION") {
    const item = await tx.action.findFirst({
      where: { id: params.parentId, workspaceId: params.workspaceId },
      select: { version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Action not found.");
    return item.version;
  }
  if (params.parentType === "SPEND") {
    const item = await tx.spendRequest.findFirst({
      where: { id: params.parentId, workspaceId: params.workspaceId },
      select: { version: true },
    });
    invariant(item, 404, "NOT_FOUND", "Spend request not found.");
    return item.version;
  }
  return null;
}
