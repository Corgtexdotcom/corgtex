import { describe, expect, it } from "vitest";
import { parseReviewListQuery, reviewItemHref, reviewListHref, reviewListQuery, reviewNeighbors } from "./review-list-navigation";

describe("review list navigation", () => {
  it("retains selected filters and returns to the same list", () => {
    const query = reviewListQuery({ status: ["OPEN", "RESOLVED"], view: "table", sort: "alpha", memberId: ["a", "b"] }, "proposals");
    const itemHref = reviewItemHref("/workspaces/w/proposals/p", query);
    const encoded = new URL(itemHref, "https://example.com").searchParams.get("review");
    expect(parseReviewListQuery(encoded ?? undefined, "proposals")).toEqual({
      search: { status: ["OPEN", "RESOLVED"], view: "table", sort: "alpha", memberId: ["a", "b"] },
      query,
    });
    expect(reviewListHref("/workspaces/w/proposals", query)).toBe(`/workspaces/w/proposals?${query}`);
  });

  it("drops unrelated parameters and navigates only within the visible sequence", () => {
    expect(parseReviewListQuery("status=OPEN&redirect=https%3A%2F%2Fevil.test&openedFrom=2026-08-01", "proposals").query).toBe("status=OPEN");
    expect(reviewNeighbors(["a", "b", "c"], "b")).toEqual({ previousId: "a", nextId: "c" });
    expect(reviewNeighbors(["a", "b"], "absent")).toEqual({ previousId: null, nextId: null });
  });
});
