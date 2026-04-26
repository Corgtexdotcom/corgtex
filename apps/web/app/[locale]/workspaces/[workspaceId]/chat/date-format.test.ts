import { describe, expect, it } from "vitest";
import { formatConversationDate } from "./date-format";

describe("formatConversationDate", () => {
  it("formats conversation dates in UTC so server and browser text match", () => {
    expect(formatConversationDate("2026-04-21T01:30:00.000Z")).toBe("Apr 21");
  });

  it("returns an empty label for invalid dates", () => {
    expect(formatConversationDate("not-a-date")).toBe("");
  });
});
