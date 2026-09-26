import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { archiveWorkspaceArtifact } from "./archive";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { normalizeDuplicateGuardText } from "./duplicate-guard";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { acquireWorkItemAdvisoryLock, pickJsonSnapshot, recordWorkItemVersion } from "./work-item-versions";

type Pair = { workspaceId: string; canonicalId: string; duplicateId: string };

function meetingSourceId(bodyMd: string | null, workspaceId: string) {
  const match = bodyMd?.match(/\/workspaces\/([^/\s)]+)\/meetings\/([0-9a-f-]{36})/i);
  return match?.[1] === workspaceId ? match[2] : null;
}

function titleOverlap(left: string, right: string) {
  const leftTokens = new Set(normalizeDuplicateGuardText(left).split(" ").filter((word) => word.length > 2));
  const rightTokens = new Set(normalizeDuplicateGuardText(right).split(" ").filter((word) => word.length > 2));
  const common = [...leftTokens].filter((word) => rightTokens.has(word)).length;
  return common / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function mergedBody(canonicalBody: string | null, duplicateBody: string | null, duplicateTitle: string, duplicateId: string, workspaceId: string) {
  const current = canonicalBody?.trim() || "";
  const incoming = duplicateBody?.trim() || "";
  if (!incoming || normalizeDuplicateGuardText(current).includes(normalizeDuplicateGuardText(incoming))) return current || null;
  return [current, `Additional context from duplicate Action [${duplicateTitle}](/workspaces/${workspaceId}/actions/${duplicateId}):`, incoming]
    .filter(Boolean).join("\n\n---\n\n");
}

async function inspectPair(tx: Prisma.TransactionClient, pair: Pair) {
  invariant(pair.canonicalId !== pair.duplicateId, 400, "INVALID_INPUT", "Choose two different Actions.");
  const rows = await tx.action.findMany({
    where: { workspaceId: pair.workspaceId, id: { in: [pair.canonicalId, pair.duplicateId] } },
  });
  const canonical = rows.find((row) => row.id === pair.canonicalId);
  const duplicate = rows.find((row) => row.id === pair.duplicateId);
  invariant(canonical && duplicate, 404, "NOT_FOUND", "Both Actions must exist in this workspace.");

  const blockers: string[] = [];
  if (canonical.archivedAt || duplicate.archivedAt) blockers.push("Both Actions must be active.");
  if (canonical.duplicateOfActionId || duplicate.duplicateOfActionId || await tx.action.count({
    where: { workspaceId: pair.workspaceId, duplicateOfActionId: pair.duplicateId },
  }) > 0) blockers.push("An Action in this pair already has a duplicate resolution.");

  const canonicalMeetingId = meetingSourceId(canonical.bodyMd, pair.workspaceId);
  const duplicateMeetingId = meetingSourceId(duplicate.bodyMd, pair.workspaceId);
  const sameMeeting = Boolean(canonicalMeetingId && canonicalMeetingId === duplicateMeetingId);
  if ((canonical.title !== duplicate.title || canonical.bodyMd !== duplicate.bodyMd)
    && (!sameMeeting || titleOverlap(canonical.title, duplicate.title) < 0.5)) {
    blockers.push("Different text requires the same meeting source and a closely related title.");
  }

  for (const field of ["status", "isPrivate", "assigneeMemberId", "circleId", "dueAt", "proposalId", "priority", "completedVia"] as const) {
    const left = canonical[field];
    const right = duplicate[field];
    if (left instanceof Date && right instanceof Date ? left.getTime() !== right.getTime() : left !== right) {
      blockers.push(`${field} differs between the Actions.`);
    }
  }

  const referenceCounts = await Promise.all([
    tx.actionChecklistItem.count({ where: { workspaceId: pair.workspaceId, actionId: pair.duplicateId } }),
    tx.workItemEvidence.count({ where: { workspaceId: pair.workspaceId, entityType: "Action", entityId: pair.duplicateId } }),
    tx.workspaceExternalResourceAttachment.count({ where: { workspaceId: pair.workspaceId, entityType: "Action", entityId: pair.duplicateId } }),
    tx.communicationEntityLink.count({ where: { workspaceId: pair.workspaceId, entityType: "Action", entityId: pair.duplicateId } }),
    tx.deliberationEntry.count({ where: { workspaceId: pair.workspaceId, parentType: "ACTION", parentId: pair.duplicateId } }),
    tx.goalLink.count({ where: { entityType: "Action", entityId: pair.duplicateId } }),
    tx.adviceProcess.count({ where: { workspaceId: pair.workspaceId, subjectType: "ACTION", subjectId: pair.duplicateId } }),
    tx.approvalFlow.count({ where: { workspaceId: pair.workspaceId, subjectType: "ACTION", subjectId: pair.duplicateId } }),
  ]);
  if (referenceCounts.some((count) => count > 0)) blockers.push("The duplicate has checklist items or linked work; merge those explicitly before archiving it.");

  return {
    canonical: { id: canonical.id, title: canonical.title, bodyMd: canonical.bodyMd, status: canonical.status, version: canonical.version },
    duplicate: { id: duplicate.id, title: duplicate.title, bodyMd: duplicate.bodyMd, status: duplicate.status, version: duplicate.version },
    sameMeetingSource: sameMeeting,
    mergedBodyMd: mergedBody(canonical.bodyMd, duplicate.bodyMd, duplicate.title, duplicate.id, pair.workspaceId),
    blockers,
    eligible: blockers.length === 0,
  };
}

async function requireDuplicateResolutionAdmin(actor: AppActor, workspaceId: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A workspace admin must review Action duplicates.");
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
}

export async function previewActionDuplicateResolution(actor: AppActor, pair: Pair) {
  await requireDuplicateResolutionAdmin(actor, pair.workspaceId);
  return prisma.$transaction((tx) => inspectPair(tx, pair));
}

export async function resolveActionDuplicate(actor: AppActor, params: Pair & {
  expectedCanonicalVersion: number;
  expectedDuplicateVersion: number;
  confirmDuplicateId: string;
}) {
  await requireDuplicateResolutionAdmin(actor, params.workspaceId);
  invariant(params.confirmDuplicateId === params.duplicateId, 400, "INVALID_INPUT", "Confirm the exact Action to archive.");
  return prisma.$transaction(async (tx) => {
    for (const id of [params.canonicalId, params.duplicateId].sort()) {
      await acquireWorkItemAdvisoryLock(tx, "Action", id);
    }
    const preview = await inspectPair(tx, params);
    invariant(preview.canonical.version === params.expectedCanonicalVersion && preview.duplicate.version === params.expectedDuplicateVersion,
      409, "VERSION_CONFLICT", "An Action changed. Review both records again.");
    invariant(preview.eligible, 409, "ACTION_DUPLICATE_NOT_SAFE", preview.blockers.join(" "));

    if (preview.mergedBodyMd !== preview.canonical.bodyMd) {
      const nextVersion = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Action",
        entityId: params.canonicalId,
        currentVersion: preview.canonical.version,
        changedFields: ["bodyMd"],
        previousState: pickJsonSnapshot(preview.canonical, ["bodyMd"]),
      });
      await tx.action.update({
        where: { id: params.canonicalId, workspaceId: params.workspaceId, version: preview.canonical.version },
        data: { bodyMd: preview.mergedBodyMd, version: nextVersion },
      });
      await recordAudit(tx, actor, {
        workspaceId: params.workspaceId, action: "action.updated", entityType: "Action", entityId: params.canonicalId,
        meta: { mergedDuplicateActionId: params.duplicateId, fields: ["bodyMd"] },
      });
      await appendEvents(tx, [{
        workspaceId: params.workspaceId, type: "action.updated", aggregateType: "Action", aggregateId: params.canonicalId,
        payload: { actionId: params.canonicalId, fields: ["bodyMd"] },
      }]);
    }

    await tx.meetingInsight.updateMany({
      where: { workspaceId: params.workspaceId, appliedEntityType: "Action", appliedEntityId: params.duplicateId },
      data: { appliedEntityId: params.canonicalId },
    });
    await tx.meetingInsight.updateMany({
      where: { workspaceId: params.workspaceId, targetEntityType: "Action", targetEntityId: params.duplicateId },
      data: { targetEntityId: params.canonicalId },
    });
    await tx.actionCreationSource.updateMany({
      where: { workspaceId: params.workspaceId, actionId: params.duplicateId },
      data: { actionId: params.canonicalId },
    });

    await archiveWorkspaceArtifact(actor, {
      workspaceId: params.workspaceId,
      entityType: "Action",
      entityId: params.duplicateId,
      reason: `Duplicate of Action ${params.canonicalId}; reviewed by a workspace admin.`,
      _tx: tx,
    });
    await tx.action.update({
      where: { id: params.duplicateId },
      data: { duplicateOfActionId: params.canonicalId },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "action.duplicate_resolved",
        entityType: "Action",
        entityId: params.duplicateId,
        meta: { canonicalActionId: params.canonicalId, duplicateActionId: params.duplicateId },
      },
    });
    return { canonicalActionId: params.canonicalId, archivedDuplicateActionId: params.duplicateId };
  });
}
