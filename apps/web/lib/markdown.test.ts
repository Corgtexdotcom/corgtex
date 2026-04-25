import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
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
