import { describe, expect, it } from "vitest";
import { canOpenPrivateDraft } from "./governance-open-guards";

describe("governance open guards", () => {
  it("only allows Open CTAs for private drafts", () => {
    expect(canOpenPrivateDraft({ status: "DRAFT", isPrivate: true })).toBe(true);
    expect(canOpenPrivateDraft({ status: "DRAFT", isPrivate: false })).toBe(false);
    expect(canOpenPrivateDraft({ status: "DRAFT", isPrivate: null })).toBe(false);
    expect(canOpenPrivateDraft({ status: "OPEN", isPrivate: false })).toBe(false);
    expect(canOpenPrivateDraft({ status: "RESOLVED", isPrivate: false })).toBe(false);
  });
});
