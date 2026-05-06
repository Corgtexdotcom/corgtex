import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./markdown-paste";

describe("htmlToMarkdown", () => {
  it("converts rich document paste fragments to markdown", () => {
    const markdown = htmlToMarkdown(`
      <h1>Decision notes</h1>
      <p>Keep <strong>bold</strong> and <em>emphasis</em>.</p>
      <ul><li>First point</li><li>Second point</li></ul>
      <blockquote>Quoted signal</blockquote>
    `);

    expect(markdown).toContain("# Decision notes");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("_emphasis_");
    expect(markdown).toContain("- First point");
    expect(markdown).toContain("- Second point");
    expect(markdown).toContain("> Quoted signal");
  });

  it("converts styled spans from document editors", () => {
    const markdown = htmlToMarkdown(`
      <p><span style="font-weight: 700;">Important</span> and <span style="font-style: italic;">nuanced</span></p>
    `);

    expect(markdown).toContain("**Important**");
    expect(markdown).toContain("_nuanced_");
  });
});
