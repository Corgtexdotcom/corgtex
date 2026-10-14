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

/** Streaming aggregates: complete scan work, at most one canonical page retained.
 * The loader must use id ASC and id > afterId; callers never receive raw totals.
 */
export async function visitSourceReadableRecords<T extends { id: string }>(params: {
  actor: AppActor;
  workspaceId: string;
  kind: LineageKind;
  load: (afterId: string | undefined, take: number) => Promise<T[]>;
  visit: (rows: T[]) => boolean | void | Promise<boolean | void>;
}) {
  let afterId: string | undefined;
  while (true) {
    const batch = await params.load(afterId, 100);
    let previous = afterId;
    for (const row of batch) {
      invariant(previous === undefined || row.id > previous, 503, "SOURCE_READ_SCAN_CHANGED", "Source permission scan changed; retry the request.");
      previous = row.id;
    }
    const readable = await readableArtifactIds(params.actor, params.workspaceId, params.kind, batch);
    if (await params.visit(batch.filter(row => readable.has(row.id))) === false || batch.length < 100) return;
    afterId = previous;
  }
}

export async function countSourceReadableRecords<T extends { id: string }>(params: Omit<Parameters<typeof visitSourceReadableRecords<T>>[0], "visit">) {
  let count = 0;
  await visitSourceReadableRecords({ ...params, visit: rows => { count += rows.length; } });
  return count;
}

export async function hasSourceReadableRecord<T extends { id: string }>(params: Omit<Parameters<typeof visitSourceReadableRecords<T>>[0], "visit">) {
  let found = false;
  await visitSourceReadableRecords({ ...params, visit: rows => { found = rows.length > 0; return !found; } });
  return found;
}
