import { describe, expect, it } from "vitest";
import { parseMeetingBlockContext } from "./meetingInsightBlocks";

describe("parseMeetingBlockContext", () => {
  it("extracts block metadata and leaves the review body clean", () => {
    expect(parseMeetingBlockContext([
      "**MEETING BLOCK:** Proposal review",
      "**BLOCK KIND:** proposal discussion",
      "",
      "**CONTEXT:** The proposal was reviewed.",
    ].join("\n"))).toEqual({
      blockTitle: "Proposal review",
      blockKind: "proposal discussion",
      bodyMd: "**CONTEXT:** The proposal was reviewed.",
    });
  });

  it("degrades gracefully when an insight has no block metadata", () => {
    expect(parseMeetingBlockContext("**CONTEXT:** Plain insight.")).toEqual({
      blockTitle: null,
      blockKind: null,
      bodyMd: "**CONTEXT:** Plain insight.",
    });
  });
});
