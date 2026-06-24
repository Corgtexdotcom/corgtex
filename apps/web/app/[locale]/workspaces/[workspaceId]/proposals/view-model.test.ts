import { describe, expect, it } from "vitest";
import { resolveProposalStatusSearch } from "./view-model";

describe("proposals view model", () => {
  it("defaults list and table status filters to open", () => {
    expect(resolveProposalStatusSearch(undefined)).toEqual({
      statusFilters: ["OPEN"],
      statusQuery: ["OPEN"],
    });
    expect(resolveProposalStatusSearch("INVALID")).toEqual({
      statusFilters: ["OPEN"],
      statusQuery: ["OPEN"],
    });
  });

  it("preserves explicit all status selection", () => {
    expect(resolveProposalStatusSearch("ALL")).toEqual({
      statusFilters: [],
      statusQuery: "ALL",
    });
    expect(resolveProposalStatusSearch(["DRAFT", "OPEN", "RESOLVED", "ARCHIVED"])).toEqual({
      statusFilters: [],
      statusQuery: "ALL",
    });
  });

  it("allows kanban callers to keep a no-status all-columns state", () => {
    expect(resolveProposalStatusSearch(undefined, null)).toEqual({
      statusFilters: [],
      statusQuery: undefined,
    });
  });
});
