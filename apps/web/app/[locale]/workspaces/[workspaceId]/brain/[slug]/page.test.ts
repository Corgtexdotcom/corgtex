import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { read, notFound, notFoundSignal, AppError } = vi.hoisted(() => {
  const notFoundSignal = new Error("Next not-found signal");
  return {
    read: vi.fn(),
    notFound: vi.fn((): never => { throw notFoundSignal; }),
    notFoundSignal,
    AppError: class extends Error {
      constructor(public status: number, public code: string) { super(code); }
    },
  };
});
vi.mock("@corgtex/domain", () => ({ AppError, getArticlePageData: read, updateArticle: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "reader" } }) }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/components/MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("@/lib/components/MarkdownRenderer", () => ({ MarkdownRenderer: () => null }));
vi.mock("@/lib/components/ArchivedItemBanner", () => ({ ArchivedItemBanner: () => null }));
vi.mock("../actions", () => ({ publishArticleAction: vi.fn(), returnArticleToDraftAction: vi.fn() }));
vi.mock("../BrainArticleTypeControl", () => ({ BrainArticleTypeControl: () => null }));

import BrainArticlePage from "./page";
import BrainArticleNotFound from "./not-found";

const render = () => BrainArticlePage({ params: Promise.resolve({ workspaceId: "workspace", slug: "article" }) });
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Brain article detail route", () => {
  it("maps the reader's typed article-not-found error to Next's 404", async () => {
    read.mockRejectedValueOnce(new AppError(404, "NOT_FOUND"));
    await expect(render()).rejects.toBe(notFoundSignal);
    expect(notFound).toHaveBeenCalledOnce();
  });

  it.each([
    new AppError(409, "SOURCE_CHANGED"),
    new AppError(404, "OTHER"),
    Object.assign(new Error("untyped"), { status: 404, code: "NOT_FOUND" }),
  ])("preserves unrelated read failures (%s)", async (error) => {
    read.mockRejectedValueOnce(error);
    await expect(render()).rejects.toBe(error);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("provides a generic localized fallback with no article metadata", async () => {
    const html = renderToStaticMarkup(await BrainArticleNotFound());
    expect(html).toContain("<h1");
    expect(html).toContain("articleNotFoundTitle");
    expect(html).toContain("articleNotFoundDescription");
  });
});
