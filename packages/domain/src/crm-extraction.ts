import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { assertArtifactInputWriteFence, captureImmutableArtifactInputProof, currentArtifactInputRoots, preserveUnknownArtifactInputSnapshot } from "./source-lineage";

export async function applyExtractionResult(
  workspaceId: string,
  qualificationId: string,
  extractedFields: {
    companyName?: string | null;
    website?: string | null;
    aiExperience?: string | null;
    helpNeeded?: string | null;
  },
  options: ProducerLineageParams & { actor?: AppActor } = {},
) {
  const actor: AppActor = options.actor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-email-extraction", workspaceIds: [workspaceId] };
  await requireWorkspaceMembership({ actor, workspaceId });
  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    await tx.$queryRaw`SELECT id FROM "CrmQualification" WHERE id = ${qualificationId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const qualification = await tx.crmQualification.findFirst({ where: { id: qualificationId, workspaceId } });
    invariant(qualification && qualification.workspaceId === workspaceId, 404, "NOT_FOUND", "Qualification not found.");
    const artifact = { kind: "CrmQualification" as const, id: qualificationId };
    const capture = options.lineageRoots?.length ? { lineageInputs: [], lineageRoots: await captureImmutableArtifactInputProof(actor, workspaceId, options.lineageRoots, tx) } : options;
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId, artifact, before: qualification,
      capture, copied: true });
    // A partial extraction retains prior fields. Preserve an unknown revision without promoting it.
    if (!await currentArtifactInputRoots(tx, workspaceId, artifact, qualification)) {
      await preserveUnknownArtifactInputSnapshot(tx, workspaceId, artifact, qualification);
    }
    const data: Record<string, string> = {};
    if (!qualification.companyName && extractedFields.companyName) data.companyName = extractedFields.companyName;
    if (!qualification.website && extractedFields.website) data.website = extractedFields.website;
    if (!qualification.aiExperience && extractedFields.aiExperience) data.aiExperience = extractedFields.aiExperience;
    if (!qualification.helpNeeded && extractedFields.helpNeeded) data.helpNeeded = extractedFields.helpNeeded;
    if (!Object.keys(data).length) return;
    const updated = await tx.crmQualification.update({ where: { id: qualificationId }, data });
    await finishProducerLineage({ tx, actor, workspaceId, artifact, content: updated, receipt });
  });
}
