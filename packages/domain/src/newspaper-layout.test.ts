import { describe, expect, it } from "vitest";
import { computeNewspaperLayout } from "./newspaper-layout";

describe("computeNewspaperLayout", () => {
  it("omits empty sections by default", () => {
    const layout = computeNewspaperLayout([
      { id: "featuredKnowledge", priority: 1, itemCount: 0 },
      { id: "meetings", priority: 2, itemCount: 0 },
    ]);

    expect(layout.variant).toBe("empty");
    expect(layout.visibleSections).toEqual([]);
  });

  it("keeps explicit empty sections visible when requested", () => {
    const layout = computeNewspaperLayout([
      { id: "featuredKnowledge", priority: 1, itemCount: 0, emptyPolicy: "show" },
    ]);

    expect(layout.variant).toBe("sparse");
    expect(layout.visibleSections.map((section) => section.id)).toEqual(["featuredKnowledge"]);
  });

  it("uses sparse layout for one or two visible sections in priority order", () => {
    const layout = computeNewspaperLayout([
      { id: "featuredKnowledge", priority: 1, itemCount: 2 },
      { id: "todos", priority: 2, itemCount: 1 },
      { id: "activity", priority: 3, itemCount: 0 },
    ]);

    expect(layout.variant).toBe("sparse");
    expect(layout.visibleSections.map((section) => section.id)).toEqual(["featuredKnowledge", "todos"]);
    expect(layout.sectionCaps.featuredKnowledge).toEqual(expect.objectContaining({
      itemCap: 2,
      placement: "lead",
    }));
  });

  it("sorts visible sections by priority with source order as a tiebreaker", () => {
    const layout = computeNewspaperLayout([
      { id: "todos", priority: 2, itemCount: 1 },
      { id: "activity", priority: 3, itemCount: 1 },
      { id: "featuredKnowledge", priority: 1, itemCount: 1 },
      { id: "meetings", priority: 3, itemCount: 1 },
    ]);

    expect(layout.visibleSections.map((section) => section.id)).toEqual([
      "featuredKnowledge",
      "todos",
      "activity",
      "meetings",
    ]);
  });

  it("keeps meeting-only dashboards sparse instead of creating empty rails", () => {
    const layout = computeNewspaperLayout([
      { id: "meetings", priority: 1, itemCount: 5 },
    ]);

    expect(layout.variant).toBe("sparse");
    expect(layout.sectionCaps.meetings).toEqual(expect.objectContaining({
      itemCap: 3,
      placement: "lead",
    }));
  });

  it("uses balanced layout for several non-meeting-heavy sections", () => {
    const layout = computeNewspaperLayout([
      { id: "featuredKnowledge", priority: 1, itemCount: 4 },
      { id: "meetings", priority: 2, itemCount: 2 },
      { id: "todos", priority: 3, itemCount: 6 },
    ]);

    expect(layout.variant).toBe("balanced");
    expect(layout.visibleSections.map((section) => section.id)).toEqual(["featuredKnowledge", "meetings", "todos"]);
    expect(layout.sectionCaps.meetings).toEqual(expect.objectContaining({
      itemCap: 2,
      placement: "standard",
    }));
  });

  it("supports the unified dashboard knowledge feed and work rail sections", () => {
    const layout = computeNewspaperLayout([
      { id: "knowledgeFeed", priority: 1, itemCount: 8 },
      { id: "proposals", priority: 2, itemCount: 7 },
      { id: "actionItems", priority: 3, itemCount: 9 },
      { id: "tensions", priority: 4, itemCount: 5 },
    ]);

    expect(layout.variant).toBe("balanced");
    expect(layout.visibleSections.map((section) => section.id)).toEqual([
      "knowledgeFeed",
      "proposals",
      "actionItems",
      "tensions",
    ]);
    expect(layout.sectionCaps.knowledgeFeed).toEqual(expect.objectContaining({
      itemCap: 6,
      excerptMaxLength: 220,
      placement: "standard",
    }));
    expect(layout.sectionCaps.proposals.itemCap).toBe(5);
    expect(layout.sectionCaps.actionItems.itemCap).toBe(6);
  });

  it("allocates wider placement and larger caps to meeting-heavy layouts", () => {
    const layout = computeNewspaperLayout([
      { id: "featuredKnowledge", priority: 1, itemCount: 3 },
      { id: "meetings", priority: 2, itemCount: 8 },
      { id: "todos", priority: 3, itemCount: 6 },
      { id: "activity", priority: 4, itemCount: 5 },
    ]);

    expect(layout.variant).toBe("meeting-heavy");
    expect(layout.visibleSections.map((section) => section.id)).toEqual(["featuredKnowledge", "meetings", "todos", "activity"]);
    expect(layout.sectionCaps.meetings).toEqual(expect.objectContaining({
      itemCap: 5,
      placement: "wide",
      excerptMaxLength: 180,
    }));
    expect(layout.sectionCaps.todos.itemCap).toBe(4);
  });

  it("treats meetingBriefs as a meeting-heavy newspaper section", () => {
    const layout = computeNewspaperLayout([
      { id: "meetingBriefs", priority: 1, itemCount: 5, surface: "email" },
      { id: "openActions", priority: 2, itemCount: 4, surface: "email" },
      { id: "goalsProgress", priority: 3, itemCount: 2, surface: "email" },
    ]);

    expect(layout.variant).toBe("meeting-heavy");
    expect(layout.sectionCaps.meetingBriefs).toEqual(expect.objectContaining({
      itemCap: 5,
      placement: "wide",
    }));
  });
});
