import { invariant } from "./errors";

/** One compact identity/date inventory, followed by bounded canonical admission.
 * Projections are output only: never pass them to fingerprint/proof readers. */
export async function collectProjectedDirectory<C extends { id: string }, R extends C, T>(params: {
  candidates: C[];
  load: (page: C[]) => Promise<R[]>;
  admit: (rows: R[]) => Promise<R[]>;
  project: (row: R) => T;
}): Promise<T[]> {
  invariant(params.candidates.length <= 10_000, 409, "SOURCE_READ_SCAN_LIMIT",
    "Directory exceeds the 10000-candidate exact-read limit; narrow the request.");
  let previous: string | undefined;
  for (const row of params.candidates) {
    invariant(previous === undefined || row.id > previous, 409, "SOURCE_CHANGED", "Directory inventory changed; retry the request.");
    previous = row.id;
  }
  const output: T[] = [];
  for (let offset = 0; offset < params.candidates.length; offset += 100) {
    const page = params.candidates.slice(offset, offset + 100);
    const rows = await params.load(page);
    const byId = new Map(rows.map(row => [row.id, row]));
    invariant(rows.length === page.length && byId.size === page.length && page.every(candidate => {
      const row = byId.get(candidate.id);
      return row && Object.entries(candidate as Record<string, unknown>).every(([key, value]) => {
        const actual: unknown = (row as Record<string, unknown>)[key];
        return value instanceof Date ? actual instanceof Date && value.getTime() === actual.getTime() : value === actual;
      });
    }), 409, "SOURCE_CHANGED", "Directory inputs changed during collection; retry the request.");
    output.push(...(await params.admit(page.map(row => byId.get(row.id)!))).map(params.project));
  }
  return output;
}
