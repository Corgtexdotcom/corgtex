import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

export async function applyEnrichmentResult(
  workspaceId: string,
  contactId: string,
  enrichedData: {
    description?: string | null;
    industry?: string | null;
    headquarters?: string | null;
    confidence: number;
  }
) {
  const contact = await prisma.crmContact.findUnique({
    where: { id: contactId },
  });

  invariant(contact && contact.workspaceId === workspaceId, 404, "NOT_FOUND", "Contact not found.");

  if (enrichedData.confidence >= 0.7) {
    // Only update fields that are currently null to avoid overwriting existing data.
    const tags = new Set(contact.tags || []);
    if (enrichedData.industry) tags.add(enrichedData.industry);
    if (enrichedData.headquarters) tags.add(enrichedData.headquarters);

    await prisma.crmContact.update({
      where: { id: contactId },
      data: {
        tags: Array.from(tags),
      },
    });
    
    await prisma.crmActivity.create({
      data: {
        workspaceId,
        type: "NOTE",
        contactId,
        title: "Applied Enrichment Data",
        bodyMd: `Applied high-confidence enrichment data: ${JSON.stringify({
          industry: enrichedData.industry,
          headquarters: enrichedData.headquarters,
          description: enrichedData.description,
        })}`,
      },
    });
  } else {
    // Log low confidence findings for human review
    await prisma.crmActivity.create({
      data: {
        workspaceId,
        type: "NOTE",
        contactId,
        title: "Low-Confidence Enrichment Found",
        bodyMd: `Low-confidence enrichment data found (score: ${enrichedData.confidence}). Please review: ${JSON.stringify({
          industry: enrichedData.industry,
          headquarters: enrichedData.headquarters,
          description: enrichedData.description,
        })}`,
      },
    });
  }
}
