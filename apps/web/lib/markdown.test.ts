import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

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
});
