import { describe, expect, it } from "vitest";
import { markdownToPlainText, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders common document formatting", () => {
    const html = renderMarkdown(`# Heading

Intro with **bold**, _italic_, and [a link](https://example.com).

- First bullet
- Second bullet

1. First step
2. Second step

> Quoted note

\`inline code\`

---

\`\`\`
block code
\`\`\``);

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("href=\"https://example.com\"");
    expect(html).toContain("<li>First bullet</li>");
    expect(html).toContain("<li>First step</li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code>inline code</code>");
    expect(html).toContain("<hr");
    expect(html).toContain("<pre>");
  });

  it("renders markdown while stripping unsafe html", () => {
    const html = renderMarkdown(`# Hello

<script>alert("xss")</script>
<img src="javascript:alert(1)" onerror="alert(2)" alt="bad">
<a href="javascript:alert(3)">bad link</a>`);

    expect(html).toContain("<h1>Hello</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).not.toContain("src=\"javascript:");
    expect(html).not.toContain("onerror");
  });

  it("can render trusted text without loading images", () => {
    const defaultHtml = renderMarkdown("![tracker](https://example.com/pixel.png)");
    const imageFreeHtml = renderMarkdown("![tracker](https://example.com/pixel.png)", { allowImages: false });

    expect(defaultHtml).toContain("<img");
    expect(defaultHtml).toContain("src=\"https://example.com/pixel.png\"");
    expect(imageFreeHtml).not.toContain("<img");
    expect(imageFreeHtml).not.toContain("https://example.com/pixel.png");
  });
});

describe("markdownToPlainText", () => {
  it.each([
    ["J&J and R&D", "J&J and R&D"],
    ["J&amp;J &copy; &eacute; &quot;quoted&quot; &apos;text&apos;", "J&J © é \"quoted\" 'text'"],
    ["&#38; &#x26; &#169; &#x1D11E; &NotEqualTilde;", "& & © 𝄞 ≂̸"],
    ["2 &lt; 3 &gt; 1", "2 < 3 > 1"],
    ["Español — 日本語 𝄞", "Español — 日本語 𝄞"],
  ])("returns display text for %s", (markdown, expected) => {
    expect(markdownToPlainText(markdown)).toBe(expected);
  });

  it("strips formatting, unsafe tags and their non-text content", () => {
    const markdown = `# **Pipeline & Clinical Trials**

<script>alert("unsafe")</script><style>body { color: red; }</style>
<textarea>hidden text</textarea><option>hidden option</option>

<b>Research &amp; Development</b> [details](https://example.com)
<img src="x" onerror="alert(1)">`;

    expect(markdownToPlainText(markdown)).toBe("Pipeline & Clinical Trials Research & Development details");
  });

  it.each([
    ["`&amp; <b>literal</b>`", "&amp; <b>literal</b>"],
    ["```html\n&amp; <script>example</script>\n```", "&amp; <script>example</script>"],
    ["&amp;amp; &amp;lt;b&amp;gt; &unknown;", "&amp; &lt;b&gt; &unknown;"],
    ["&lt;script&gt;example&lt;/script&gt;", "<script>example</script>"],
  ])("preserves intentional literal text in %s", (markdown, expected) => {
    expect(markdownToPlainText(markdown)).toBe(expected);
  });

  it("normalizes decoded whitespace", () => {
    expect(markdownToPlainText("  R&amp;D&nbsp;\t&#160;team\n\nnext  ")).toBe("R&D team next");
  });

  it("truncates decoded text with the existing ellipsis convention", () => {
    expect(markdownToPlainText("J&amp;J &copy; team", 5)).toBe("J&J...");
    expect(markdownToPlainText("J&amp;J", 3)).toBe("J&J");
    expect(markdownToPlainText("J&amp;J", 0)).toBe("...");
    expect(markdownToPlainText("J&amp;J", 1)).toBe("...");
    expect(markdownToPlainText("&lt;b&gt;literal&lt;/b&gt;", 5)).toBe("<b>l...");
    expect(markdownToPlainText("x".repeat(360))).toBe("x".repeat(360));
    expect(markdownToPlainText("x".repeat(361))).toBe(`${"x".repeat(359)}...`);
  });

  it("returns empty text for empty or discarded content", () => {
    expect(markdownToPlainText(" \n\t")).toBe("");
    expect(markdownToPlainText("<script>unsafe</script>")).toBe("");
  });
});
