import { describe, expect, it } from "vitest";
import { rankPersonalNewspaperItems, type PersonalNewspaperItem } from "./newspaper-priority";

const now = new Date("2026-09-29T12:00:00.000Z");

function item(id: string, values: Partial<PersonalNewspaperItem> = {}): PersonalNewspaperItem {
  return {
    id,
    kind: "ACTION",
    title: id,
    href: `/actions/${id}`,
    status: "OPEN",
    priority: 0,
    dueAt: null,
    updatedAt: now,
    ...values,
  };
}

describe("personal newspaper priority", () => {
  it("puts overdue and imminent items ahead of undated high priority items", () => {
    const items = [
      item("undated", { priority: 5 }),
      item("soon", { dueAt: new Date("2026-09-30T12:00:00.000Z") }),
      item("overdue", { dueAt: new Date("2026-09-28T12:00:00.000Z") }),
    ];

    expect(rankPersonalNewspaperItems(items, now).map((entry) => entry.id)).toEqual([
      "overdue", "soon", "undated",
    ]);
    expect(items.map((entry) => entry.id)).toEqual(["undated", "soon", "overdue"]);
  });

  it("uses priority, due date, and stable id order within an urgency band", () => {
    const items = [
      item("z", { priority: 2 }),
      item("a", { priority: 2 }),
      item("high", { priority: 3 }),
    ];

    expect(rankPersonalNewspaperItems(items, now).map((entry) => entry.id)).toEqual([
      "high", "a", "z",
    ]);
  });
});
