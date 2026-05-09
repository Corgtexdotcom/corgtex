import { describe, expect, it } from "vitest";
import {
  normalizeNewspaperDigestPayload,
  normalizeNewspaperPersonalizationPayload,
  renderNewspaperDigestMarkdown,
  renderNewspaperEmailHtml,
} from "./newspaper-email";

describe("newspaper email rendering", () => {
  it("normalizes structured sections and omits empty sections", () => {
    const digest = normalizeNewspaperDigestPayload({
      intro: "Daily brief.",
      keyDecisions: ["Approved launch."],
      actionItems: [],
      emergingTensions: "Clarify ownership.",
    });

    expect(digest.sections.map((section) => section.id)).toEqual(["keyDecisions", "emergingTensions"]);
    expect(renderNewspaperDigestMarkdown({ title: "Daily Newspaper", digest })).toContain("## Key Decisions Made");
    expect(renderNewspaperDigestMarkdown({ title: "Daily Newspaper", digest })).not.toContain("## Action Items Identified");
  });

  it("escapes model-provided text in email html", () => {
    const digest = normalizeNewspaperDigestPayload({
      keyDecisions: ["Use <script>alert('x')</script> safely."],
    });
    const personalization = normalizeNewspaperPersonalizationPayload({
      greeting: "Hi <b>Pat</b>",
      memberNote: "Review <img src=x onerror=alert(1)>",
    });

    const html = renderNewspaperEmailHtml({
      title: "Daily <Newspaper>",
      workspaceName: "Acme <Ops>",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1?x=<bad>",
      digest,
      personalization,
    });

    expect(html).toContain("Daily &lt;Newspaper&gt;");
    expect(html).toContain("Acme &lt;Ops&gt;");
    expect(html).toContain("Hi &lt;b&gt;Pat&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert('x')&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("uses deterministic markdown output", () => {
    const digest = normalizeNewspaperDigestPayload({
      summary: "The workspace shipped a useful update.",
    });

    expect(renderNewspaperDigestMarkdown({ title: "Daily Newspaper", digest })).toBe([
      "# Daily Newspaper",
      "",
      "## Conversation Highlights",
      "",
      "- The workspace shipped a useful update.",
    ].join("\n"));
  });
});
