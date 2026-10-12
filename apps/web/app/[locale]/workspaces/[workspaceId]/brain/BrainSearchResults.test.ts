import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import { BrainSearchResults, type BrainSearchLabels } from "./BrainSearchResults";
import type { BrainSearchSourceGroup } from "./view-model";

function labels(locale: "en" | "es"): BrainSearchLabels {
  const t = createTranslator({ locale, messages: locale === "es" ? esMessages : enMessages, namespace: "brain" });
  return {
    results: t("results"),
    noResults: t("searchNoResults"),
    noAvailableSources: t("searchNoAvailableSources"),
    someSourcesUnavailable: t("searchSomeSourcesUnavailable"),
    coverageNote: t("searchCoverageNote"),
    unavailableSource: t("unlinkedSearchResult"),
    sourceType: {
      MEETING: t("searchSourceMeeting"),
      BRAIN_ARTICLE: t("searchSourceArticle"),
      DOCUMENT: t("searchSourceDocument"),
    },
    passagesShown: (count) => t("searchPassagesShown", { count }),
    morePassages: (count) => t("searchMorePassages", { count }),
  };
}

function render(groups: BrainSearchSourceGroup[], rawResultCount: number, hasUnavailableSources: boolean, locale: "en" | "es" = "en") {
  return renderToStaticMarkup(React.createElement(BrainSearchResults, {
    groups,
    rawResultCount,
    hasUnavailableSources,
    workspaceId: "workspace-1",
    labels: labels(locale),
  }));
}

describe("Brain search result states", () => {
  it.each([
    ["en", "No indexed passages were found for this search."],
    ["es", "No se encontraron pasajes indexados para esta búsqueda."],
  ] as const)("shows a truthful empty state in %s", (locale, expected) => {
    const html = render([], 0, false, locale);
    expect(html).toContain('role="status"');
    expect(html).toContain(expected);
    expect(html).not.toContain("<article");
  });

  it("does not render identity or excerpts when all indexed sources are unavailable", () => {
    const html = render([], 2, true);
    expect(html).toContain("No available sources were found in these results.");
    expect(html).not.toContain("2 passages");
    expect(html).not.toContain("<article");
  });

  it("keeps a validated source while reporting omitted results without a hidden count", () => {
    const html = render([{
      key: "BRAIN_ARTICLE:article-1",
      sourceType: "BRAIN_ARTICLE",
      sourceId: "article-1",
      title: "Visible plan",
      articleSlug: "visible-plan",
      meetingId: null,
      passages: [{ chunkId: "visible-chunk", chunkIndex: 0, snippet: "Visible excerpt" }],
    }], 2, true);
    expect(html).toContain('href="/workspaces/workspace-1/brain/visible-plan"');
    expect(html).toContain("Visible excerpt");
    expect(html).toContain("Some search results could not be shown.");
    expect(html).not.toContain("2 passages");
  });
});
