import { describe, expect, it } from "vitest";
import {
  buildTensionQuery,
  normalizeDateOnly,
  normalizeTensionStatusFilter,
  resolveTensionSearch,
} from "./view-model";

describe("tensions view model", () => {
  it("normalizes status and date-only search params", () => {
    expect(normalizeTensionStatusFilter("RESOLVED")).toBe("RESOLVED");
    expect(normalizeTensionStatusFilter("INVALID")).toBe("OPEN");
    expect(normalizeDateOnly("2026-06-05")).toBe("2026-06-05");
    expect(normalizeDateOnly("2026-02-31")).toBeUndefined();
    expect(normalizeDateOnly("2026-06-05T00:00:00.000Z")).toBeUndefined();
  });

  it("resolves date filters to inclusive UTC day boundaries", () => {
    const result = resolveTensionSearch({
      status: "ALL",
      openedFrom: "2026-06-01",
      openedTo: "2026-06-02",
      closedFrom: "2026-06-03",
      closedTo: "2026-06-04",
    });

    expect(result.statusFilter).toBe("ALL");
    expect(result.dateFilters.openedFrom?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(result.dateFilters.openedTo?.toISOString()).toBe("2026-06-02T23:59:59.999Z");
    expect(result.dateFilters.closedFrom?.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    expect(result.dateFilters.closedTo?.toISOString()).toBe("2026-06-04T23:59:59.999Z");
  });

  it("preserves date filters when building status links", () => {
    expect(buildTensionQuery({
      status: "RESOLVED",
      dateValues: {
        openedFrom: "2026-06-01",
        closedTo: "2026-06-04",
      },
    })).toBe("?status=RESOLVED&openedFrom=2026-06-01&closedTo=2026-06-04");
  });
});
