import { describe, expect, it } from "vitest";
import {
  normalizeTensionStatusFilter,
  normalizeTensionStatusFilters,
  resolveTensionDateFilters,
  resolveTensionSearch,
  resolveTensionStatusSearch,
} from "./view-model";

describe("tensions view model", () => {
  it("normalizes status search params", () => {
    expect(normalizeTensionStatusFilter("RESOLVED")).toBe("RESOLVED");
    expect(normalizeTensionStatusFilter("INVALID")).toBe("OPEN");
  });

  it("defaults list and table status filters to open", () => {
    expect(normalizeTensionStatusFilters(undefined)).toEqual(["OPEN"]);
    expect(normalizeTensionStatusFilters("INVALID")).toEqual(["OPEN"]);
    expect(resolveTensionStatusSearch(undefined)).toEqual({
      statusFilter: "OPEN",
      statusFilters: ["OPEN"],
      statusQuery: ["OPEN"],
    });
  });

  it("preserves explicit all status selection", () => {
    expect(resolveTensionStatusSearch("ALL")).toEqual({
      statusFilter: "ALL",
      statusFilters: [],
      statusQuery: "ALL",
    });
    expect(resolveTensionStatusSearch(["DRAFT", "OPEN", "RESOLVED"])).toEqual({
      statusFilter: "ALL",
      statusFilters: [],
      statusQuery: "ALL",
    });
  });

  it("allows kanban callers to keep a no-status all-columns state", () => {
    expect(resolveTensionStatusSearch(undefined, null)).toEqual({
      statusFilter: "OPEN",
      statusFilters: [],
      statusQuery: undefined,
    });
  });

  it("normalizes lifecycle date filters when resolving search", () => {
    const result = resolveTensionSearch({
      status: "ALL",
      openedFrom: "2026-06-01",
      openedTo: "invalid",
      closedFrom: "2026-06-31",
      closedTo: "2026-06-04",
    });

    expect(result.statusFilter).toBe("ALL");
    expect(result.dateFilters).toEqual({
      openedFrom: "2026-06-01",
      openedTo: undefined,
      closedFrom: undefined,
      closedTo: "2026-06-04",
    });
  });

  it("ignores invalid lifecycle date filters", () => {
    expect(resolveTensionDateFilters({
      openedFrom: "2026-02-30",
      openedTo: ["2026-06-02", "2026-06-03"],
      closedFrom: "not-a-date",
      closedTo: "2026-06-04",
    })).toEqual({
      openedFrom: undefined,
      openedTo: "2026-06-02",
      closedFrom: undefined,
      closedTo: "2026-06-04",
    });
  });
});
