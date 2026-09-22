import { describe, expect, it } from "vitest";
import { resolveProposalDeliberationComposer } from "./proposal-deliberation";

describe("resolveProposalDeliberationComposer", () => {
  it("keeps objections available on open proposals", () => {
    expect(resolveProposalDeliberationComposer({ isArchived: false, status: "OPEN" })).toEqual({
      visible: true,
      entryTypes: ["REACTION", "OBJECTION"],
      mode: "open",
    });
  });

  it("allows reaction-only comments on resolved proposals", () => {
    expect(resolveProposalDeliberationComposer({ isArchived: false, status: "RESOLVED" })).toEqual({
      visible: true,
      entryTypes: ["REACTION"],
      mode: "post-decision",
    });
  });

  it("hides the composer for drafts and archived proposals", () => {
    expect(resolveProposalDeliberationComposer({ isArchived: false, status: "DRAFT" })).toEqual({
      visible: false,
      entryTypes: [],
      mode: null,
    });
    expect(resolveProposalDeliberationComposer({ isArchived: true, status: "RESOLVED" })).toEqual({
      visible: false,
      entryTypes: [],
      mode: null,
    });
  });
});
