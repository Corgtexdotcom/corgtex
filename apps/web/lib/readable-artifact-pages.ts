import { readableArtifactIds } from "@corgtex/domain";

type ReadableArguments = Parameters<typeof readableArtifactIds>;
export const READABLE_ARTIFACT_PAGE_SIZE = 100;

/** Load complete canonical rows for permission checks, release each page before
 * fetching the next, and let callers retain only their small display projection.
 * Hidden rows never consume a result slot or contribute to a visible count. */
export async function scanReadableArtifactPages<T extends { id: string }>(options: {
  actor: ReadableArguments[0];
  workspaceId: string;
  kind: ReadableArguments[2];
  loadPage: (cursor: string | undefined, take: number) => Promise<T[]>;
  visit: (row: T) => void;
}) {
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    if (!rows.length) return count;
    const visible = await readableArtifactIds(options.actor, options.workspaceId, options.kind, rows);
    for (const row of rows) if (visible.has(row.id)) {
      count++;
      options.visit(row);
    }
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) return count;
    cursor = rows[rows.length - 1].id;
  }
}

/** Replenish a newest-first slot without retaining denied pages or returning a
 * stale projection different from the canonical row that was authorized. */
export async function findLatestReadableArtifact<T extends { id: string; generatedAt: Date }>(options: {
  actor: ReadableArguments[0];
  workspaceId: string;
  kind: ReadableArguments[2];
  loadPage: (cursor: { id: string; generatedAt: Date } | undefined, take: number) => Promise<T[]>;
}): Promise<T | null> {
  let cursor: { id: string; generatedAt: Date } | undefined;
  for (;;) {
    const rows = await options.loadPage(cursor, READABLE_ARTIFACT_PAGE_SIZE);
    if (!rows.length) return null;
    const visible = await readableArtifactIds(options.actor, options.workspaceId, options.kind, rows);
    const admitted = rows.find((row) => visible.has(row.id));
    if (admitted) return admitted;
    if (rows.length < READABLE_ARTIFACT_PAGE_SIZE) return null;
    const last = rows[rows.length - 1];
    cursor = { id: last.id, generatedAt: last.generatedAt };
  }
}
