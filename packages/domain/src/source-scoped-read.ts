import type { AppActor } from "@corgtex/shared";
import { DigestReadRelease } from "./digest-lineage";
import { invariant } from "./errors";
import type { LineageKind } from "./source-lineage";

const SOURCE_READ_LIMIT = 5_000;
const SOURCE_PROOF_BATCH_SIZE = 100;
type SourceRead<T extends { id: string }> = {
  actor: AppActor;
  workspaceId: string;
  kind: LineageKind;
  release?: DigestReadRelease;
  load: (afterId: string | undefined, take: number) => Promise<T[]>;
};
async function sourceCandidates<T extends { id: string }>(params: SourceRead<T>) {
  // One statement gives exact APIs one candidate snapshot. The sentinel proves
  // exhaustion without mixing live identity pages or retaining an unbounded corpus.
  const rows = await params.load(undefined, SOURCE_READ_LIMIT + 1);
  invariant(rows.length <= SOURCE_READ_LIMIT + 1, 503, "SOURCE_READ_SCAN_CHANGED", "Source query exceeded its requested limit.");
  let previous: string | undefined;
  for (const row of rows) {
    invariant(previous === undefined || row.id > previous, 503, "SOURCE_READ_SCAN_CHANGED", "Source permission scan changed; retry the request.");
    previous = row.id;
  }
  return rows;
}
function requireComplete(complete: boolean) {
  invariant(complete, 409, "SOURCE_READ_SCAN_LIMIT", "Source result exceeds the 5000-candidate exact-read limit; narrow the request.");
}

/** Exact bounded collection. Large callers must narrow their query, never use a partial total. */
export async function scanSourceReadableRecords<T extends { id: string }>(params: SourceRead<T>) {
  const candidates = await sourceCandidates(params);
  requireComplete(candidates.length <= SOURCE_READ_LIMIT);
  const rows: T[] = [];
  const release = params.release ?? new DigestReadRelease(params.actor, params.workspaceId);
  for (let offset = 0; offset < candidates.length; offset += SOURCE_PROOF_BATCH_SIZE) {
    const captured = await release.capture(params.kind, candidates.slice(offset, offset + SOURCE_PROOF_BATCH_SIZE));
    rows.push(...captured.records);
  }
  return params.release ? rows : release.finish(rows);
}

type SourceVisit<T extends { id: string }> = SourceRead<T> & {
  visit: (rows: T[]) => boolean | void | Promise<boolean | void>;
};
async function visitSourceCandidates<T extends { id: string }>(params: SourceVisit<T>, existenceOnly = false) {
  const candidates = await sourceCandidates(params);
  const complete = candidates.length <= SOURCE_READ_LIMIT;
  if (!existenceOnly) requireComplete(complete);
  const release = params.release ?? new DigestReadRelease(params.actor, params.workspaceId);
  let stopped = false;
  for (let offset = 0; offset < Math.min(candidates.length, SOURCE_READ_LIMIT); offset += SOURCE_PROOF_BATCH_SIZE) {
    const captured = await release.capture(params.kind, candidates.slice(offset, Math.min(offset + SOURCE_PROOF_BATCH_SIZE, SOURCE_READ_LIMIT)));
    if (await params.visit(captured.records) === false) { stopped = true; break; }
  }
  requireComplete(complete || existenceOnly && stopped);
  if (!params.release) await release.finish(undefined);
}

/** Exact aggregates keep the original proof union through final release. */
export async function visitSourceReadableRecords<T extends { id: string }>(params: SourceVisit<T>) {
  await visitSourceCandidates(params);
}
export async function countSourceReadableRecords<T extends { id: string }>(params: SourceRead<T>) {
  let count = 0;
  await visitSourceReadableRecords({ ...params, visit: rows => { count += rows.length; } });
  return count;
}
export async function hasSourceReadableRecord<T extends { id: string }>(params: SourceRead<T>) {
  let found = false;
  await visitSourceCandidates({ ...params, visit: rows => { found = rows.length > 0; return !found; } }, true);
  return found;
}
