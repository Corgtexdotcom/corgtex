import type { AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { readableArtifactIds, type LineageKind } from "./source-lineage";

/** Scan stable identity pages before exposing totals, ordering or samples. */
export async function scanSourceReadableRecords<T extends { id: string }>(params: {
  actor: AppActor;
  workspaceId: string;
  kind: LineageKind;
  load: (afterId: string | undefined, take: number) => Promise<T[]>;
}) {
  const rows: T[] = [];
  let afterId: string | undefined;
  let scanned = 0;
  const seen = new Set<string>();
  while (true) {
    const take = Math.min(100, 5_000 - scanned);
    const batch = await params.load(afterId, take || 1);
    if (!take) {
      invariant(batch.length === 0, 503, "SOURCE_READ_SCAN_LIMIT", "Source permission scan exceeds its supported size.");
      break;
    }
    const ids = await readableArtifactIds(params.actor, params.workspaceId, params.kind, batch);
    for (const row of batch) {
      invariant(!seen.has(row.id), 503, "SOURCE_READ_SCAN_CHANGED", "Source permission scan changed; retry the request.");
      seen.add(row.id);
      if (ids.has(row.id)) rows.push(row);
    }
    scanned += batch.length;
    if (batch.length < take) break;
    afterId = batch.at(-1)!.id;
  }
  return rows;
}
