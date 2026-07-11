import { describe, expect, it } from "vitest";
import {
  normalizeNewspaperDigestPayload,
  normalizeNewspaperEditionDigest,
  renderNewspaperDigestMarkdown,
} from "./newspaper-edition-rendering";

describe("newspaper edition rendering", () => {
  it("normalizes structured edition sections and omits empty sections", () => {
    const digest = normalizeNewspaperDigestPayload({
      intro: "Daily brief.",
      meetingBriefs: ["Weekly tactical reviewed onboarding."],
      decisions: ["Hold launch until QA signs off."],
      openActions: [],
      nextActions: ["Book customer review."],
    });

    expect(digest).toEqual({
      intro: "Daily brief.",
      sections: [
        {
          id: "meetingBriefs",
          title: "Meeting Briefs",
          items: ["Weekly tactical reviewed onboarding."],
        },
        {
          id: "decisionsAndProposals",
          title: "Decisions & Proposals",
          items: ["Hold launch until QA signs off."],
        },
        {
          id: "actionItems",
          title: "Action Items Identified",
          items: ["Book customer review."],
        },
      ],
    });
  });

  it("normalizes stored canonical edition JSON for shared web and email rendering", () => {
    const digest = normalizeNewspaperEditionDigest({
      digestJson: {
        sections: [
          {
            id: "builtWork",
            title: "Built / Shipped Work",
            items: ["Published the canonical edition store."],
          },
          {
            id: "emergingTensions",
            title: "Emerging Tensions",
            items: [{ title: "Follow-up", body: "Confirm production proof after deploy." }],
          },
        ],
      },
    });

    expect(digest.sections).toEqual([
      {
        id: "builtWork",
        title: "Built / Shipped Work",
        items: ["Published the canonical edition store."],
      },
      {
        id: "emergingTensions",
        title: "Emerging Tensions",
        items: ["Follow-up: Confirm production proof after deploy."],
      },
    ]);
  });

  it("renders deterministic markdown from normalized editions", () => {
    const digest = normalizeNewspaperDigestPayload({
      summary: "The workspace shipped a useful update.",
    });

    expect(renderNewspaperDigestMarkdown({ title: "Daily Newspaper", digest })).toBe(
      "# Daily Newspaper\n\n## Conversation Highlights\n\n- The workspace shipped a useful update.",
    );
  });
});
