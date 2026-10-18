import { prisma, type AppActor } from "@corgtex/shared";
import { activeCrmParentWhere, lockCrmLinkClosure } from "./crm-archive-guards";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { assertArtifactInputWriteFence, captureImmutableArtifactInputProof, currentArtifactInputRoots, isArtifactInputProofReadable, preserveUnknownArtifactInputSnapshot } from "./source-lineage";

export async function applyEnrichmentResult(
  workspaceId: string,
  contactId: string,
  enrichedData: { description?: string | null; industry?: string | null; headquarters?: string | null; confidence: number },
  options: ProducerLineageParams & { actor?: AppActor } = {},
) {
  const actor: AppActor = options.actor ?? { kind: "agent", authProvider: "bootstrap", label: "crm-lead-enrichment", workspaceIds: [workspaceId] };
  invariant(Number.isFinite(enrichedData.confidence) && enrichedData.confidence >= 0 && enrichedData.confidence <= 1,
    400, "INVALID_CONFIDENCE", "Enrichment confidence must be between zero and one.");
  await requireWorkspaceMembership({ actor, workspaceId });
  return prisma.$transaction(async (tx) => {
    await assertArtifactInputWriteFence(tx);
    const links = await tx.crmContact.findUnique({ where: { id: contactId } });
    invariant(links && links.workspaceId === workspaceId && !links.archivedAt, 404, "NOT_FOUND", "Contact not found.");
    await lockCrmLinkClosure(tx, workspaceId, { contactId, accountId: links.accountId });
    await tx.$queryRaw`SELECT id FROM "CrmContact" WHERE id = ${contactId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const contact = await tx.crmContact.findFirst({ where: { id: contactId, workspaceId, archivedAt: null, ...activeCrmParentWhere(["account"]) } });
    invariant(contact, 404, "NOT_FOUND", "Contact not found.");
    const dependencies = [{ kind: "CrmContact" as const, id: contactId, snapshot: contact },
      ...(contact.accountId ? [{ kind: "CrmAccount" as const, id: contact.accountId }] : [])];
    // Freeze all ancestors before changing this contact; downstream activities retain this exact input revision.
    let capture = options;
    if (options.lineageRoots?.length) {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, options.lineageRoots, tx), 409, "SOURCE_CHANGED", "Enrichment inputs changed.");
      capture = { ...options, lineageRoots: await captureImmutableArtifactInputProof(actor, workspaceId, options.lineageRoots, tx), lineageInputs: [] };
    }
    const contactReceipt = await prepareProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmContact", id: contactId },
      before: contact, capture, copied: true });
    const activityReceipt = await prepareProducerLineage({ tx, actor, workspaceId, capture,
      dependencies: options.lineageRoots?.length ? dependencies : [], snapshotDependencies: options.lineageRoots?.length ? [{ kind: "CrmContact", id: contactId }] : [], copied: true });
    if (enrichedData.confidence >= 0.7) {
      if (!await currentArtifactInputRoots(tx, workspaceId, { kind: "CrmContact", id: contactId }, contact)) {
        await preserveUnknownArtifactInputSnapshot(tx, workspaceId, { kind: "CrmContact", id: contactId }, contact);
      }
      const tags = new Set(contact.tags || []);
      if (enrichedData.industry) tags.add(enrichedData.industry);
      if (enrichedData.headquarters) tags.add(enrichedData.headquarters);
      const updated = await tx.crmContact.update({ where: { id: contact.id }, data: { tags: Array.from(tags) } });
      await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmContact", id: contactId }, content: updated, receipt: contactReceipt });
    }
    const activity = await tx.crmActivity.create({ data: { workspaceId, type: "NOTE", accountId: contact.accountId ?? null, contactId,
      title: enrichedData.confidence >= 0.7 ? "Applied Enrichment Data" : "Low-Confidence Enrichment Found",
      bodyMd: `${enrichedData.confidence >= 0.7 ? "Applied high-confidence enrichment data" : `Low-confidence enrichment data found (score: ${enrichedData.confidence}). Please review`}: ${JSON.stringify({
        industry: enrichedData.industry, headquarters: enrichedData.headquarters, description: enrichedData.description })}` } });
    await finishProducerLineage({ tx, actor, workspaceId, artifact: { kind: "CrmActivity", id: activity.id }, content: activity, receipt: activityReceipt });
  });
}
