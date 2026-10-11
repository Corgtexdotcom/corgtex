import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { article } = vi.hoisted(() => ({ article: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => ({ kind: "user", user: { id: "user-1" } }) }));
vi.mock("@corgtex/domain", () => ({ getArticle: article }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("../../actions", () => ({ updateArticleAction: async () => {} }));
vi.mock("@/lib/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ name, defaultValue }: { name: string; defaultValue: string }) =>
    React.createElement("textarea", { name, defaultValue }),
}));

import BrainArticleEditPage from "./page";

async function render() {
  return renderToStaticMarkup(await BrainArticleEditPage({
    params: Promise.resolve({ workspaceId: "workspace-1", slug: "weekly-digest" }),
  }));
}

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Brain article edit page", () => {
  it("loads a DIGEST with its true read-only type and a cancel link", async () => {
    article.mockResolvedValue({ title: "Weekly digest", type: "DIGEST", authority: "DRAFT", bodyMd: "Summary" });

    const html = await render();

    expect(article).toHaveBeenCalledWith(expect.anything(), { workspaceId: "workspace-1", slug: "weekly-digest" });
    expect(html).toContain('value="DIGEST"');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain('name="type"');
    expect(html).toContain('href="/workspaces/workspace-1/brain/weekly-digest"');
  });

  it("loads an ordinary type as a selected editable option", async () => {
    article.mockResolvedValue({ title: "Project notes", type: "PROJECT", authority: "DRAFT", bodyMd: "Notes" });

    const html = await render();

    expect(html).toContain('<select name="type"');
    expect(html).toMatch(/<option value="PROJECT" selected="">PROJECT<\/option>/);
  });
});
