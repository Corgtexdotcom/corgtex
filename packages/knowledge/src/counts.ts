import type { KnowledgeSourceType } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { isArtifactInputProofReadable, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { scanReadableKnowledgeChunks } from "./retrieval";

/** Count only full child receipts and unchanged, currently readable ancestry. */
export async function countReadableKnowledgeChunks(actor: AppActor, workspaceId: string,
  sourceTypes?: KnowledgeSourceType[]) {
  const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const supported: KnowledgeSourceType[] = ["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT", "EXTERNAL_DATABASE"];
  const selected = sourceTypes?.length ? sourceTypes.filter((type) => supported.includes(type)) : supported;
  if (!selected.length || !accessDomains.length) return 0;
  const { chunks, roots } = await scanReadableKnowledgeChunks({ actor, workspaceId, accessDomains, sourceTypes: selected });
  if (!chunks.length) return 0;
  if (!await isArtifactInputProofReadable(actor, workspaceId, roots)) {
    throw Object.assign(new Error("Knowledge inputs changed before count release."), { code: "SOURCE_CHANGED", status: 409 });
  }
  return chunks.length;
}
