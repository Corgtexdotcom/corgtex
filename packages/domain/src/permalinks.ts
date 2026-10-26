import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { privacyFilter } from "./privacy";
import { DigestReadRelease } from "./digest-lineage";

export const WORKSPACE_PERMALINK_ENTITY_TYPES = [
  "Action",
  "Tension",
  "Proposal",
  "BrainArticle",
  "Meeting",
  "Goal",
] as const;

export type WorkspacePermalinkEntityType = (typeof WORKSPACE_PERMALINK_ENTITY_TYPES)[number];

type CanonicalEntity = {
  id: string;
  slug?: string | null;
  cadence?: string | null;
};

const WORKSPACE_PERMALINK_ENTITY_TYPE_SET = new Set<string>(WORKSPACE_PERMALINK_ENTITY_TYPES);

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

export function isWorkspacePermalinkEntityType(entityType: string): entityType is WorkspacePermalinkEntityType {
  return WORKSPACE_PERMALINK_ENTITY_TYPE_SET.has(entityType);
}

export function workspacePermanentPath(workspaceId: string, permalinkId: string) {
  return `/workspaces/${workspaceId}/items/${permalinkId}`;
}

export function workspaceEntityCanonicalPath(
  workspaceId: string,
  entityType: WorkspacePermalinkEntityType,
  entity: CanonicalEntity,
) {
  if (entityType === "Action") return `/workspaces/${workspaceId}/actions/${entity.id}`;
  if (entityType === "Tension") return `/workspaces/${workspaceId}/tensions/${entity.id}`;
  if (entityType === "Proposal") return `/workspaces/${workspaceId}/proposals/${entity.id}`;
  if (entityType === "BrainArticle") return `/workspaces/${workspaceId}/brain/${entity.slug ?? entity.id}`;
  if (entityType === "Meeting") return `/workspaces/${workspaceId}/meetings/${entity.id}`;
  return `/workspaces/${workspaceId}/goals?view=tree&cadence=${entity.cadence ?? "QUARTERLY"}&goalId=${entity.id}`;
}

export async function ensureWorkspacePermalink(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    entityType: WorkspacePermalinkEntityType;
    entityId: string;
    canonicalPath: string;
  },
) {
  return tx.workspacePermalink.upsert({
    where: {
      workspaceId_entityType_entityId: {
        workspaceId: params.workspaceId,
        entityType: params.entityType,
        entityId: params.entityId,
      },
    },
    update: {
      canonicalPath: params.canonicalPath,
    },
    create: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
      canonicalPath: params.canonicalPath,
      createdByUserId: actorUserId(actor),
    },
  });
}

export async function getWorkspacePermalinkForEntity(params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
}) {
  if (!isWorkspacePermalinkEntityType(params.entityType)) return null;
  return prisma.workspacePermalink.findUnique({
    where: {
      workspaceId_entityType_entityId: {
        workspaceId: params.workspaceId,
        entityType: params.entityType,
        entityId: params.entityId,
      },
    },
  });
}

export async function getWorkspacePermanentPathForEntity(params: {
  workspaceId: string;
  entityType: string;
  entityId: string;
}) {
  const permalink = await getWorkspacePermalinkForEntity(params);
  return permalink ? workspacePermanentPath(params.workspaceId, permalink.id) : null;
}

async function resolveAction(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, entityId: string) {
  return prisma.action.findFirst({
    where: { id: entityId, workspaceId, ...privacyFilter(actor, membership) },
  });
}

async function resolveTension(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, entityId: string) {
  return prisma.tension.findFirst({
    where: { id: entityId, workspaceId, ...privacyFilter(actor, membership) },
  });
}

async function resolveProposal(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, entityId: string) {
  const proposal = await prisma.proposal.findFirst({
    where: { id: entityId, workspaceId, ...privacyFilter(actor, membership) },
  });
  if (!proposal) return null;
  return proposal;
}

async function resolveArticle(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, entityId: string) {
  const article = await prisma.brainArticle.findFirst({
    where: { id: entityId, workspaceId },
    include: { ownerMember: { select: { userId: true } } },
  });
  if (!article) return null;
  const canReadPrivateDraft = actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && article.ownerMember?.userId === actor.user.id);
  if (article.isPrivate && !canReadPrivateDraft) return null;
  return article;
}

async function resolveMeeting(workspaceId: string, entityId: string) {
  return prisma.meeting.findFirst({
    where: { id: entityId, workspaceId },
  });
}

async function resolveGoal(actor: AppActor, membership: MembershipSummary | null, workspaceId: string, entityId: string) {
  const goal = await prisma.goal.findFirst({
    where: { id: entityId, workspaceId, ...privacyFilter(actor, membership) },
  });
  if (!goal) return null;
  return goal;
}

async function resolveLinkedEntity(
  actor: AppActor,
  membership: MembershipSummary | null,
  entityType: WorkspacePermalinkEntityType,
  workspaceId: string,
  entityId: string,
) {
  if (entityType === "Action") return resolveAction(actor, membership, workspaceId, entityId);
  if (entityType === "Tension") return resolveTension(actor, membership, workspaceId, entityId);
  if (entityType === "Proposal") return resolveProposal(actor, membership, workspaceId, entityId);
  if (entityType === "BrainArticle") return resolveArticle(actor, membership, workspaceId, entityId);
  if (entityType === "Meeting") return resolveMeeting(workspaceId, entityId);
  return resolveGoal(actor, membership, workspaceId, entityId);
}

export async function resolveWorkspacePermalink(actor: AppActor, params: {
  workspaceId: string;
  permalinkId: string;
}) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const permalink = await prisma.workspacePermalink.findFirst({
    where: {
      id: params.permalinkId,
      workspaceId: params.workspaceId,
    },
  });
  invariant(permalink, 404, "NOT_FOUND", "Permanent link not found.");
  invariant(isWorkspacePermalinkEntityType(permalink.entityType), 404, "NOT_FOUND", "Permanent link target not found.");

  const entity = await resolveLinkedEntity(
    actor,
    membership,
    permalink.entityType,
    params.workspaceId,
    permalink.entityId,
  );

  invariant(entity, 404, "NOT_FOUND", "Permanent link target not found.");
  const release = new DigestReadRelease(actor, params.workspaceId);
  const admitted = await release.capture(permalink.entityType, [entity]);
  invariant(admitted.records.length === 1, 404, "NOT_FOUND", "Permanent link target not found.");
  const archiveRecord = await prisma.workspaceArchiveRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      entityType: permalink.entityType,
      entityId: permalink.entityId,
      restoredAt: null,
    },
    orderBy: { archivedAt: "desc" },
  });
  // Original canonical proof and heads survive the archive lookup and are
  // released with current caller membership before any ID, status or redirect.
  return release.finish({
    status: entity.archivedAt ? "ARCHIVED" as const : "ACTIVE" as const,
    permalink,
    archiveRecord,
    canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, permalink.entityType, entity),
  });
}
