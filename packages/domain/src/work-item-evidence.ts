import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export const WORK_ITEM_EVIDENCE_ENTITY_TYPES = ["Proposal", "Tension", "Action"] as const;
export const WORK_ITEM_EVIDENCE_PURPOSES = ["resolution_evidence", "completion_evidence", "feedback_context"] as const;

export type WorkItemEvidenceEntityType = (typeof WORK_ITEM_EVIDENCE_ENTITY_TYPES)[number];
export type WorkItemEvidencePurpose = (typeof WORK_ITEM_EVIDENCE_PURPOSES)[number];

function normalizeDocumentIds(documentIds?: string[] | null) {
  return Array.from(new Set((documentIds ?? []).map((id) => id.trim()).filter(Boolean)));
}

export async function createWorkItemEvidenceLinks(tx: Prisma.TransactionClient, params: {
  workspaceId: string;
  entityType: WorkItemEvidenceEntityType;
  entityId: string;
  documentIds?: string[] | null;
  purpose: WorkItemEvidencePurpose;
}) {
  const documentIds = normalizeDocumentIds(params.documentIds);
  if (documentIds.length === 0) return [];

  const documents = await tx.document.findMany({
    where: {
      id: { in: documentIds },
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });
  invariant(documents.length === documentIds.length, 404, "NOT_FOUND", "Evidence document not found.");

  await tx.workItemEvidence.createMany({
    data: documentIds.map((documentId) => ({
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
      documentId,
      purpose: params.purpose,
    })),
    skipDuplicates: true,
  });

  return documentIds;
}

export async function listWorkItemEvidence(actor: AppActor, params: {
  workspaceId: string;
  entityType: WorkItemEvidenceEntityType;
  entityId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return prisma.workItemEvidence.findMany({
    where: {
      workspaceId: params.workspaceId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    include: {
      document: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
