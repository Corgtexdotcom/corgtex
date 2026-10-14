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
