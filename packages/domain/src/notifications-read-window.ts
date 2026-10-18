import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { DigestReadRelease, captureReadableDigestInputs } from "./digest-lineage";
import { sealArtifactInputActor } from "./source-lineage";
import { invariant } from "./errors";

const SCAN_LIMIT = 200;
const PAGE_SIZE = 100;
type Position = { id: string; createdAt: string };
function encodeCursor(position: Position, unreadOnly: boolean) {
  return Buffer.from(JSON.stringify({ v: 1, ...position, unreadOnly })).toString("base64url");
}
function decodeCursor(cursor: string | undefined, unreadOnly: boolean): Position | undefined {
  if (!cursor) return;
  invariant(cursor.length <= 2048, 400, "INVALID_INPUT", "Invalid notification continuation.");
  let value;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* checked below */ }
  invariant(value?.v === 1 && value.unreadOnly === unreadOnly && typeof value.id === "string" && value.id.length > 0
    && value.id.length <= 256 && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.createdAt).toISOString() === value.createdAt,
  400, "INVALID_INPUT", "Invalid notification continuation.");
  return { id: value.id, createdAt: value.createdAt };
}

/** One bounded permission-aware history window. Continuations identify the last
 * examined row, including hidden rows; they never grant access to another scope. */
export async function readNotificationPage(actor: AppActor, workspaceId: string, opts?: {
  unreadOnly?: boolean; take?: number; skip?: number; cursor?: string;
}) {
  const take = opts?.take ?? 30;
  const skip = opts?.skip ?? 0;
  invariant(Number.isSafeInteger(take) && take >= 0 && take <= 100 && Number.isSafeInteger(skip) && skip >= 0 && skip <= SCAN_LIMIT,
    400, "INVALID_INPUT", "Notification window is out of range.");
  const unreadOnly = Boolean(opts?.unreadOnly);
  let after = decodeCursor(opts?.cursor, unreadOnly);
  type Row = Awaited<ReturnType<typeof prisma.notification.findMany>>[number];
  const items: Row[] = [];
  if (actor.kind !== "user" || !take) return { items, nextCursor: null, hasMore: false, complete: true };
  sealArtifactInputActor(actor);
  await requireWorkspaceMembership({ actor, workspaceId });
  const release = new DigestReadRelease(actor, workspaceId);
  let examined = 0, skipped = 0, complete = false;
  while (examined < SCAN_LIMIT && items.length < take) {
    const batchSize = Math.min(PAGE_SIZE, SCAN_LIMIT - examined);
    const rows = await prisma.notification.findMany({ where: {
      workspaceId, userId: actor.user.id, ...(unreadOnly ? { readAt: null } : {}),
      ...(after ? { OR: [{ createdAt: { lt: new Date(after.createdAt) } },
        { createdAt: new Date(after.createdAt), id: { lt: after.id } }] } : {}),
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: batchSize });
    const captured = await release.observeRead(() => captureReadableDigestInputs({ actor, workspaceId, kind: "Notification", records: rows }));
    const admitted = new Set(captured.records.map(row => row.id));
    let consumed = 0;
    for (const row of rows) {
      const next = { id: row.id, createdAt: row.createdAt.toISOString() };
      invariant(!after || next.id !== after.id || next.createdAt !== after.createdAt,
        409, "SOURCE_CHANGED", "Notification continuation did not advance.");
      after = next;
      examined++; consumed++;
      if (!admitted.has(row.id)) continue;
      // Counted/skipped records also contribute to this exact result window.
      release.add(captured.proofs.get(row.id)!);
      if (skipped < skip) { skipped++; continue; }
      items.push(row);
      if (items.length === take) break;
    }
    if (consumed === rows.length && rows.length < batchSize) { complete = true; break; }
    if (!rows.length) { complete = true; break; }
  }
  const nextCursor = !complete && after ? encodeCursor(after, unreadOnly) : null;
  return release.finish({ items, nextCursor, hasMore: Boolean(nextCursor), complete });
}

/** Capped lower bound, never a fabricated exact zero or full-corpus count. */
export async function readUnreadNotificationSummary(actor: AppActor, workspaceId: string) {
  try {
    const page = await readNotificationPage(actor, workspaceId, { unreadOnly: true, take: 100 });
    return { count: page.items.length, complete: page.complete, available: true };
  } catch {
    return { count: 0, complete: false, available: false };
  }
}
