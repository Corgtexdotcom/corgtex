import { decryptSecret, encryptSecret } from "@corgtex/shared";
import { invariant } from "./errors";

type DirectoryPosition = { id: string; date: string; workspaceId: string; kind: string; ascending: boolean };

/** A scan can end on a denied record. Encrypt positions so continuation never
 * publishes that record's identity or timestamp. Cursor is no read authority. */
export function encodeDirectoryCursor(position: DirectoryPosition) {
  return encryptSecret(JSON.stringify(position));
}
export function decodeDirectoryCursor(cursor: string | undefined, expected: Pick<DirectoryPosition, "workspaceId" | "kind" | "ascending">) {
  if (!cursor) return null;
  let value: DirectoryPosition | null = null;
  try {
    if (cursor.length <= 4096) value = JSON.parse(decryptSecret(cursor));
  } catch { /* invalid or tampered position */ }
  invariant(value && value.workspaceId === expected.workspaceId && value.kind === expected.kind && value.ascending === expected.ascending
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256
    && typeof value.date === "string" && Number.isFinite(new Date(value.date).getTime()),
  400, "INVALID_INPUT", "Directory position is invalid; return to the first window.");
  return { id: value.id, date: new Date(value.date) };
}
