import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownExcerpt, MarkdownRenderer } from "./MarkdownRenderer";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("MarkdownExcerpt", () => {
  it.each(["span", "p", "div"] as const)("renders decoded text safely as %s", (as) => {
    const html = renderToStaticMarkup(createElement(MarkdownExcerpt, {
      markdown: "**J&J** &copy; `&amp;` &lt;img src=x onerror=alert(1)&gt; <script>unsafe</script>",
      as,
      className: "synthetic-excerpt",
    }));

    expect(html).toBe(`<${as} class="markdown-excerpt synthetic-excerpt">J&amp;J © &amp;amp; &lt;img src=x onerror=alert(1)&gt;</${as}>`);
  });

  it.each([
    ["Brain", "# Pipeline & Clinical Trials", 140, "div", "brain-article-excerpt", "Pipeline &amp; Clinical Trials"],
    ["Tensions", "**R&D** segment for J&J", 220, "div", "nr-excerpt", "R&amp;D segment for J&amp;J"],
    ["Meetings", "R&D boost", 320, "div", "nr-excerpt", "R&amp;D boost"],
    ["Roles", "Enterprise R&D", 220, "div", "nr-excerpt", "Enterprise R&amp;D"],
    ["Agreements", "R&D allocation", 240, "p", "nr-excerpt", "R&amp;D allocation"],
  ] as const)("encodes %s excerpts once at the React boundary", (_surface, markdown, maxLength, as, className, expected) => {
    const html = renderToStaticMarkup(createElement(MarkdownExcerpt, { markdown, maxLength, as, className }));
    expect(html).toBe(`<${as} class="markdown-excerpt ${className}">${expected}</${as}>`);
  });

  it("uses decoded length before truncating", () => {
    expect(renderToStaticMarkup(createElement(MarkdownExcerpt, { markdown: "J&amp;J pipeline", maxLength: 5 })))
      .toBe('<span class="markdown-excerpt">J&amp;J...</span>');
  });

  it.each([null, undefined, "", " \n ", "<script>unsafe</script>"])("omits empty content %s", (markdown) => {
    expect(renderToStaticMarkup(createElement(MarkdownExcerpt, { markdown }))).toBe("");
  });
});

describe("MarkdownRenderer", () => {
  it("retains sanitized HTML rendering and literal code entities", () => {
    const html = renderToStaticMarkup(createElement(MarkdownRenderer, {
      markdown: "**J&J** `&amp;` <script>unsafe</script>",
    }));
    expect(html).toContain("<strong>J&amp;J</strong>");
    expect(html).toContain("<code>&amp;amp;</code>");
    expect(html).not.toContain("<script");
  });
});
