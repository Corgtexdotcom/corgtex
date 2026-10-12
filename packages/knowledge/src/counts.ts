import type { KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { lineageContentFingerprint, readableArtifactIds, resolveKnowledgeAccessDomains } from "@corgtex/domain";

/** Count committed SQL receipts that still have readable, unchanged inputs. */
export async function countReadableKnowledgeChunks(actor: AppActor, workspaceId: string,
  sourceTypes?: KnowledgeSourceType[]) {
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const supported: KnowledgeSourceType[] = ["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL"];
  const selected = sourceTypes?.length ? sourceTypes.filter((type) => supported.includes(type)) : supported;
  if (!selected.length || !domains.length) return 0;
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { workspaceId, accessDomain: { in: domains }, sourceType: { in: selected } },
    select: { sourceType: true, sourceId: true, metadata: true },
  });
  const ids = (type: KnowledgeSourceType) => [...new Set(chunks.filter((chunk) => chunk.sourceType === type)
    .map((chunk) => chunk.sourceId))];
  const [articles, documents, meetings, proposals] = await Promise.all([
    prisma.brainArticle.findMany({ where: { workspaceId, id: { in: ids("BRAIN_ARTICLE") }, archivedAt: null,
      isPrivate: false } }),
    prisma.document.findMany({ where: { workspaceId, id: { in: ids("DOCUMENT") }, archivedAt: null,
      accessDomain: { in: domains } } }),
    prisma.meeting.findMany({ where: { workspaceId, id: { in: ids("MEETING") }, archivedAt: null } }),
    prisma.proposal.findMany({ where: { workspaceId, id: { in: ids("PROPOSAL") }, archivedAt: null } }),
  ]);
  const [articleIds, documentIds, meetingIds, proposalIds] = await Promise.all([
    readableArtifactIds(actor, workspaceId, "BrainArticle", articles),
    readableArtifactIds(actor, workspaceId, "Document", documents),
    readableArtifactIds(actor, workspaceId, "Meeting", meetings),
    readableArtifactIds(actor, workspaceId, "Proposal", proposals),
  ]);
  const hashes = new Map<string, string>();
  for (const [type, kind, rows, readable] of [
    ["BRAIN_ARTICLE", "BrainArticle", articles, articleIds],
    ["DOCUMENT", "Document", documents, documentIds],
    ["MEETING", "Meeting", meetings, meetingIds],
    ["PROPOSAL", "Proposal", proposals, proposalIds],
  ] as const) {
    for (const row of rows) if (readable.has(row.id)) {
      hashes.set(`${type}:${row.id}`, lineageContentFingerprint(kind, row));
    }
  }
  return chunks.filter((chunk) => {
    const proof = hashes.get(`${chunk.sourceType}:${chunk.sourceId}`);
    return proof && (chunk.metadata as Record<string, unknown> | null)?.sourceContentHash === proof;
  }).length;
}
