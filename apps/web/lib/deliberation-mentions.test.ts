import { describe, expect, it } from "vitest";
import {
  applyMentionSelection,
  filterMentionTargets,
  getActiveMentionRange,
  type DeliberationMentionTarget,
} from "./deliberation-mentions";

const targets: DeliberationMentionTarget[] = [
  { value: "member:andy", label: "Person: Andy Durrant", kind: "member", name: "Andy Durrant" },
  { value: "circle:ops", label: "Circle: Operations", kind: "circle", name: "Operations" },
  { value: "circle:product", label: "Circle: Product", kind: "circle", name: "Product" },
  { value: "member:alex", label: "Person: Alex Rivera", kind: "member", name: "Alex Rivera" },
];

describe("deliberation mentions", () => {
  it("detects an active mention range at the cursor", () => {
    expect(getActiveMentionRange("@pro", 4)).toEqual({ start: 0, end: 4, query: "pro" });
    expect(getActiveMentionRange("Please ask @op", 14)).toEqual({ start: 11, end: 14, query: "op" });
  });

  it("ignores email-style at signs and mentions broken by whitespace", () => {
    expect(getActiveMentionRange("andy@example.com", 6)).toBeNull();
    expect(getActiveMentionRange("@Andy Durrant", 13)).toBeNull();
  });

  it("filters targets case-insensitively with circles before people", () => {
    expect(filterMentionTargets(targets, "").map((target) => target.value)).toEqual([
      "circle:ops",
      "circle:product",
      "member:andy",
      "member:alex",
    ]);
    expect(filterMentionTargets(targets, "PRO").map((target) => target.value)).toEqual(["circle:product"]);
    expect(filterMentionTargets(targets, "alex").map((target) => target.value)).toEqual(["member:alex"]);
  });

  it("returns no matches when no target matches the query", () => {
    expect(filterMentionTargets(targets, "finance")).toEqual([]);
  });

  it("replaces the active mention text and returns the next cursor position", () => {
    const mention = getActiveMentionRange("Please ask @pro", 15);
    expect(mention).not.toBeNull();

    const result = applyMentionSelection("Please ask @pro", mention!, targets[2]);

    expect(result.value).toBe("Please ask @Product ");
    expect(result.cursorIndex).toBe("Please ask @Product ".length);
  });
});
