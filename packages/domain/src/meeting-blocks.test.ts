import { describe, expect, it } from "vitest";
import {
  normalizeMeetingBlocks,
  prependMeetingBlockContext,
  resolveMeetingBlockReference,
} from "./meeting-blocks";

describe("meeting blocks", () => {
  it("normalizes dynamic blocks while preserving custom block kinds", () => {
    const blocks = normalizeMeetingBlocks({
      blocks: [
        {
          sequence: 2,
          title: "Proposal review",
          kind: "Proposal Discussion",
          summary: "The team reviewed a proposal.",
          sourceQuote: "this was the decision connected to a proposal",
          relatedRecords: [{ entityType: "Proposal", entityId: "proposal-1", title: "Template proposal" }],
        },
        {
          sequence: 1,
          title: "Opening check-in",
          kind: "Personal update",
          summaryMd: "The meeting opened with a quick personal check-in.",
        },
      ],
    });

    expect(blocks).toEqual({
      version: 1,
      blocks: [
        expect.objectContaining({
          sequence: 1,
          title: "Opening check-in",
          kind: "personal_update",
        }),
        expect.objectContaining({
          sequence: 2,
          title: "Proposal review",
          kind: "proposal_discussion",
          relatedRecords: [{ entityType: "Proposal", entityId: "proposal-1", title: "Template proposal" }],
        }),
      ],
    });
  });

  it("resolves block references and prepends readable metadata", () => {
    const blocks = normalizeMeetingBlocks({
      blocks: [{ sequence: 3, title: "Org structure", kind: "custom", summaryMd: "The group discussed circle visibility." }],
    });
    const block = resolveMeetingBlockReference(blocks, { sequence: 3 });

    expect(prependMeetingBlockContext("**CONTEXT:** Circles need clearer visibility.", block)).toBe([
      "**MEETING BLOCK:** Org structure",
      "**BLOCK KIND:** custom",
      "",
      "**CONTEXT:** Circles need clearer visibility.",
    ].join("\n"));
  });
});
