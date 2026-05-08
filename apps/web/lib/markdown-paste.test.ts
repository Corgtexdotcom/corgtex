import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./markdown-paste";

describe("htmlToMarkdown", () => {
  it("converts rich paste html into markdown", () => {
    const markdown = htmlToMarkdown(`
      <h1>Decision notes</h1>
      <p>We need <strong>clear owners</strong> and <em>dates</em>.</p>
      <ul>
        <li>Capture objections</li>
        <li>Publish next steps</li>
      </ul>
      <blockquote>Keep the decision reversible.</blockquote>
    `);

    expect(markdown).toContain("# Decision notes");
    expect(markdown).toContain("**clear owners**");
    expect(markdown).toContain("_dates_");
    expect(markdown).toContain("- Capture objections");
    expect(markdown).toContain("> Keep the decision reversible.");
  });

  it("converts styled spans from document paste sources", () => {
    const markdown = htmlToMarkdown(`
      <p><span style="font-weight: 700;">Important</span> and <span style="font-style: italic;">optional</span></p>
    `);

    expect(markdown).toContain("**Important**");
    expect(markdown).toContain("_optional_");
  });
});
