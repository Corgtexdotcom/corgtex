import type { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { captureArtifactInputProof, readableArtifactIds, type LineageInput } from "./source-lineage";

import { admitCrmDirectOriginalRows, assertCrmDirectReadCurrent, trackCrmDirectOrdinaryRows, type CrmDirectReadSession } from "./crm-direct-original-read";

export type CrmReadPage = { take: number; cursor?: { id: string }; skip?: number };
const CRM_READ_BATCH_SIZE = 100;
const CRM_READ_SCAN_BUDGET = 5_000;

/** Read current SQL receipts before pagination, counts or related-record selection. */
export async function readCrmRows<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageInput["kind"], fetch: (page: CrmReadPage) => Promise<T[]>, tx: Prisma.TransactionClient = prisma, direct?: CrmDirectReadSession) {
  const admitted: T[] = [];
  const seen = new Set<string>();
  let cursor: { id: string } | undefined;
  let scanned = 0;
  while (scanned < CRM_READ_SCAN_BUDGET) {
    const take = Math.min(CRM_READ_BATCH_SIZE, CRM_READ_SCAN_BUDGET - scanned);
    const rows = await fetch({ take, ...(cursor ? { cursor, skip: 1 } : {}) });
    invariant(rows.length <= take, 409, "SOURCE_CHANGED", "CRM query returned an invalid page.");
    scanned += rows.length;
    const fresh = rows.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    const originals = direct ? await admitCrmDirectOriginalRows(direct, kind, fresh, tx) : [];
    const originalIds = new Set(originals.map(row => row.id));
    const rest = fresh.filter(row => !originalIds.has(row.id));
    const readable = await readableArtifactIds(actor, workspaceId, kind, rest, tx);
    const ordinary = rest.filter(row => readable.has(row.id));
    if (direct && ordinary.length) await trackCrmDirectOrdinaryRows(direct, kind, ordinary, await captureArtifactInputProof(actor, workspaceId,
      ordinary.map(row => ({kind, id: row.id, snapshot: row as Record<string, unknown>})), tx), tx);
    const admittedById = new Map([...ordinary, ...originals].map(row => [row.id, row]));
    admitted.push(...fresh.flatMap(row => admittedById.has(row.id) ? [admittedById.get(row.id)!] : []));
    if (rows.length < take) {
      if (direct) {
        await assertCrmDirectReadCurrent(direct, tx);
      }
      return admitted;
    }
    const next = rows.at(-1)!;
    invariant(next.id !== cursor?.id && fresh.length > 0, 409, "SOURCE_CHANGED", "CRM records changed while reading.");
    cursor = { id: next.id };
  }
  // A complete collection may end exactly at the budget. Probe only the next
  // identity; do not admit or count an over-budget row as a partial result.
  const more = await fetch({take: 1, ...(cursor ? {cursor, skip: 1} : {})});
  invariant(more.length === 0, 413, "CRM_READ_BUDGET", "This CRM query is too broad. Narrow its filters and try again.");
  if (direct) await assertCrmDirectReadCurrent(direct, tx);
  return admitted;
}

export function crmPage<T>(rows: T[], take: number, skip: number) {
  invariant(Number.isInteger(take) && take >= 0 && take <= CRM_READ_SCAN_BUDGET && Number.isInteger(skip) && skip >= 0,
    400, "INVALID_INPUT", "CRM pagination is invalid.");
  return { items: rows.slice(skip, skip + take), total: rows.length, take, skip };
}
