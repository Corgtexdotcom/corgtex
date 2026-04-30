import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

export async function applyExtractionResult(
  workspaceId: string,
  qualificationId: string,
  extractedFields: {
    companyName?: string | null;
    website?: string | null;
    aiExperience?: string | null;
    helpNeeded?: string | null;
  }
) {
  const qualification = await prisma.crmQualification.findUnique({
    where: { id: qualificationId },
  });

  invariant(qualification && qualification.workspaceId === workspaceId, 404, "NOT_FOUND", "Qualification not found.");

  // Only update fields that are currently null to avoid overwriting existing data.
  const updateData: Record<string, string> = {};
  if (!qualification.companyName && extractedFields.companyName) updateData.companyName = extractedFields.companyName;
  if (!qualification.website && extractedFields.website) updateData.website = extractedFields.website;
  if (!qualification.aiExperience && extractedFields.aiExperience) updateData.aiExperience = extractedFields.aiExperience;
  if (!qualification.helpNeeded && extractedFields.helpNeeded) updateData.helpNeeded = extractedFields.helpNeeded;

  if (Object.keys(updateData).length > 0) {
    await prisma.crmQualification.update({
      where: { id: qualificationId },
      data: updateData,
    });
  }
}
