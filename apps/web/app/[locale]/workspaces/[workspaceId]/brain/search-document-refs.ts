import type { AppActor } from "@corgtex/shared";
import { listDocumentDirectory } from "@corgtex/domain";
import type { BrainSearchResultLike } from "./view-model";

/** Search linkage is independent of displayed ranges, pages and scan windows. */
export async function listLinkableBrainSearchDocumentRefs(params: {
  actor: AppActor; workspaceId: string; results: BrainSearchResultLike[];
}) {
  const ids = [...new Set(params.results.filter(row => row.sourceType === "DOCUMENT").map(row => row.sourceId))];
  if (!ids.length) return [];
  return (await listDocumentDirectory(params.actor, params.workspaceId, { ids })).items;
}
