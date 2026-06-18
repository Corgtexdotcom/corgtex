import { describe, expect, it } from "vitest";
import {
  buildWorkItemQuery,
  compareWorkItemSortValues,
  normalizeDateOnly,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemSort,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  toggleWorkItemColumnVisibility,
} from "./work-item-view";

describe("work item view helpers", () => {
  it("normalizes view, sort, and date query values", () => {
    expect(normalizeWorkItemView("kanban")).toBe("kanban");
    expect(normalizeWorkItemView("table")).toBe("table");
    expect(normalizeWorkItemView("grid")).toBe("list");
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
      columns: ["OPEN", "IN_PROGRESS"],
    })).toBe("?status=OPEN&view=kanban&sort=alpha&circleId=circle-1&memberId=mem-1&columns=OPEN%2CIN_PROGRESS");
    expect(buildWorkItemQuery({
      status: "OPEN",
      view: "table",
      sort: "date",
      circleId: "circle-1",
      memberId: "mem-1",
    })).toBe("?status=OPEN&view=table&sort=date&circleId=circle-1&memberId=mem-1");
  });

  it("normalizes kanban column visibility from query values", () => {
    const columns = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const;

    expect(normalizeVisibleWorkItemColumns(undefined, columns)).toEqual(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"]);
    expect(normalizeVisibleWorkItemColumns("OPEN,UNKNOWN,OPEN,COMPLETED", columns)).toEqual(["OPEN", "COMPLETED"]);
    expect(normalizeVisibleWorkItemColumns("UNKNOWN", columns)).toEqual(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"]);
  });

  it("toggles kanban columns while keeping at least one route back to all columns", () => {
    const columns = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"] as const;

    expect(toggleWorkItemColumnVisibility(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"], "OPEN", columns))
      .toEqual(["DRAFT", "IN_PROGRESS", "COMPLETED"]);
    expect(toggleWorkItemColumnVisibility(["DRAFT", "COMPLETED"], "OPEN", columns))
      .toEqual(["DRAFT", "OPEN", "COMPLETED"]);
    expect(toggleWorkItemColumnVisibility(["OPEN"], "OPEN", columns)).toBeUndefined();
    expect(toggleWorkItemColumnVisibility(["DRAFT", "OPEN", "IN_PROGRESS"], "COMPLETED", columns)).toBeUndefined();
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
