import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainSearchResultCard } from "./BrainSearchResultCard";

const baseResult: Parameters<typeof BrainSearchResultCard>[0]["result"] = {
  sourceId: "meeting-1", sourceType: "MEETING",
  title: "Sensitive meeting title", snippet: "Sensitive meeting transcript",
  articleSlug: null, meetingId: null,
};

function render(result: typeof baseResult) {
  return renderToStaticMarkup(React.createElement(BrainSearchResultCard, {
    result, workspaceId: "workspace-1", unavailableLabel: "Source link unavailable",
  }));
}

describe("Brain search result card", () => {
  it("links a validated meeting to its same-workspace detail route", () => {
    const html = render({ ...baseResult, meetingId: "meeting-1" });

    expect(html).toContain('href="/workspaces/workspace-1/meetings/meeting-1"');
    expect(html).toContain("Sensitive meeting title");
    expect(html).toContain("Sensitive meeting transcript");
  });

  it("hides indexed content and IDs for an unverified meeting", () => {
    const html = render(baseResult);

    expect(html).toContain("Source link unavailable");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Sensitive meeting title");
    expect(html).not.toContain("Sensitive meeting transcript");
    expect(html).not.toContain("meeting-1");
  });

  it("preserves the existing article link and unlinked document display", () => {
    const article = render({ ...baseResult, sourceType: "BRAIN_ARTICLE", articleSlug: "strategy" });
    const document = render({ ...baseResult, sourceType: "DOCUMENT", sourceId: "document-1" });

    expect(article).toContain('href="/workspaces/workspace-1/brain/strategy"');
    expect(article).toContain("Sensitive meeting title");
    expect(document).toContain("Sensitive meeting title");
    expect(document).toContain("Source link unavailable");
  });
});
