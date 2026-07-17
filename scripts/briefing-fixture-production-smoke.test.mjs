import { describe, expect, it } from "vitest";

import {
  assertBriefingFixturePayload,
  assertDashboardBriefingHtml,
  BriefingFixtureSmoke,
  briefingFixtureHealthReleaseBlocker,
  briefingFixtureTimestamps,
  cleanupFailureMessage,
  normalizeBaseUrl,
  parseSetCookie,
} from "./briefing-fixture-production-smoke.mjs";

function fixture() {
  return {
    title: "Daily Workspace Briefing - 2026-04-30",
    dateKey: "2026-04-30",
    action: { id: "action-1", title: "PROD-VERIFY action" },
    proposal: { id: "proposal-1", title: "PROD-VERIFY proposal" },
    article: { id: "article-1", title: "PROD-VERIFY knowledge" },
  };
}

function briefingPayload() {
  const data = fixture();
  return {
    title: data.title,
    period: "DAILY",
    dateKey: data.dateKey,
    editorialMode: "daily_homepage",
    leadMd: `**${data.action.title}**: Critical blocker decision needs an owner today.`,
    bodyMd: `**${data.article.title}**: Knowledge fixture proves source labels.`,
    attentionMd: `Needs attention today: ${data.proposal.title}: Strategic stale proposal remains open.`,
    continuingContextMd: null,
    sourceCounts: {
      ACTION: 1,
      PROPOSAL: 1,
      BRAIN_ARTICLE: 1,
    },
    items: [
      {
        kind: "ACTION",
        title: data.action.title,
        sourceRefs: [{ type: "ACTION", id: data.action.id, label: data.action.title }],
      },
      {
        kind: "BRAIN_ARTICLE",
        title: data.article.title,
        sourceRefs: [{ type: "BRAIN_ARTICLE", id: data.article.id, label: data.article.title }],
      },
      {
        kind: "PROPOSAL",
        title: data.proposal.title,
        sourceRefs: [{ type: "PROPOSAL", id: data.proposal.id, label: data.proposal.title }],
      },
    ],
    sourceRefs: [
      { type: "ACTION", id: data.action.id, label: data.action.title },
      { type: "BRAIN_ARTICLE", id: data.article.id, label: data.article.title },
      { type: "PROPOSAL", id: data.proposal.id, label: data.proposal.title },
    ],
  };
}

describe("briefing fixture production smoke helpers", () => {
  it("normalizes base URLs and session cookies", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(parseSetCookie("corgtex-session=abc123; Path=/; HttpOnly")).toBe("corgtex-session=abc123");
  });

  it("pins deterministic fresh, stale, and overdue timestamps around the generated briefing time", () => {
    const timestamps = briefingFixtureTimestamps(new Date("2026-04-30T12:00:00.000Z"));

    expect(timestamps.generatedAt.toISOString()).toBe("2026-04-30T12:00:00.000Z");
    expect(timestamps.freshAt.toISOString()).toBe("2026-04-30T11:45:00.000Z");
    expect(timestamps.staleAt.toISOString()).toBe("2026-03-16T12:00:00.000Z");
    expect(timestamps.overdueAt.toISOString()).toBe("2026-04-30T11:00:00.000Z");
  });

  it("blocks before fixture writes when release metadata drifts", () => {
    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("release.gitSha older-sha");

    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "older-sha" },
        drift: {
          gitSha: true,
          imageTag: false,
          version: false,
          details: ["configured.gitSha=older-sha does not match runtime.gitSha=current-sha"],
        },
      },
    }, "current-sha")).toContain("configured.gitSha=older-sha");
  });

  it("accepts aligned release metadata", () => {
    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "current-sha" },
        drift: {
          gitSha: false,
          imageTag: false,
          version: false,
          details: [],
        },
      },
    }, "current-sha")).toBeNull();
  });
});

describe("briefing fixture production smoke assertions", () => {
  it("requires fresh action lead, stale proposal context, source labels, and homepage mode", () => {
    const summary = assertBriefingFixturePayload(briefingPayload(), fixture());

    expect(summary.actionItem.title).toBe("PROD-VERIFY action");
    expect(summary.proposalItem.title).toBe("PROD-VERIFY proposal");
    expect(summary.articleItem.title).toBe("PROD-VERIFY knowledge");
  });

  it("fails when stale proposals are promoted into fresh body copy", () => {
    const payload = briefingPayload();
    payload.bodyMd = `${payload.bodyMd}\n\n${fixture().proposal.title}`;

    expect(() => assertBriefingFixturePayload(payload, fixture())).toThrow("Stale proposal was presented as fresh body content.");
  });

  it("asserts dashboard HTML displays the generated briefing and fixture items", () => {
    const data = fixture();

    expect(assertDashboardBriefingHtml(`
      <main>
        <h2>${data.title}</h2>
        <p>${data.action.title}</p>
        <p>${data.proposal.title}</p>
      </main>
    `, data)).toBe(true);
  });
});

describe("briefing fixture production smoke validation matrix", () => {
  it("records one validation result per covered PR number", () => {
    const smoke = new BriefingFixtureSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-briefing-fixture-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      prNumbers: [723, 724],
      prisma: {},
      generatedAt: "2026-04-30T12:00:00.000Z",
    });
    smoke.created = {
      action: { id: "action-1", cleanupActionId: "archive:Action:action-1" },
      proposal: { id: "proposal-1", cleanupActionId: "archive:Proposal:proposal-1" },
      article: { id: "article-1", cleanupActionId: "archive:BrainArticle:article-1" },
      briefing: { id: "briefing-1", cleanupActionId: "delete:WorkspaceBriefing:briefing-1" },
    };

    smoke.recordValidationPass();

    expect(smoke.validationRun.results).toHaveLength(2);
    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([723, 724]);
    expect(smoke.validationRun.results[0]).toMatchObject({
      result: "pass",
      createdRecordIds: ["action-1", "proposal-1", "article-1", "briefing-1"],
    });
  });

  it("describes cleanup failures so the smoke cannot pass with dirty fixture records", () => {
    expect(cleanupFailureMessage({
      failed: [
        { entry: { id: "restore:WorkspaceBriefing:briefing-1" } },
        { entry: { id: "archive:Action:action-1" } },
      ],
    })).toBe("Validation cleanup failed for restore:WorkspaceBriefing:briefing-1, archive:Action:action-1");
  });
});
