import { captureReadableDigestInputs, DigestReadRelease, invariant } from "@corgtex/domain";

type ReadableArguments = Parameters<DigestReadRelease["capture"]>;
export const READABLE_ARTIFACT_PAGE_SIZE = 100;
export const READABLE_ARTIFACT_SCAN_LIMIT = 200;
export type ReadableArtifactWindow = { count: number; complete: boolean; nextCursor: string | null };

type ReadReleaseOptions = {
  actor: DigestReadRelease["actor"];
  workspaceId: string;
  kind: ReadableArguments[0];
  /** Share across every family contributing to one response, then finish once.
   * visit receives provisional rows: callers must not publish before finish. */
  release?: DigestReadRelease;
};

/** Retain compact original proofs while callers keep only display projections or
 * scalar totals. Each request examines at most 200 canonical rows, including
 * hidden rows. Continuation counts describe their window, not a global total. */
export async function scanReadableArtifactPages<T extends { id: string }>(options: ReadReleaseOptions & {
  loadPage: (cursor: string | undefined, take: number) => Promise<T[]>;
  visit: (row: T) => void;
  cursor?: string;
}): Promise<ReadableArtifactWindow> {
  const release = options.release ?? new DigestReadRelease(options.actor, options.workspaceId);
  let cursor = options.cursor;
  let count = 0;
  let examined = 0;
  let complete = false;
  while (examined < READABLE_ARTIFACT_SCAN_LIMIT) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    invariant(rows.length <= READABLE_ARTIFACT_PAGE_SIZE, 409, "SOURCE_CHANGED", "Source page exceeded its bound.");
    let previous = cursor;
    for (const row of rows) {
      invariant(previous === undefined || row.id > previous, 409, "SOURCE_CHANGED", "Source scan changed during pagination.");
      previous = row.id;
    }
    examined += rows.length;
    const captured = await release.capture(options.kind, rows);
    for (const row of captured.records) {
      count++;
      options.visit(row);
    }
    cursor = previous;
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) { complete = true; break; }
  }
  const window = { count, complete, nextCursor: complete ? null : cursor! };
  return options.release ? window : release.finish(window);
}

/** Replenish a newest-first slot and bind its original canonical row to the same
 * final release as any other response families. */
export async function findLatestReadableArtifact<T extends { id: string; generatedAt: Date }>(options: ReadReleaseOptions & {
  loadPage: (cursor: { id: string; generatedAt: Date } | undefined, take: number) => Promise<T[]>;
}): Promise<{ item: T | null; complete: boolean }> {
  const release = options.release ?? new DigestReadRelease(options.actor, options.workspaceId);
  let cursor: { id: string; generatedAt: Date } | undefined;
  let selected: T | null = null;
  let examined = 0;
  let complete = false;
  while (examined < READABLE_ARTIFACT_SCAN_LIMIT) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    invariant(rows.length <= READABLE_ARTIFACT_PAGE_SIZE, 409, "SOURCE_CHANGED", "Source page exceeded its bound.");
    let previous = cursor;
    for (const row of rows) {
      invariant(!previous || row.generatedAt < previous.generatedAt
        || (row.generatedAt.getTime() === previous.generatedAt.getTime() && row.id < previous.id),
      409, "SOURCE_CHANGED", "Source sample changed during pagination.");
      previous = row;
    }
    examined += rows.length;
    const captured = await release.observeRead(() => captureReadableDigestInputs({
      actor: options.actor, workspaceId: options.workspaceId, kind: options.kind, records: rows,
    }));
    selected = captured.records[0] ?? null;
    if (selected) {
      release.add(captured.proofs.get(selected.id)!);
      complete = true;
      break;
    }
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) { complete = true; break; }
    cursor = previous;
  }
  const result = { item: selected, complete };
  return options.release ? result : release.finish(result);
}
