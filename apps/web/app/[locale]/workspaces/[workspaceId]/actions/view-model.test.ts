import { describe, expect, it } from "vitest";
import {
  ACTION_STATUS_META,
  actionMatchesStatusFilter,
  groupActionsByStatus,
  normalizeActionStatusFilter,
} from "./view-model";

describe("actions view model", () => {
  it("normalizes status filters and falls back to open", () => {
    expect(normalizeActionStatusFilter("DRAFT")).toBe("DRAFT");
    expect(normalizeActionStatusFilter("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(normalizeActionStatusFilter(["COMPLETED", "DRAFT"])).toBe("COMPLETED");
    expect(normalizeActionStatusFilter("INVALID")).toBe("OPEN");
    expect(normalizeActionStatusFilter(undefined)).toBe("OPEN");
  });

  it("keeps private drafts visible in the draft tab", () => {
    expect(actionMatchesStatusFilter({ status: "DRAFT", isPrivate: true }, "DRAFT")).toBe(true);
    expect(actionMatchesStatusFilter({ status: "DRAFT", isPrivate: false }, "DRAFT")).toBe(true);
  });

  it("excludes private non-drafts from public status tabs", () => {
    expect(actionMatchesStatusFilter({ status: "OPEN", isPrivate: true }, "OPEN")).toBe(false);
    expect(actionMatchesStatusFilter({ status: "IN_PROGRESS", isPrivate: true }, "IN_PROGRESS")).toBe(false);
    expect(actionMatchesStatusFilter({ status: "COMPLETED", isPrivate: true }, "COMPLETED")).toBe(false);
  });

  it("groups action counts by normalized tab behavior", () => {
    const grouped = groupActionsByStatus([
      { id: "draft-private", status: "DRAFT", isPrivate: true },
      { id: "open-public", status: "OPEN", isPrivate: false },
      { id: "open-private", status: "OPEN", isPrivate: true },
      { id: "done-public", status: "COMPLETED", isPrivate: false },
    ]);

    expect(grouped.DRAFT.map((action) => action.id)).toEqual(["draft-private"]);
    expect(grouped.OPEN.map((action) => action.id)).toEqual(["open-public"]);
    expect(grouped.COMPLETED.map((action) => action.id)).toEqual(["done-public"]);
    expect(grouped.ALL).toHaveLength(4);
  });

  it("defines explicit rendering metadata for the draft status", () => {
    expect(ACTION_STATUS_META.DRAFT).toEqual({
      labelKey: "statusDraft",
      tagClass: "info",
    });
  });
});
