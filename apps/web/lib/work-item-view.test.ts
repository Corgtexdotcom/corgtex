import { describe, expect, it } from "vitest";
import {
  buildWorkItemQuery,
  compareWorkItemSortValues,
  normalizeDateOnly,
  normalizeWorkItemSort,
  normalizeWorkItemView,
  resolveWorkItemFilters,
} from "./work-item-view";

describe("work item view helpers", () => {
  it("normalizes view, sort, and date query values", () => {
    expect(normalizeWorkItemView("kanban")).toBe("kanban");
    expect(normalizeWorkItemView("table")).toBe("list");
    expect(normalizeWorkItemSort("date")).toBe("date");
    expect(normalizeWorkItemSort("alpha")).toBe("alpha");
    expect(normalizeWorkItemSort("invalid")).toBe("priority");
    expect(normalizeDateOnly("2026-06-10")).toBe("2026-06-10");
    expect(normalizeDateOnly("2026-06-31")).toBeUndefined();
  });

  it("keeps filters in generated query links", () => {
    expect(buildWorkItemQuery({
      status: "OPEN",
      view: "kanban",
      sort: "alpha",
      circleId: "circle-1",
      memberId: "mem-1",
    })).toBe("?status=OPEN&view=kanban&sort=alpha&circleId=circle-1&memberId=mem-1");
  });

  it("applies circle and member ids independently", () => {
    expect(resolveWorkItemFilters({
      circleId: "circle-1",
      memberId: "mem-1",
      sort: "date",
    })).toEqual({
      circleId: "circle-1",
      memberId: "mem-1",
      sort: "date",
    });
  });

  it("sorts work item values by priority, date, or title", () => {
    const items = [
      { priority: 1, date: new Date("2026-06-10T12:00:00.000Z"), alpha: "Beta" },
      { priority: 3, date: new Date("2026-06-08T12:00:00.000Z"), alpha: "Charlie" },
      { priority: 3, date: new Date("2026-06-11T12:00:00.000Z"), alpha: "Alpha" },
    ];

    expect([...items].sort((left, right) => compareWorkItemSortValues(left, right, "priority")).map((item) => item.alpha))
      .toEqual(["Alpha", "Charlie", "Beta"]);
    expect([...items].sort((left, right) => compareWorkItemSortValues(left, right, "date")).map((item) => item.alpha))
      .toEqual(["Alpha", "Beta", "Charlie"]);
    expect([...items].sort((left, right) => compareWorkItemSortValues(left, right, "alpha")).map((item) => item.alpha))
      .toEqual(["Alpha", "Beta", "Charlie"]);
  });
});
