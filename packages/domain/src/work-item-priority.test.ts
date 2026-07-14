import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  coerceWorkItemPriorityInput,
  formatWorkItemPriority,
  normalizeWorkItemPriority,
  parseWorkItemPriorityInput,
} from "./work-item-priority";

describe("work item priority helpers", () => {
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

  it("parses standard priority labels and numeric strings", () => {
    expect(parseWorkItemPriorityInput("Urgent")).toBe(3);
    expect(parseWorkItemPriorityInput(" important ")).toBe(2);
    expect(parseWorkItemPriorityInput("Medium")).toBe(1);
    expect(parseWorkItemPriorityInput("low")).toBe(0);
    expect(parseWorkItemPriorityInput("5")).toBe(3);
  });

  it("returns undefined for empty priority inputs", () => {
    expect(parseWorkItemPriorityInput(null)).toBeUndefined();
    expect(parseWorkItemPriorityInput(undefined)).toBeUndefined();
    expect(parseWorkItemPriorityInput("")).toBeUndefined();
  });

  it("raises an API-friendly error for unsupported labels", () => {
    expect(() => coerceWorkItemPriorityInput("Critical")).toThrow(AppError);
    expect(() => coerceWorkItemPriorityInput("Critical")).toThrow("priority must be Urgent, Important, Medium, Low, or an integer priority.");
  });
});
