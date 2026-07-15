import { describe, expect, it } from "vitest";

import {
  normalizeNewspaperDigestPayload,
  normalizeNewspaperPersonalizationPayload,
  renderNewspaperDigestMarkdown,
  renderNewspaperEditionEmailHtml,
  renderNewspaperEmailHtml,
  renderWorkspaceBriefingEmailHtml,
  withNewspaperAdviceRequests,
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

  it("normalizes object-style sections with nested items", () => {
    const digest = normalizeNewspaperDigestPayload({
      sections: {
        keyDecisions: { items: ["Approved launch."] },
        actionItems: { items: [{ title: "Confirm owner", body: "Assign the pilot handoff." }] },
      },
    });

    expect(digest.sections).toEqual([
      { id: "keyDecisions", title: "Key Decisions Made", items: ["Approved launch."] },
      { id: "actionItems", title: "Action Items Identified", items: ["Confirm owner: Assign the pilot handoff."] },
    ]);
  });

  it("normalizes aliases inside object-style sections", () => {
    const digest = normalizeNewspaperDigestPayload({
      sections: {
        decisions: ["Hold launch until QA signs off."],
        nextActions: ["Book customer review."],
      },
    });

    expect(digest.sections.map((section) => section.id)).toEqual(["decisionsAndProposals", "actionItems"]);
    expect(digest.sections[0]?.items).toEqual(["Hold launch until QA signs off."]);
    expect(digest.sections[1]?.items).toEqual(["Book customer review."]);
  });

  it("normalizes self-management operating sections", () => {
    const digest = normalizeNewspaperDigestPayload({
      meetingBriefs: ["Weekly tactical reviewed onboarding."],
      decisionsAndProposals: ["Adopt the role handoff proposal."],
      resolvedTensions: ["Closed support ownership tension."],
      openActions: ["Pat owns the launch checklist."],
      goalsProgress: ["Quarterly onboarding goal moved to 60%."],
      rolesAndPeople: ["New facilitator role created."],
      otherUpdates: ["Brain article updated."],
    });

    expect(digest.sections.map((section) => section.title)).toEqual([
      "Meeting Briefs",
      "Decisions & Proposals",
      "Resolved Tensions",
      "Open Actions",
      "Goals & Quarterly Progress",
      "Roles & People",
      "Other Updates",
    ]);
  });

  it("adds personal advice requests as the lead email section", () => {
    const digest = normalizeNewspaperDigestPayload({
      builtWork: ["Shipped a useful update."],
    });
    const personalizedDigest = withNewspaperAdviceRequests(digest, [
      "Input request: Tension - Clarify support ownership\nRequest: Please advise on the handoff.",
    ]);

    expect(personalizedDigest.sections.map((section) => section.id)).toEqual(["adviceRequests", "builtWork"]);
    expect(renderNewspaperDigestMarkdown({ title: "Daily Newspaper", digest: personalizedDigest })).toContain("## Requests Awaiting Your Input");
    expect(renderNewspaperEmailHtml({
      title: "Daily Newspaper",
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
      digest: personalizedDigest,
    })).toContain("Requests Awaiting Your Input");
  });

  it("normalizes advice request aliases from structured payloads", () => {
    const digest = normalizeNewspaperDigestPayload({
      requestsAwaitingInput: ["Advice request: Proposal - Approve pricing."],
    });

    expect(digest.sections).toEqual([
      {
        id: "adviceRequests",
        title: "Requests Awaiting Your Input",
        items: ["Advice request: Proposal - Approve pricing."],
      },
    ]);
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
    expect(html).toContain("trace it back to evidence");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("renders newsletter html from the stored canonical edition", () => {
    const html = renderNewspaperEditionEmailHtml({
      edition: {
        title: "Weekly Newspaper - 2026-07-11",
        digestJson: {
          intro: "Shared edition intro.",
          builtWork: ["Stored edition powers the newsletter."],
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
    });

    expect(html).toContain("Weekly Newspaper - 2026-07-11");
    expect(html).toContain("Shared edition intro.");
    expect(html).toContain("Built / Shipped Work");
    expect(html).toContain("Stored edition powers the newsletter.");
  });

  it("renders newsletter html from a stored workspace briefing", () => {
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: "Shared briefing intro.",
          items: [{
            kind: "BUILD_ARTIFACT",
            title: "Briefing system",
            summaryMd: "The canonical briefing powers the newsletter.",
            whyItMattersMd: "One artifact now feeds homepage and email.",
            prominence: "lead",
            sourceRefs: [],
            href: null,
            occurredAt: "2026-07-11T12:00:00.000Z",
            confidence: 0.9,
          }],
          sourceRefs: [],
          sourceCounts: { BUILD_ARTIFACT: 1 },
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
    });

    expect(html).toContain("Daily Workspace Briefing - 2026-07-11");
    expect(html).toContain("Shared briefing intro.");
    expect(html).toContain("Built / Shipped Work");
    expect(html).toContain("The canonical briefing powers the newsletter.");
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
