import { describe, expect, it } from "vitest";
import { normalizeProposalReaction } from "./reactions";

describe("normalizeProposalReaction", () => {
  it("normalizes valid reactions", () => {
    expect(normalizeProposalReaction(" support ")).toBe("SUPPORT");
  });

  it("rejects blank reactions", () => {
    expect(() => normalizeProposalReaction("   ")).toThrowError("reaction is required.");
  });

  it("rejects overly long reactions", () => {
    expect(() => normalizeProposalReaction("a".repeat(33))).toThrowError("reaction must be 32 characters or fewer.");
  });
});
