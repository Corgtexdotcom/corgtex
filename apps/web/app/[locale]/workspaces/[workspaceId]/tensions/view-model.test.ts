import { describe, expect, it } from "vitest";
import {
  normalizeTensionStatusFilter,
  resolveTensionSearch,
} from "./view-model";

describe("tensions view model", () => {
  it("normalizes status search params", () => {
    expect(normalizeTensionStatusFilter("RESOLVED")).toBe("RESOLVED");
    expect(normalizeTensionStatusFilter("INVALID")).toBe("OPEN");
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
