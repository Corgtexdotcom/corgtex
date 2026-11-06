import { beforeEach, expect, it, vi } from "vitest";
import { decodeDirectoryCursor, encodeDirectoryCursor } from "./directory-cursor";
beforeEach(() => vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64)));
it("encrypts denied boundary identities and authenticates workspace/kind/order", () => {
  const expected = { workspaceId: "synthetic", kind: "Meeting", ascending: false };
  const cursor = encodeDirectoryCursor({ ...expected, id: "private-denied-boundary", date: "2026-10-01T00:00:00.000Z" });
  expect(cursor).not.toContain("private-denied-boundary");
  expect(decodeDirectoryCursor(cursor, expected)).toEqual({ id: "private-denied-boundary", date: new Date("2026-10-01") });
  for (const target of [{ ...expected, workspaceId: "other" }, { ...expected, kind: "Document" }, { ...expected, ascending: true }]) {
    expect(() => decodeDirectoryCursor(cursor, target)).toThrow();
  }
  expect(() => decodeDirectoryCursor(cursor.slice(0, -1), expected)).toThrow();
});
