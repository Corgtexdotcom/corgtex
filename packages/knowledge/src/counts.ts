import type { KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { isArtifactInputProofReadable, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { countReadableNonSqlKnowledgeChunks, countReadableSqlKnowledgeCollection, scanReadableKnowledgeChunks } from "./retrieval";

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
