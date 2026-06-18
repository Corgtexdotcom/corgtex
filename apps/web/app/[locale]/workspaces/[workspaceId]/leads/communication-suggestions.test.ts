import { describe, expect, it } from "vitest";
import {
  isOpenCommunicationSuggestion,
  sortCommunicationSuggestions,
  splitCommunicationSuggestions,
} from "./communication-suggestions";

describe("communication suggestion view helpers", () => {
  it("keeps failed, suggested, and requested items in the actionable queue", () => {
    const suggestions = [
      { id: "sent", status: "SENT", updatedAt: "2026-06-18T10:00:00.000Z" },
      { id: "failed", status: "FAILED", updatedAt: "2026-06-18T09:00:00.000Z" },
      { id: "requested", status: "REQUESTED", updatedAt: "2026-06-18T08:00:00.000Z" },
      { id: "declined", status: "DECLINED", updatedAt: "2026-06-18T11:00:00.000Z" },
      { id: "suggested", status: "SUGGESTED", updatedAt: "2026-06-18T12:00:00.000Z" },
    ];

    const split = splitCommunicationSuggestions(suggestions);

    expect(split.open.map((suggestion) => suggestion.id)).toEqual(["failed", "suggested", "requested"]);
    expect(split.sent.map((suggestion) => suggestion.id)).toEqual(["sent"]);
    expect(split.declined.map((suggestion) => suggestion.id)).toEqual(["declined"]);
  });

  it("sorts by status priority and then newest update inside each status", () => {
    const sorted = sortCommunicationSuggestions([
      { id: "old-suggested", status: "SUGGESTED", updatedAt: "2026-06-17T12:00:00.000Z" },
      { id: "requested", status: "REQUESTED", updatedAt: "2026-06-18T12:00:00.000Z" },
      { id: "new-suggested", status: "SUGGESTED", updatedAt: "2026-06-18T12:00:00.000Z" },
      { id: "failed", status: "FAILED", updatedAt: "2026-06-16T12:00:00.000Z" },
    ]);

    expect(sorted.map((suggestion) => suggestion.id)).toEqual([
      "failed",
      "new-suggested",
      "old-suggested",
      "requested",
    ]);
  });

  it("treats only non-terminal review states as open", () => {
    expect(isOpenCommunicationSuggestion({ status: "SUGGESTED" })).toBe(true);
    expect(isOpenCommunicationSuggestion({ status: "REQUESTED" })).toBe(true);
    expect(isOpenCommunicationSuggestion({ status: "FAILED" })).toBe(true);
    expect(isOpenCommunicationSuggestion({ status: "SENT" })).toBe(false);
    expect(isOpenCommunicationSuggestion({ status: "DECLINED" })).toBe(false);
  });
});
