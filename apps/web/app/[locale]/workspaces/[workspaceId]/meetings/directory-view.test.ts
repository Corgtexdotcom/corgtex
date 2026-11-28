import { expect, it } from "vitest";
import { pageMeetingRows } from "./directory-view";

it("pages tied dates deterministically and clamps invalid or out-of-range pages", () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: String(44 - i).padStart(2, "0"), recordedAt: new Date("2026-10-01") }));
  const first = pageMeetingRows(rows, undefined);
  const second = pageMeetingRows(rows, "2");
  expect(first.items.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i).padStart(2, "0")));
  expect(second.items.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 20).padStart(2, "0")));
  expect(first.total).toBe(45);
  expect(pageMeetingRows(rows, "999")).toMatchObject({ page: 3, pageCount: 3, total: 45 });
  for (const value of ["-1", "0", "1.5", "wat"]) expect(pageMeetingRows(rows, value).page).toBe(1);
  expect(pageMeetingRows([], "2")).toMatchObject({ items: [], page: 1, pageCount: 1, total: 0 });
});
