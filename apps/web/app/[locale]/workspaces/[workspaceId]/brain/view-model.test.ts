import { describe, expect, it } from "vitest";
import {
  buildBrainIndexHref,
  buildBrainIndexState,
  buildBrainTypeCounts,
  buildBrainTypeSummaries,
  canManageBrainArticle,
  filterBrainArticlesByType,
  filterBrainRecordsByRange,
  normalizeBrainArticleType,
  normalizeBrainIndexSearch,
  normalizeBrainRange,
  resolveBrainSearchResults,
  type BrainArticleDirectoryItem,
} from "./view-model";

function article(overrides: Partial<BrainArticleDirectoryItem> & Pick<BrainArticleDirectoryItem, "id" | "slug" | "title" | "type">): BrainArticleDirectoryItem {
  return {
    authority: "REFERENCE",
    bodyMd: `${overrides.title} body`,
    isPrivate: false,
    updatedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("Brain index view model", () => {
  it("normalizes shareable URL state", () => {
    expect(normalizeBrainRange(undefined)).toBe("30d");
    expect(normalizeBrainRange("90d")).toBe("90d");
    expect(normalizeBrainRange("all")).toBe("all");
    expect(normalizeBrainRange("bad")).toBe("30d");

    expect(normalizeBrainArticleType("PROCESS")).toBe("PROCESS");
    expect(normalizeBrainArticleType("unknown")).toBeNull();

    expect(normalizeBrainIndexSearch({
      q: ["strategy"],
      question: "What changed?",
      range: "all",
      type: "STRATEGY",
    })).toEqual({
      query: "strategy",
      question: "What changed?",
      range: "all",
      selectedType: "STRATEGY",
    });
  });

  it("handles sparse and one-category workspaces without empty categories", () => {
    const articles = [
      article({ id: "a-1", slug: "constitution", title: "AI Manager Constitution", type: "PATTERN" }),
    ];

    expect(buildBrainTypeCounts(articles)).toEqual([{ type: "PATTERN", count: 1 }]);
    expect(buildBrainTypeSummaries(articles)).toEqual([
      expect.objectContaining({
        type: "PATTERN",
        count: 1,
        sampleArticles: articles,
        remainingCount: 0,
      }),
    ]);
  });

  it("orders uneven category summaries by density and caps samples", () => {
    const articles = [
      article({ id: "arch-1", slug: "arch-1", title: "Architecture 1", type: "ARCHITECTURE" }),
      article({ id: "arch-2", slug: "arch-2", title: "Architecture 2", type: "ARCHITECTURE" }),
      article({ id: "arch-3", slug: "arch-3", title: "Architecture 3", type: "ARCHITECTURE" }),
      article({ id: "arch-4", slug: "arch-4", title: "Architecture 4", type: "ARCHITECTURE" }),
      article({ id: "product-1", slug: "product-1", title: "Product 1", type: "PRODUCT" }),
      article({ id: "decision-1", slug: "decision-1", title: "Decision 1", type: "DECISION" }),
    ];

    const summaries = buildBrainTypeSummaries(articles, 2);

    expect(summaries.map((summary) => [summary.type, summary.count, summary.sampleArticles.length, summary.remainingCount])).toEqual([
      ["ARCHITECTURE", 4, 2, 2],
      ["PRODUCT", 1, 1, 0],
      ["DECISION", 1, 1, 0],
    ]);
  });

  it("filters the dense article list by selected type while preserving all type counts", () => {
    const articles = [
      article({ id: "strategy-1", slug: "strategy-1", title: "Strategy 1", type: "STRATEGY" }),
      article({ id: "strategy-2", slug: "strategy-2", title: "Strategy 2", type: "STRATEGY" }),
      article({ id: "process-1", slug: "process-1", title: "Process 1", type: "PROCESS" }),
    ];

    const state = buildBrainIndexState({
      articles,
      meetings: [],
      documents: [],
      searchParams: { type: "STRATEGY" },
      now: new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(state.selectedType).toBe("STRATEGY");
    expect(state.visibleArticles.map((entry) => entry.slug)).toEqual(["strategy-1", "strategy-2"]);
    expect(state.typeCounts).toEqual([
      { type: "STRATEGY", count: 2 },
      { type: "PROCESS", count: 1 },
    ]);
    expect(filterBrainArticlesByType(articles, null)).toHaveLength(3);
  });

  it("filters raw meetings and documents by 30d, 90d, and all ranges", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const meetings = [
      { id: "recent", recordedAt: "2026-07-01T12:00:00.000Z" },
      { id: "older", recordedAt: "2026-05-01T12:00:00.000Z" },
      { id: "oldest", recordedAt: "2025-12-01T12:00:00.000Z" },
    ];
    const documents = [
      { id: "recent", createdAt: "2026-07-01T12:00:00.000Z" },
      { id: "older", createdAt: "2026-05-01T12:00:00.000Z" },
      { id: "oldest", createdAt: "2025-12-01T12:00:00.000Z" },
    ];

    expect(filterBrainRecordsByRange(meetings, "30d", "recordedAt", now).map((entry) => entry.id)).toEqual(["recent"]);
    expect(filterBrainRecordsByRange(documents, "90d", "createdAt", now).map((entry) => entry.id)).toEqual(["recent", "older"]);
    expect(filterBrainRecordsByRange(documents, "all", "createdAt", now).map((entry) => entry.id)).toEqual(["recent", "older", "oldest"]);
  });

  it("keeps manage actions scoped to agents, admins, and article owners", () => {
    const owned = { ownerMemberId: "member-1" };
    const unowned = { ownerMemberId: "member-2" };

    expect(canManageBrainArticle({ kind: "agent" }, null, unowned)).toBe(true);
    expect(canManageBrainArticle({ kind: "user" }, { id: "admin", role: "ADMIN" }, unowned)).toBe(true);
    expect(canManageBrainArticle({ kind: "user" }, { id: "member-1", role: "MEMBER" }, owned)).toBe(true);
    expect(canManageBrainArticle({ kind: "user" }, { id: "member-1", role: "MEMBER" }, unowned)).toBe(false);
  });

  it("resolves Brain article search source IDs to article slugs", () => {
    const results = resolveBrainSearchResults(
      [
        { sourceId: "article-id-1", sourceType: "BRAIN_ARTICLE", chunkId: "chunk-1" },
        { sourceId: "already-a-slug", sourceType: "BRAIN_ARTICLE", chunkId: "chunk-2" },
        { sourceId: "missing", sourceType: "BRAIN_ARTICLE", chunkId: "chunk-3" },
      ],
      [
        { id: "article-id-1", slug: "strategy-article" },
        { id: "article-id-2", slug: "already-a-slug" },
      ],
    );

    expect(results.map((result) => result.articleSlug)).toEqual(["strategy-article", "already-a-slug", null]);
  });

  it("builds filter hrefs that preserve non-default URL state", () => {
    expect(buildBrainIndexHref({ query: " strategy ", question: "why?", range: "90d", type: "STRATEGY" }))
      .toBe("?q=strategy&question=why%3F&range=90d&type=STRATEGY");
    expect(buildBrainIndexHref({ range: "30d", type: null })).toBe("?");
  });
});
