import { describe, expect, it } from "vitest";
import {
  buildWorkItemQuery,
  compareWorkItemSortValues,
  normalizeDateOnly,
  normalizeVisibleWorkItemColumns,
  normalizeWorkItemSort,
  normalizeWorkItemView,
  resolveWorkItemFilters,
  resolveWorkItemStatusValues,
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
    expect(buildWorkItemQuery({
      status: ["OPEN", "RESOLVED"],
      view: "table",
      sort: "date",
      circleIds: ["circle-1", "circle-2"],
      memberIds: ["mem-1", "mem-2"],
      dates: { openedFrom: "2026-06-01" },
    })).toBe("?status=OPEN&status=RESOLVED&view=table&sort=date&circleId=circle-1&circleId=circle-2&memberId=mem-1&memberId=mem-2&openedFrom=2026-06-01");
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
      circleId: ["circle-1", "circle-2", "circle-1", ""],
      memberId: ["mem-1", "mem-2", "mem-1"],
      sort: "date",
    })).toEqual({
      circleId: "circle-1",
      circleIds: ["circle-1", "circle-2"],
      memberId: "mem-1",
      memberIds: ["mem-1", "mem-2"],
      sort: "date",
    });
  });

  it("normalizes repeated status params and canonicalizes all-selected as no explicit filter", () => {
    const statuses = ["OPEN", "RESOLVED", "ARCHIVED"] as const;

    expect(resolveWorkItemStatusValues(["OPEN", "BAD", "RESOLVED", "OPEN"], statuses))
      .toEqual(["OPEN", "RESOLVED"]);
    expect(resolveWorkItemStatusValues(["OPEN", "RESOLVED", "ARCHIVED"], statuses))
      .toEqual([]);
    expect(resolveWorkItemStatusValues(undefined, statuses, "OPEN"))
      .toEqual(["OPEN"]);
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
