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
          leadMd: "**Briefing system**: The canonical briefing powers the newsletter.",
          bodyMd: "The homepage and email now read from the same narrative artifact.",
          attentionMd: "The main attention point is to review the generated briefing before sending.",
          continuingContextMd: "The source trail remains available for evidence.",
          closingMd: "The story is meant to stand on its own.",
          editorialMode: "daily_homepage",
          freshWindow: {
            label: "Last 24-36 hours",
            since: "2026-07-10T00:00:00.000Z",
            until: "2026-07-11T12:00:00.000Z",
          },
          contextWindow: {
            label: "Current month context",
            since: "2026-06-11T12:00:00.000Z",
            until: "2026-07-11T12:00:00.000Z",
          },
          items: [{
            kind: "BUILD_ARTIFACT",
            title: "Briefing system",
            summaryMd: "The canonical briefing powers the newsletter.",
            whyItMattersMd: "One artifact now feeds homepage and email.",
            prominence: "lead",
            sourceRefs: [{
              type: "PROPOSAL",
              id: "proposal-1",
              label: "Review proposal",
              href: "/workspaces/ws-1/proposals/proposal-1",
            }],
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
    expect(html).toContain("The canonical briefing powers the newsletter.");
    expect(html).toContain("The homepage and email now read from the same narrative artifact.");
    expect(html).not.toContain("Built / Shipped Work");
    expect(html).not.toContain("<h2");
  });

  it("resolves workspace source links against the email app origin", () => {
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: null,
          leadMd: "**Decision**: The workspace needs a review.",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: null,
          closingMd: null,
          editorialMode: "daily_email",
          freshWindow: { label: "Last 24-36 hours", since: "2026-07-10T00:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Current month context", since: "2026-06-11T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [{
            kind: "PROPOSAL",
            title: "Review proposal",
            summaryMd: "The workspace needs a review.",
            whyItMattersMd: "This decision is ready for review.",
            prominence: "lead",
            sourceRefs: [{
              type: "PROPOSAL",
              id: "proposal-1",
              label: "Review proposal",
              href: "/workspaces/ws-1/proposals/proposal-1",
            }],
            href: "/workspaces/ws-1/proposals/proposal-1",
            occurredAt: "2026-07-11T12:00:00.000Z",
            confidence: 0.9,
          }],
          sourceRefs: [{
            type: "PROPOSAL",
            id: "proposal-1",
            label: "Review proposal",
            href: "/workspaces/ws-1/proposals/proposal-1",
          }],
          sourceCounts: { PROPOSAL: 1 },
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
    });

    expect(html).toContain('href="https://app.example.com/workspaces/ws-1/proposals/proposal-1"');
    expect(html).not.toContain('href="/workspaces/ws-1/proposals/proposal-1"');
  });

  it("folds member personalization into prose for workspace briefing email", () => {
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Weekly Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Weekly Workspace Briefing - 2026-07-11",
          period: "WEEKLY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: "The weekly story starts with the strongest operating development.",
          leadMd: "**Factory visit recap**: The team uploaded the most useful operating context from the week.",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: "The weekly meeting remains relevant context for current work.",
          closingMd: "The story is complete without clicking through.",
          editorialMode: "weekly_email",
          freshWindow: { label: "Last 7 days", since: "2026-07-04T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Last 30-90 days", since: "2026-04-12T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [],
          sourceRefs: [],
          sourceCounts: {},
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
      personalization: {
        greeting: "Hi Pat,",
        intro: null,
        memberNote: "For you, the pricing review is the one item to check today.",
        emphasizedSectionIds: ["adviceRequests"],
      },
    });

    expect(html).toContain("For you, the pricing review is the one item to check today.");
    expect(html).not.toContain("Requests Awaiting Your Input");
    expect(html).not.toContain("<ul");
  });

  it("renders narrative markdown links without rendering markdown images in workspace briefing email", () => {
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: null,
          leadMd: "**Workspace update**: Read the [runbook](/workspaces/ws-1/brain/runbook) before acting. ![tracker](https://attacker.example/pixel)",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: null,
          closingMd: null,
          editorialMode: "daily_email",
          freshWindow: { label: "Last 24-36 hours", since: "2026-07-10T00:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Current month context", since: "2026-06-11T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [],
          sourceRefs: [],
          sourceCounts: {},
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
    });

    expect(html).toContain('href="https://app.example.com/workspaces/ws-1/brain/runbook"');
    expect(html).toContain("<strong>Workspace update</strong>");
    expect(html).not.toContain("[runbook]");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
  });

  it("keeps recipient-specific items visible when model personalization omits a member note", () => {
    const recipientDigest = withNewspaperAdviceRequests(normalizeNewspaperDigestPayload({}), [
      [
        "Assigned action: Review the pricing memo",
        "Detail: Confirm the final handoff before Friday.",
        "Open: https://app.example.com/workspaces/ws-1/actions/action-1",
      ].join("\n"),
    ]);
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: null,
          leadMd: "**Workspace update**: The main briefing is complete.",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: null,
          closingMd: null,
          editorialMode: "daily_email",
          freshWindow: { label: "Last 24-36 hours", since: "2026-07-10T00:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Current month context", since: "2026-06-11T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [],
          sourceRefs: [],
          sourceCounts: {},
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
      digest: recipientDigest,
      personalization: {
        greeting: "Hi Pat,",
        intro: null,
        memberNote: null,
        emphasizedSectionIds: [],
      },
    });

    expect(html).toContain("For you: Assigned action: Review the pricing memo");
    expect(html).toContain("Confirm the final handoff before Friday.");
    expect(html).toContain('href="https://app.example.com/workspaces/ws-1/actions/action-1"');
    expect(html).not.toContain("Requests Awaiting Your Input");
    expect(html).not.toContain("<ul");
  });

  it("keeps recipient-specific items visible alongside partial model personalization", () => {
    const recipientDigest = withNewspaperAdviceRequests(normalizeNewspaperDigestPayload({}), [
      "Assigned action: Review the pricing memo\nOpen: https://app.example.com/workspaces/ws-1/actions/action-1",
      "Assigned action: Confirm the launch owner\nOpen: https://app.example.com/workspaces/ws-1/actions/action-2",
    ]);
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: null,
          leadMd: "**Workspace update**: The main briefing is complete.",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: null,
          closingMd: null,
          editorialMode: "daily_email",
          freshWindow: { label: "Last 24-36 hours", since: "2026-07-10T00:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Current month context", since: "2026-06-11T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [],
          sourceRefs: [],
          sourceCounts: {},
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
      digest: recipientDigest,
      personalization: {
        greeting: "Hi Pat,",
        intro: null,
        memberNote: "For you, the pricing review is the one item to check today.",
        emphasizedSectionIds: ["adviceRequests"],
      },
    });

    expect(html).toContain("For you, the pricing review is the one item to check today.");
    expect(html).toContain("Assigned action: Review the pricing memo");
    expect(html).toContain("Assigned action: Confirm the launch owner");
    expect(html).not.toContain("Requests Awaiting Your Input");
    expect(html).not.toContain("<ul");
  });

  it("keeps every retained recipient item in deterministic fallback prose", () => {
    const recipientDigest = withNewspaperAdviceRequests(normalizeNewspaperDigestPayload({}), [
      "Assigned action: First recipient item\nOpen: https://app.example.com/workspaces/ws-1/actions/action-1",
      "Assigned action: Second recipient item\nOpen: https://app.example.com/workspaces/ws-1/actions/action-2",
      "Assigned action: Third recipient item\nOpen: https://app.example.com/workspaces/ws-1/actions/action-3",
      "Assigned action: Fourth recipient item\nOpen: https://app.example.com/workspaces/ws-1/actions/action-4",
    ]);
    const html = renderWorkspaceBriefingEmailHtml({
      briefing: {
        title: "Daily Workspace Briefing - 2026-07-11",
        briefingJson: {
          title: "Daily Workspace Briefing - 2026-07-11",
          period: "DAILY",
          dateKey: "2026-07-11",
          generatedAt: "2026-07-11T12:00:00.000Z",
          introMd: null,
          leadMd: "**Workspace update**: The main briefing is complete.",
          bodyMd: null,
          attentionMd: null,
          continuingContextMd: null,
          closingMd: null,
          editorialMode: "daily_email",
          freshWindow: { label: "Last 24-36 hours", since: "2026-07-10T00:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          contextWindow: { label: "Current month context", since: "2026-06-11T12:00:00.000Z", until: "2026-07-11T12:00:00.000Z" },
          items: [],
          sourceRefs: [],
          sourceCounts: {},
        },
      },
      workspaceName: "Acme",
      recipientName: "Pat",
      workspaceUrl: "https://app.example.com/workspaces/ws-1",
      digest: recipientDigest,
      personalization: {
        greeting: "Hi Pat,",
        intro: null,
        memberNote: null,
        emphasizedSectionIds: [],
      },
    });

    expect(html).toContain("First recipient item");
    expect(html).toContain("Second recipient item");
    expect(html).toContain("Third recipient item");
    expect(html).toContain("Fourth recipient item");
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
