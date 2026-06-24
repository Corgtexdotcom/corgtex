import { describe, expect, it } from "vitest";
import {
  normalizeTensionStatusFilter,
  normalizeTensionStatusFilters,
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

  it("ignores removed date filters when resolving search", () => {
    const result = resolveTensionSearch({
      status: "ALL",
      openedFrom: "2026-06-01",
      closedTo: "2026-06-04",
    });

    expect(result.statusFilter).toBe("ALL");
    expect(result).not.toHaveProperty("dateFilters");
  });
});
