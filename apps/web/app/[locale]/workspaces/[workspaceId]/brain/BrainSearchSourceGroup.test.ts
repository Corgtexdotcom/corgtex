import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import { BrainSearchSourceGroup } from "./BrainSearchSourceGroup";
import type { BrainSearchSourceGroup as SearchGroup } from "./view-model";

const meeting: SearchGroup = {
  key: "MEETING:meeting-1",
  sourceType: "MEETING",
  sourceId: "meeting-1",
  title: "Planning meeting",
  articleSlug: null,
  meetingId: "meeting-1",
  passages: [
    { chunkId: "high", chunkIndex: 8, snippet: "Most relevant passage" },
    { chunkId: "low", chunkIndex: 1, snippet: "Another useful passage" },
  ],
};

function render(group: SearchGroup, locale: "en" | "es" = "en") {
  const t = createTranslator({ locale, messages: locale === "es" ? esMessages : enMessages, namespace: "brain" });
  return renderToStaticMarkup(React.createElement(BrainSearchSourceGroup, {
    group,
    workspaceId: "workspace-1",
    sourceTypeLabel: t(group.sourceType === "MEETING" ? "searchSourceMeeting" : group.sourceType === "BRAIN_ARTICLE" ? "searchSourceArticle" : "searchSourceDocument"),
    passagesLabel: t("searchPassagesShown", { count: group.passages.length }),
    morePassagesLabel: t("searchMorePassages", { count: group.passages.length - 1 }),
    unavailableLabel: t("unlinkedSearchResult"),
  }));
}

describe("Brain grouped search source", () => {
  it("links the validated meeting and exposes additional passages in a keyboard-native disclosure", () => {
    const html = render(meeting);

    expect(html).toContain('href="/workspaces/workspace-1/meetings/meeting-1"');
    expect(html).toContain("2 passages shown");
    expect(html).toContain("Most relevant passage");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>1 additional passage</summary>");
    expect(html).toContain("Another useful passage");
    expect(html).not.toContain("Most relevant passage...");
  });

  it("uses Spanish labels without changing source routes or passage order", () => {
    const html = render(meeting, "es");

    expect(html).toContain("Reunión · 2 pasajes mostrados");
    expect(html).toContain("1 pasaje adicional");
    expect(html.indexOf("Most relevant passage")).toBeLessThan(html.indexOf("Another useful passage"));
    expect(html).toContain('href="/workspaces/workspace-1/meetings/meeting-1"');
  });

  it("keeps an authorized unlinked document readable without inventing a route", () => {
    const html = render({
      ...meeting,
      key: "DOCUMENT:document-1",
      sourceType: "DOCUMENT",
      sourceId: "document-1",
      title: "Reference document",
      meetingId: null,
      passages: [{ chunkId: "doc", chunkIndex: 0, snippet: "Document excerpt" }],
    });

    expect(html).toContain("1 passage shown");
    expect(html).toContain("Document excerpt");
    expect(html).toContain("Source link unavailable");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<details");
  });
});
