import { describe, expect, it } from "vitest";
import { formatWorkItemPriority, normalizeWorkItemPriority, parseWorkItemPriorityInput } from "./work-item-priority";

describe("work item priority labels", () => {
  it("maps stored integer priorities to standard labels", () => {
    expect(formatWorkItemPriority(3)).toBe("Urgent");
    expect(formatWorkItemPriority(2)).toBe("Important");
    expect(formatWorkItemPriority(1)).toBe("Medium");
    expect(formatWorkItemPriority(0)).toBe("Low");
  });

  it("renders legacy priorities above the supported range as urgent", () => {
    expect(normalizeWorkItemPriority(5)).toBe(3);
    expect(formatWorkItemPriority(99)).toBe("Urgent");
  });

  it("falls back to low for empty or negative priorities", () => {
    expect(formatWorkItemPriority(null)).toBe("Low");
    expect(formatWorkItemPriority(undefined)).toBe("Low");
    expect(formatWorkItemPriority(-1)).toBe("Low");
  });

  it("re-exports standard label parsing for web API routes", () => {
    expect(parseWorkItemPriorityInput("Urgent")).toBe(3);
    expect(parseWorkItemPriorityInput("Medium")).toBe(1);
  });
});
