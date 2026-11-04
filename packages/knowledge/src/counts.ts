import type { KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { isArtifactInputProofReadable, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { countReadableNonSqlKnowledgeChunks, countReadableSqlKnowledgeCollection, scanReadableKnowledgeChunks, summarizeReadableKnowledgeChunks } from "./retrieval";

/** Count only full child receipts and unchanged, currently readable ancestry. */
export async function countReadableKnowledgeChunks(actor: AppActor, workspaceId: string,
  sourceTypes?: KnowledgeSourceType[]) {
  const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const supported: KnowledgeSourceType[] = ["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT", "EXTERNAL_DATABASE"];
  const selected = sourceTypes?.length ? sourceTypes.filter((type) => supported.includes(type)) : supported;
  if (!selected.length || !accessDomains.length) return 0;
  const other = selected.filter(type => type !== "EXTERNAL_DATABASE");
  const {chunks, roots} = other.length ? await scanReadableKnowledgeChunks({actor, workspaceId, accessDomains, sourceTypes: other})
    : {chunks: [], roots: []};
  if (roots.length && !await isArtifactInputProofReadable(actor, workspaceId, roots)) {
    throw Object.assign(new Error("Knowledge inputs changed before count release."), { code: "SOURCE_CHANGED", status: 409 });
  }
  const sql = selected.includes("EXTERNAL_DATABASE") ? await countReadableSqlKnowledgeCollection({actor, workspaceId, accessDomains}, roots) : 0;
  return chunks.length + sql;
}

/** Complete dashboard aggregate with bounded hydration. Generic pages and the
 * native SQL collection each retain their existing current-read admission. */
export async function countReadableKnowledgeChunkAggregate(actor: AppActor, workspaceId: string,
  sourceTypes?: KnowledgeSourceType[]) {
  const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const supported: KnowledgeSourceType[] = ["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT", "EXTERNAL_DATABASE"];
  const selected = sourceTypes?.length ? sourceTypes.filter(type => supported.includes(type)) : supported;
  if (!selected.length || !accessDomains.length) return 0;
  const other = selected.filter(type => type !== "EXTERNAL_DATABASE");
  const {count, roots} = other.length
    ? await countReadableNonSqlKnowledgeChunks({ actor, workspaceId, accessDomains, sourceTypes: other })
    : {count: 0, roots: []};
  if (selected.includes("EXTERNAL_DATABASE")) {
    const sql = await countReadableSqlKnowledgeCollection({ actor, workspaceId, accessDomains }, roots);
    return count + sql;
  }
  const {withArtifactCountReleaseSnapshot} = await import("../../domain/src/source-lineage");
  return withArtifactCountReleaseSnapshot(actor, workspaceId, roots, async () => undefined, async () => count);
}

/** At most 200 examined chunks across all selected types. Incomplete counts are
 * lower bounds, including zero; exact-count APIs above retain their contracts. */
export async function getReadableKnowledgeChunkSummary(actor: AppActor, workspaceId: string,
  options: { sourceTypes?: KnowledgeSourceType[]; release?: import("../../domain/src/digest-lineage").DigestReadRelease } = {}) {
  const { DigestReadRelease } = await import("../../domain/src/digest-lineage");
  const release = options.release ?? new DigestReadRelease(actor, workspaceId);
  if (release.actor !== actor || release.workspaceId !== workspaceId) {
    throw Object.assign(new Error("Knowledge summary release belongs to another request."), { code: "SOURCE_RESTRICTED", status: 403 });
  }
  const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const supported: KnowledgeSourceType[] = ["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT", "EXTERNAL_DATABASE"];
  const selected = options.sourceTypes?.length ? options.sourceTypes.filter(type => supported.includes(type)) : supported;
  const summary = selected.length && accessDomains.length
    ? await summarizeReadableKnowledgeChunks({ actor, workspaceId, accessDomains, sourceTypes: selected }, release)
    : { count: 0, complete: true };
  return options.release ? summary : release.finish(summary);
}
