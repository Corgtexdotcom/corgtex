import { describe, expect, it } from "vitest";
import {
  normalizeMeetingBlocks,
  normalizeMeetingProductTerminology,
  prependMeetingBlockContext,
  resolveMeetingBlockReference,
  stripMeetingBlockContext,
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

  it("corrects Corgtex transcription drift in generated meeting block text", () => {
    expect(normalizeMeetingProductTerminology("Cortex implementation update")).toBe("Corgtex implementation update");

    const blocks = normalizeMeetingBlocks({
      blocks: [
        {
          sequence: 1,
          title: "Cortex rollout",
          kind: "update",
          summaryMd: "The team discussed Cortex implementation details.",
          sourceQuote: "Cortex is moving forward",
          relatedRecords: [{ entityType: "Proposal", entityId: "proposal-1", title: "Cortex rollout proposal" }],
        },
      ],
    });

    expect(blocks.blocks[0]).toEqual(expect.objectContaining({
      title: "Corgtex rollout",
      summaryMd: "The team discussed Corgtex implementation details.",
      sourceQuote: "Corgtex is moving forward",
      relatedRecords: [{ entityType: "Proposal", entityId: "proposal-1", title: "Corgtex rollout proposal" }],
    }));
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

  it("strips internal block metadata before creating human records", () => {
    expect(stripMeetingBlockContext([
      "**MEETING BLOCK:** Proposal review",
      "**BLOCK KIND:** proposal discussion",
      "",
      "### Proposed change",
      "Use human-readable proposal notes.",
    ].join("\n"))).toBe([
      "### Proposed change",
      "Use human-readable proposal notes.",
    ].join("\n"));
  });
});
