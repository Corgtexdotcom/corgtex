import type { AppActor } from "@corgtex/shared";
import { ingestFile } from "@corgtex/knowledge";

export async function uploadWorkItemEvidenceDocument(actor: AppActor, params: {
  workspaceId: string;
  formData: FormData;
  entityType: "Proposal" | "Tension" | "Action";
  entityId: string;
  purpose: "resolution_evidence" | "completion_evidence";
}) {
  const file = params.formData.get("evidenceFile");
  if (!(file instanceof File) || file.size === 0) return [];

  const result = await ingestFile(actor, {
    workspaceId: params.workspaceId,
    fileBuffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    uploadSource: "work-item-evidence",
    documentTitle: file.name || `${params.entityType} evidence`,
    ingestionGuidanceMd: `Evidence for ${params.entityType} ${params.entityId} (${params.purpose}).`,
    documentMetadata: {
      entityType: params.entityType,
      entityId: params.entityId,
      purpose: params.purpose,
      size: file.size,
    },
  });

  return [result.document.id];
}
