import { prisma } from "@corgtex/shared";
import { activeCrmParentWhere, lockCrmLinkClosure } from "./crm-archive-guards";
import { invariant } from "./errors";

export async function applyEnrichmentResult(
  workspaceId: string,
  contactId: string,
  enrichedData: {
    description?: string | null;
    industry?: string | null;
    headquarters?: string | null;
    confidence: number;
  },
) {
  return prisma.$transaction(async (tx) => {
    const links = await tx.crmContact.findUnique({ where: { id: contactId } });
    invariant(links && links.workspaceId === workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    await lockCrmLinkClosure(tx, workspaceId, { contactId, accountId: links.accountId });
    const contact = await tx.crmContact.findFirst({ where: { id: contactId, workspaceId, archivedAt: null,
      ...activeCrmParentWhere(["account"]) } });
    invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    if (enrichedData.confidence >= 0.7) {
      const tags = new Set(contact.tags || []);
      if (enrichedData.industry) tags.add(enrichedData.industry);
      if (enrichedData.headquarters) tags.add(enrichedData.headquarters);
      await tx.crmContact.update({ where: { id: contact.id }, data: { tags: Array.from(tags) } });
    }
    await tx.crmActivity.create({ data: { workspaceId, type: "NOTE", accountId: contact.accountId ?? null, contactId,
      title: enrichedData.confidence >= 0.7 ? "Applied Enrichment Data" : "Low-Confidence Enrichment Found",
      bodyMd: `${enrichedData.confidence >= 0.7 ? "Applied high-confidence enrichment data" : `Low-confidence enrichment data found (score: ${enrichedData.confidence}). Please review`}: ${JSON.stringify({
        industry: enrichedData.industry, headquarters: enrichedData.headquarters, description: enrichedData.description })}` } });
  });
}
