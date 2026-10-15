import { captureReadableDigestInputs, DigestReadRelease, invariant } from "@corgtex/domain";

type ReadableArguments = Parameters<DigestReadRelease["capture"]>;
export const READABLE_ARTIFACT_PAGE_SIZE = 100;

type ReadReleaseOptions = {
  actor: DigestReadRelease["actor"];
  workspaceId: string;
  kind: ReadableArguments[0];
  /** Share across every family contributing to one response, then finish once.
   * visit receives provisional rows: callers must not publish before finish. */
  release?: DigestReadRelease;
};

/** Retain compact original proofs while callers keep only display projections or
 * scalar totals. Hidden rows never consume a slot; stale observations fail closed. */
export async function scanReadableArtifactPages<T extends { id: string }>(options: ReadReleaseOptions & {
  loadPage: (cursor: string | undefined, take: number) => Promise<T[]>;
  visit: (row: T) => void;
}) {
  const release = options.release ?? new DigestReadRelease(options.actor, options.workspaceId);
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    invariant(rows.length <= READABLE_ARTIFACT_PAGE_SIZE, 409, "SOURCE_CHANGED", "Source page exceeded its bound.");
    let previous = cursor;
    for (const row of rows) {
      invariant(previous === undefined || row.id > previous, 409, "SOURCE_CHANGED", "Source scan changed during pagination.");
      previous = row.id;
    }
    const captured = await release.capture(options.kind, rows);
    for (const row of captured.records) {
      count++;
      options.visit(row);
    }
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) break;
    cursor = previous;
  }
  return options.release ? count : release.finish(count);
}

/** Replenish a newest-first slot and bind its original canonical row to the same
 * final release as any other response families. */
export async function findLatestReadableArtifact<T extends { id: string; generatedAt: Date }>(options: ReadReleaseOptions & {
  loadPage: (cursor: { id: string; generatedAt: Date } | undefined, take: number) => Promise<T[]>;
}): Promise<T | null> {
  const release = options.release ?? new DigestReadRelease(options.actor, options.workspaceId);
  let cursor: { id: string; generatedAt: Date } | undefined;
  let selected: T | null = null;
  for (;;) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    invariant(rows.length <= READABLE_ARTIFACT_PAGE_SIZE, 409, "SOURCE_CHANGED", "Source page exceeded its bound.");
    let previous = cursor;
    for (const row of rows) {
      invariant(!previous || row.generatedAt < previous.generatedAt
        || (row.generatedAt.getTime() === previous.generatedAt.getTime() && row.id < previous.id),
      409, "SOURCE_CHANGED", "Source sample changed during pagination.");
      previous = row;
    }
    const captured = await release.observeRead(() => captureReadableDigestInputs({
      actor: options.actor, workspaceId: options.workspaceId, kind: options.kind, records: rows,
    }));
    selected = captured.records[0] ?? null;
    if (selected) {
      release.add(captured.proofs.get(selected.id)!);
      break;
    }
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) break;
    cursor = previous;
  }
  return options.release ? selected : release.finish(selected);
}
