import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBriefingCandidate } from "./workspace-briefing";

const {
  prismaMock,
  requireWorkspaceMembershipMock,
} = vi.hoisted(() => ({
  prismaMock: {
    meeting: { findMany: vi.fn() },
    proposal: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    goal: { findMany: vi.fn() },
    recognition: { findMany: vi.fn() },
    brainArticle: { findMany: vi.fn() },
    document: { findMany: vi.fn() },
    communicationContextSummary: { findMany: vi.fn() },
    buildArtifact: { findMany: vi.fn() },
    adviceRequest: { findMany: vi.fn() },
    workspaceBriefing: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

function baseCandidate(overrides: Partial<WorkspaceBriefingCandidate>): WorkspaceBriefingCandidate {
  return {
    sourceType: "BRAIN_ARTICLE",
    sourceId: "source-1",
    title: "Reference update",
    summaryMd: "Reference context.",
    href: "/workspaces/ws-1/brain/reference",
    occurredAt: new Date("2026-04-20T12:00:00.000Z"),
    updatedAt: new Date("2026-04-20T12:00:00.000Z"),
    strategicScore: 1,
    actionabilityScore: 0,
    evidenceScore: 1,
    sourceRefs: [{ type: "BRAIN_ARTICLE", id: "source-1", label: "Reference update", href: "/workspaces/ws-1/brain/reference" }],
    ...overrides,
  };
}

describe("workspace briefing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
    for (const model of [
      prismaMock.meeting,
      prismaMock.proposal,
      prismaMock.tension,
      prismaMock.action,
      prismaMock.goal,
      prismaMock.recognition,
      prismaMock.brainArticle,
      prismaMock.document,
      prismaMock.communicationContextSummary,
      prismaMock.buildArtifact,
      prismaMock.adviceRequest,
    ]) {
      model.findMany.mockResolvedValue([]);
    }
    prismaMock.workspaceBriefing.upsert.mockImplementation(async ({ create }: any) => ({ id: "briefing-1", ...create }));
    prismaMock.workspaceBriefing.findFirst.mockResolvedValue(null);
  });

  it("ranks actionable, time-sensitive candidates as lead briefing items", async () => {
    const {
      buildWorkspaceBriefingFromCandidates,
    } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({ title: "Low-signal reference" }),
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-1",
          title: "Confirm launch owner",
          summaryMd: "Ownership must be confirmed before launch.",
          href: "/workspaces/ws-1/actions/action-1",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          dueAt: new Date("2026-04-29T12:00:00.000Z"),
          strategicScore: 2,
          actionabilityScore: 4,
          evidenceScore: 2,
          sourceRefs: [{ type: "ACTION", id: "action-1", label: "Confirm launch owner", href: "/workspaces/ws-1/actions/action-1" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "ACTION",
      title: "Confirm launch owner",
      prominence: "lead",
    }));
    expect(briefing.sourceRefs).toContainEqual(expect.objectContaining({ type: "ACTION", id: "action-1" }));
  });

  it("keeps stale open proposals from outranking newer active tensions", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-old",
          title: "Old open proposal",
          summaryMd: "An old proposal remains open without recent movement.",
          href: "/workspaces/ws-1/proposals/proposal-old",
          occurredAt: new Date("2026-03-20T12:00:00.000Z"),
          updatedAt: new Date("2026-03-20T12:00:00.000Z"),
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-old", label: "Old open proposal", href: "/workspaces/ws-1/proposals/proposal-old" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-new",
          title: "New implementation blocker",
          summaryMd: "A fresh tension is blocking the implementation decision.",
          href: "/workspaces/ws-1/tensions/tension-new",
          occurredAt: new Date("2026-04-30T09:00:00.000Z"),
          updatedAt: new Date("2026-04-30T09:00:00.000Z"),
          status: "OPEN",
          strategicScore: 2,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "TENSION", id: "tension-new", label: "New implementation blocker", href: "/workspaces/ws-1/tensions/tension-new" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "TENSION",
      title: "New implementation blocker",
      prominence: "lead",
    }));
    expect(briefing.items.map((item) => item.title)).toContain("Old open proposal");
  });

  it("promotes recent decision-shaping tensions above older proposals and routine zero-percent goals", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-current",
          title: "Team alignment proposal",
          summaryMd: "A proposal from last week still needs input.",
          href: "/workspaces/ws-1/proposals/proposal-current",
          occurredAt: new Date("2026-04-25T12:00:00.000Z"),
          updatedAt: new Date("2026-04-25T12:00:00.000Z"),
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-current", label: "Team alignment proposal", href: "/workspaces/ws-1/proposals/proposal-current" }],
        }),
        baseCandidate({
          sourceType: "GOAL",
          sourceId: "goal-routine",
          title: "Recruit feedback participants",
          summaryMd: "0% complete: Recruit a few people to provide feedback.",
          href: "/workspaces/ws-1/goals",
          occurredAt: new Date("2026-04-28T12:00:00.000Z"),
          updatedAt: new Date("2026-04-28T12:00:00.000Z"),
          status: "ACTIVE",
          strategicScore: 4,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "GOAL", id: "goal-routine", label: "Recruit feedback participants", href: "/workspaces/ws-1/goals" }],
        }),
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-stale",
          title: "Older marketing proposal",
          summaryMd: "An older proposal remains open without recent evidence.",
          href: "/workspaces/ws-1/proposals/proposal-stale",
          occurredAt: new Date("2026-04-02T12:00:00.000Z"),
          updatedAt: new Date("2026-04-02T12:00:00.000Z"),
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-stale", label: "Older marketing proposal", href: "/workspaces/ws-1/proposals/proposal-stale" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-critical",
          title: "Critical assumptions not being reviewed in weekly meetings",
          summaryMd: "Critical assumptions are visible on the dashboard but are not being reviewed in weekly meetings.",
          href: "/workspaces/ws-1/tensions/tension-critical",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "PUBLISHED",
          strategicScore: 1,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "TENSION", id: "tension-critical", label: "Critical assumptions not being reviewed in weekly meetings", href: "/workspaces/ws-1/tensions/tension-critical" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "TENSION",
      title: "Critical assumptions not being reviewed in weekly meetings",
      prominence: "lead",
    }));
    expect(briefing.items.findIndex((item) => item.title === "Recruit feedback participants")).toBeGreaterThan(0);
    expect(briefing.items.findIndex((item) => item.title === "Older marketing proposal")).toBeGreaterThan(0);
  });

  it("does not boost canceled advice requests or draft tensions", async () => {
    const { scoreWorkspaceBriefingCandidate } = await import("./workspace-briefing");
    const now = new Date("2026-04-30T12:00:00.000Z");
    const activeAdviceScore = scoreWorkspaceBriefingCandidate(baseCandidate({
      sourceType: "ADVICE_REQUEST",
      sourceId: "advice-active",
      title: "Critical review needed",
      summaryMd: "Waiting on critical review before a decision can move forward.",
      occurredAt: new Date("2026-04-30T10:00:00.000Z"),
      updatedAt: new Date("2026-04-30T10:00:00.000Z"),
      status: "ACTIVE",
      strategicScore: 2,
      actionabilityScore: 4,
      evidenceScore: 2,
      sourceRefs: [{ type: "ADVICE_REQUEST", id: "advice-active", label: "Critical review needed", href: "/workspaces/ws-1/proposals/p1" }],
    }), now);
    const canceledAdviceScore = scoreWorkspaceBriefingCandidate(baseCandidate({
      sourceType: "ADVICE_REQUEST",
      sourceId: "advice-canceled",
      title: "Critical review needed",
      summaryMd: "Waiting on critical review before a decision can move forward.",
      occurredAt: new Date("2026-04-30T10:00:00.000Z"),
      updatedAt: new Date("2026-04-30T10:00:00.000Z"),
      status: "CANCELED",
      strategicScore: 2,
      actionabilityScore: 4,
      evidenceScore: 2,
      sourceRefs: [{ type: "ADVICE_REQUEST", id: "advice-canceled", label: "Critical review needed", href: "/workspaces/ws-1/proposals/p1" }],
    }), now);
    const draftTensionScore = scoreWorkspaceBriefingCandidate(baseCandidate({
      sourceType: "TENSION",
      sourceId: "tension-draft",
      title: "Critical draft tension",
      summaryMd: "A critical draft has not been published.",
      occurredAt: new Date("2026-04-30T10:00:00.000Z"),
      updatedAt: new Date("2026-04-30T10:00:00.000Z"),
      status: "DRAFT",
      strategicScore: 1,
      actionabilityScore: 1,
      evidenceScore: 2,
      sourceRefs: [{ type: "TENSION", id: "tension-draft", label: "Critical draft tension", href: "/workspaces/ws-1/tensions/tension-draft" }],
    }), now);

    expect(activeAdviceScore).toBeGreaterThan(canceledAdviceScore);
    expect(activeAdviceScore).toBeGreaterThan(draftTensionScore);
  });

  it("keeps fresh resolved decision context above stale reference goals", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "GOAL",
          sourceId: "goal-old",
          title: "Maintain strategic glossary",
          summaryMd: "0% complete. This is stable reference context.",
          href: "/workspaces/ws-1/goals/goal-old",
          occurredAt: new Date("2026-03-10T12:00:00.000Z"),
          updatedAt: new Date("2026-03-10T12:00:00.000Z"),
          status: "ACTIVE",
          strategicScore: 4,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "GOAL", id: "goal-old", label: "Maintain strategic glossary", href: "/workspaces/ws-1/goals/goal-old" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-resolved",
          title: "Critical assumptions not being reviewed in weekly meetings",
          summaryMd: "Critical assumptions were reviewed and the tension was resolved today.",
          href: "/workspaces/ws-1/tensions/tension-resolved",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "RESOLVED",
          strategicScore: 0,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "TENSION", id: "tension-resolved", label: "Critical assumptions not being reviewed in weekly meetings", href: "/workspaces/ws-1/tensions/tension-resolved" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "TENSION",
      title: "Critical assumptions not being reviewed in weekly meetings",
      prominence: "lead",
    }));
  });

  it("renders completed advice requests as closed input context", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "ADVICE_REQUEST",
          sourceId: "request-completed",
          title: "Advice request completed",
          summaryMd: "The support risk decision was completed.",
          href: "/workspaces/ws-1/proposals/proposal-1",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 2,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "ADVICE_REQUEST", id: "request-completed", label: "Advice request completed", href: "/workspaces/ws-1/proposals/proposal-1" }],
        }),
      ],
    });

    expect(briefing.items[0].whyItMattersMd).toBe("This records input or advice that was closed recently.");
    expect(briefing.items[0].status).toBe("COMPLETED");
  });

  it("applies boosted candidate ranking to digest-derived briefing order", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [
          {
            id: "decisionsAndProposals",
            title: "Decisions & Proposals",
            items: ["Team alignment proposal: A proposal from last week still needs input."],
          },
          {
            id: "emergingTensions",
            title: "Emerging Tensions",
            items: ["Critical assumptions not being reviewed in weekly meetings: Critical assumptions are visible on the dashboard but are not being reviewed."],
          },
        ],
      },
      candidates: [
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-current",
          title: "Team alignment proposal",
          summaryMd: "A proposal from last week still needs input.",
          href: "/workspaces/ws-1/proposals/proposal-current",
          occurredAt: new Date("2026-04-25T12:00:00.000Z"),
          updatedAt: new Date("2026-04-25T12:00:00.000Z"),
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-current", label: "Team alignment proposal", href: "/workspaces/ws-1/proposals/proposal-current" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-critical",
          title: "Critical assumptions not being reviewed in weekly meetings",
          summaryMd: "Critical assumptions are visible on the dashboard but are not being reviewed.",
          href: "/workspaces/ws-1/tensions/tension-critical",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "PUBLISHED",
          strategicScore: 1,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "TENSION", id: "tension-critical", label: "Critical assumptions not being reviewed in weekly meetings", href: "/workspaces/ws-1/tensions/tension-critical" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "TENSION",
      title: "Critical assumptions not being reviewed in weekly meetings",
      prominence: "lead",
    }));
  });

  it("carries unmatched unresolved context into digest-derived briefings", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [
          {
            id: "meetingBriefs",
            title: "Meeting Briefs",
            items: ["Weekly operating review uploaded today: The team aligned follow-up priorities from the newest meeting notes."],
          },
        ],
      },
      candidates: [
        baseCandidate({
          sourceType: "MEETING",
          sourceId: "meeting-current",
          title: "Weekly operating review uploaded today",
          summaryMd: "The team aligned follow-up priorities from the newest meeting notes.",
          href: "/workspaces/ws-1/meetings/meeting-current",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 5,
          actionabilityScore: 5,
          evidenceScore: 5,
          sourceRefs: [{ type: "MEETING", id: "meeting-current", label: "Weekly operating review uploaded today", href: "/workspaces/ws-1/meetings/meeting-current" }],
        }),
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-continuing",
          title: "Strategic operating proposal still needs a decision",
          summaryMd: "The proposal is older than the fresh window, but it remains unresolved and still changes what the team needs to know this week.",
          href: "/workspaces/ws-1/proposals/proposal-continuing",
          occurredAt: new Date("2026-04-12T12:00:00.000Z"),
          updatedAt: new Date("2026-04-12T12:00:00.000Z"),
          status: "OPEN",
          priority: 4,
          strategicScore: 5,
          actionabilityScore: 4,
          evidenceScore: 4,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-continuing", label: "Strategic operating proposal still needs a decision", href: "/workspaces/ws-1/proposals/proposal-continuing" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "MEETING",
      title: "Weekly operating review uploaded today",
    }));
    expect(briefing.items).toContainEqual(expect.objectContaining({
      kind: "PROPOSAL",
      title: "Strategic operating proposal still needs a decision",
    }));
    expect([
      briefing.leadMd,
      briefing.bodyMd,
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].filter(Boolean).join("\n")).toContain("Strategic operating proposal still needs a decision");
    expect(briefing.sourceRefs).toContainEqual(expect.objectContaining({
      type: "PROPOSAL",
      id: "proposal-continuing",
    }));
  });

  it("carries unmatched at-risk goals into digest-derived briefings", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "WEEKLY",
      dateKey: "2026-04-30",
      title: "Weekly Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [{
          id: "meetingBriefs",
          title: "Meeting Briefs",
          items: ["Weekly operating review uploaded today: The team aligned follow-up priorities."],
        }],
      },
      candidates: [
        baseCandidate({
          sourceType: "MEETING",
          sourceId: "meeting-current",
          title: "Weekly operating review uploaded today",
          summaryMd: "The team aligned follow-up priorities.",
          href: "/workspaces/ws-1/meetings/meeting-current",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 4,
          actionabilityScore: 4,
          evidenceScore: 4,
          sourceRefs: [{ type: "MEETING", id: "meeting-current", label: "Weekly operating review uploaded today", href: "/workspaces/ws-1/meetings/meeting-current" }],
        }),
        baseCandidate({
          sourceType: "GOAL",
          sourceId: "goal-at-risk",
          title: "Quarterly retention goal is behind",
          summaryMd: "The goal is at risk and still affects current operating priorities.",
          href: "/workspaces/ws-1/goals/goal-at-risk",
          occurredAt: new Date("2026-04-01T12:00:00.000Z"),
          updatedAt: new Date("2026-04-20T12:00:00.000Z"),
          status: "AT_RISK",
          priority: 3,
          strategicScore: 5,
          actionabilityScore: 3,
          evidenceScore: 4,
          sourceRefs: [{ type: "GOAL", id: "goal-at-risk", label: "Quarterly retention goal is behind", href: "/workspaces/ws-1/goals/goal-at-risk" }],
        }),
      ],
    });

    expect(briefing.items).toContainEqual(expect.objectContaining({
      kind: "GOAL",
      title: "Quarterly retention goal is behind",
    }));
    expect([
      briefing.leadMd,
      briefing.bodyMd,
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].filter(Boolean).join("\n")).toContain("Quarterly retention goal is behind");
  });

  it("does not carry forward paraphrased candidates already represented by digest text", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [{
          id: "openActions",
          title: "Open Actions",
          items: ["Launch ownership remains unresolved before the customer rollout and needs one accountable owner."],
        }],
      },
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-owner",
          title: "Confirm launch owner",
          summaryMd: "Ownership remains unresolved before the customer rollout and needs one accountable owner.",
          href: "/workspaces/ws-1/actions/action-owner",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          strategicScore: 4,
          actionabilityScore: 5,
          evidenceScore: 4,
          sourceRefs: [{ type: "ACTION", id: "action-owner", label: "Confirm launch owner", href: "/workspaces/ws-1/actions/action-owner" }],
        }),
      ],
    });

    expect(briefing.items).toHaveLength(1);
    expect(briefing.sourceRefs).toContainEqual(expect.objectContaining({
      type: "ACTION",
      id: "action-owner",
    }));
  });

  it("uses weekly timing language for weekly attention items", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "WEEKLY",
      dateKey: "2026-04-30",
      title: "Weekly Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        ...Array.from({ length: 6 }, (_, index) => baseCandidate({
          sourceType: "MEETING" as const,
          sourceId: `meeting-${index + 1}`,
          title: `Weekly operating review ${index + 1}`,
          summaryMd: `The meeting recapped important operating work ${index + 1}.`,
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 5,
          actionabilityScore: 4,
          evidenceScore: 5,
          sourceRefs: [{ type: "MEETING", id: `meeting-${index + 1}`, label: `Weekly operating review ${index + 1}`, href: `/workspaces/ws-1/meetings/meeting-${index + 1}` }],
        })),
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-weekly",
          title: "Resolve weekly delivery blocker",
          summaryMd: "The blocker still affects work this week.",
          occurredAt: new Date("2026-04-20T10:00:00.000Z"),
          updatedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          strategicScore: 1,
          actionabilityScore: 1,
          evidenceScore: 1,
          sourceRefs: [{ type: "ACTION", id: "action-weekly", label: "Resolve weekly delivery blocker", href: "/workspaces/ws-1/actions/action-weekly" }],
        }),
      ],
    });

    expect(briefing.attentionMd).toContain("Needs attention this week");
    expect(briefing.attentionMd).not.toContain("Needs attention today");
  });

  it("keeps digest introduction in the intro slot and only promises source trail when refs exist", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: "The generated intro explains the day in one sentence.",
        sections: [{
          id: "meetingBriefs",
          title: "Meeting Briefs",
          items: ["The meeting surfaced a customer-readiness decision."],
        }],
      },
      candidates: [],
    });

    expect(briefing.introMd).toBe("The generated intro explains the day in one sentence.");
    expect(briefing.continuingContextMd ?? "").not.toContain("The generated intro");
    expect(briefing.sourceRefs).toEqual([]);
    expect(briefing.closingMd).not.toContain("source trail below");
  });

  it("does not repeat the same active item across narrative blocks", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-urgent",
          title: "Confirm launch owner",
          summaryMd: "Ownership must be confirmed before launch.",
          href: "/workspaces/ws-1/actions/action-urgent",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          dueAt: new Date("2026-04-29T12:00:00.000Z"),
          strategicScore: 3,
          actionabilityScore: 5,
          evidenceScore: 4,
          sourceRefs: [{ type: "ACTION", id: "action-urgent", label: "Confirm launch owner", href: "/workspaces/ws-1/actions/action-urgent" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-1",
          title: "Resolve support readiness tension",
          summaryMd: "The support readiness risk still needs a decision.",
          href: "/workspaces/ws-1/tensions/tension-1",
          occurredAt: new Date("2026-04-22T12:00:00.000Z"),
          updatedAt: new Date("2026-04-22T12:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          strategicScore: 4,
          actionabilityScore: 3,
          evidenceScore: 3,
          sourceRefs: [{ type: "TENSION", id: "tension-1", label: "Resolve support readiness tension", href: "/workspaces/ws-1/tensions/tension-1" }],
        }),
      ],
    });
    const narrative = [
      briefing.leadMd,
      briefing.bodyMd,
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].filter(Boolean).join("\n");

    expect(narrative.match(/Confirm launch owner/g)).toHaveLength(1);
  });

  it("keeps stale strategic work visible without making it the lead", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-urgent",
          title: "Confirm launch owner",
          summaryMd: "Ownership must be confirmed before launch.",
          href: "/workspaces/ws-1/actions/action-urgent",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          dueAt: new Date("2026-04-29T12:00:00.000Z"),
          strategicScore: 2,
          actionabilityScore: 4,
          evidenceScore: 2,
          sourceRefs: [{ type: "ACTION", id: "action-urgent", label: "Confirm launch owner", href: "/workspaces/ws-1/actions/action-urgent" }],
        }),
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-strategic",
          title: "Strategic market entry proposal",
          summaryMd: "A strategic proposal remains open and still matters.",
          href: "/workspaces/ws-1/proposals/proposal-strategic",
          occurredAt: new Date("2026-03-10T12:00:00.000Z"),
          updatedAt: new Date("2026-03-10T12:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          strategicScore: 3,
          actionabilityScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-strategic", label: "Strategic market entry proposal", href: "/workspaces/ws-1/proposals/proposal-strategic" }],
        }),
      ],
    });

    expect(briefing.items[0].title).toBe("Confirm launch owner");
    expect(briefing.items[1]).toEqual(expect.objectContaining({
      title: "Strategic market entry proposal",
      prominence: "standard",
    }));
  });

  it("frames all-stale editions as continuing context instead of a fresh lead", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-stale",
          title: "Strategic market entry proposal",
          summaryMd: "A strategic proposal remains open and still matters.",
          href: "/workspaces/ws-1/proposals/proposal-stale",
          occurredAt: new Date("2026-03-10T12:00:00.000Z"),
          updatedAt: new Date("2026-03-10T12:00:00.000Z"),
          status: "OPEN",
          priority: 3,
          strategicScore: 5,
          actionabilityScore: 4,
          evidenceScore: 3,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-stale", label: "Strategic market entry proposal", href: "/workspaces/ws-1/proposals/proposal-stale" }],
        }),
      ],
    });

    expect(briefing.introMd).toContain("found no fresh operating signal");
    expect(briefing.leadMd).toContain("No major new operating signal");
    expect([
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].filter(Boolean).join("\n")).toContain("Strategic market entry proposal");
  });

  it("uses narrative text instead of mechanical source counts or visible categories", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "PROPOSAL",
          sourceId: "proposal-1",
          title: "Proposal update",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-1", label: "Proposal update", href: "/workspaces/ws-1/proposals/proposal-1" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-1",
          title: "Active tension",
          occurredAt: new Date("2026-04-30T09:00:00.000Z"),
          updatedAt: new Date("2026-04-30T09:00:00.000Z"),
          status: "OPEN",
          strategicScore: 2,
          actionabilityScore: 3,
          sourceRefs: [{ type: "TENSION", id: "tension-1", label: "Active tension", href: "/workspaces/ws-1/tensions/tension-1" }],
        }),
        baseCandidate({
          sourceType: "GOAL",
          sourceId: "goal-1",
          title: "Strategic goal",
          occurredAt: new Date("2026-04-30T08:00:00.000Z"),
          updatedAt: new Date("2026-04-30T08:00:00.000Z"),
          strategicScore: 4,
          actionabilityScore: 1,
          sourceRefs: [{ type: "GOAL", id: "goal-1", label: "Strategic goal", href: "/workspaces/ws-1/goals" }],
        }),
      ],
    });

    expect(briefing.introMd).toContain("strongest signal");
    expect(briefing.leadMd).toContain("**");
    expect([
      briefing.bodyMd,
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].filter(Boolean).join("\n")).toContain("**");
    expect(briefing.introMd).not.toContain("1 proposal");
    expect([
      briefing.introMd,
      briefing.leadMd,
      briefing.bodyMd,
      briefing.attentionMd,
      briefing.continuingContextMd,
    ].join("\n")).not.toMatch(/Meeting Briefs|Open Actions|Open Proposals|Action Items/);
  });

  it("formats source labels for homepage display", async () => {
    const { workspaceBriefingSourceLabel } = await import("./workspace-briefing");

    expect(workspaceBriefingSourceLabel("ADVICE_REQUEST")).toBe("Advice request");
    expect(workspaceBriefingSourceLabel("BRAIN_ARTICLE")).toBe("Knowledge");
    expect(workspaceBriefingSourceLabel("custom_source")).toBe("Custom Source");
  });

  it("collects only public workspace work items and requires membership when an actor is supplied", async () => {
    const { collectWorkspaceBriefingCandidates } = await import("./workspace-briefing");

    await collectWorkspaceBriefingCandidates({
      workspaceId: "ws-1",
      since: new Date("2026-04-29T00:00:00.000Z"),
      actor: { kind: "user", user: { id: "user-1", email: "u@example.com", displayName: "User" } },
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    expect(prismaMock.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null }),
    }));
    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null }),
    }));
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null, status: { in: ["OPEN", "IN_PROGRESS"] } }),
    }));
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", archivedAt: null, status: "COMPLETED" }),
    }));
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null }),
    }));
    const adviceRequestCalls = prismaMock.adviceRequest.findMany.mock.calls.map(([args]) => args);
    expect(adviceRequestCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          audienceType: "WORKSPACE",
          status: "ACTIVE",
        }),
        take: 30,
      }),
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          audienceType: "WORKSPACE",
          status: "COMPLETED",
          OR: [
            { completedAt: { gte: new Date("2026-04-29T00:00:00.000Z") } },
            { updatedAt: { gte: new Date("2026-04-29T00:00:00.000Z") } },
          ],
        }),
        take: 10,
      }),
    ]));
  });

  it("does not attach unrelated source refs to digest-derived sections", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");

    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [{
          id: "meetingBriefs",
          title: "Meeting Briefs",
          items: ["The meeting surfaced a customer-readiness decision."],
        }],
      },
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-1",
          title: "Unrelated action",
          href: "/workspaces/ws-1/actions/action-1",
          sourceRefs: [{ type: "ACTION", id: "action-1", label: "Unrelated action", href: "/workspaces/ws-1/actions/action-1" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "MEETING",
      title: "The meeting surfaced a customer-readiness decision",
      href: null,
      sourceRefs: [],
    }));
  });

  it("does not attach same-kind source refs unless the digest item matches the source", async () => {
    const { buildWorkspaceBriefingFromDigest } = await import("./workspace-briefing");

    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [{
          id: "openActions",
          title: "Open Actions",
          items: ["Confirm the customer rollout owner before launch."],
        }],
      },
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-1",
          title: "Prepare vendor contract",
          summaryMd: "Legal needs a procurement contract by Friday.",
          href: "/workspaces/ws-1/actions/action-1",
          sourceRefs: [{ type: "ACTION", id: "action-1", label: "Prepare vendor contract", href: "/workspaces/ws-1/actions/action-1" }],
        }),
      ],
    });

    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "ACTION",
      title: "Confirm the customer rollout owner before launch",
      href: null,
      sourceRefs: [],
    }));
  });

  it("links workspace advice requests to their actual subject", async () => {
    const { collectWorkspaceBriefingCandidates } = await import("./workspace-briefing");
    prismaMock.adviceRequest.findMany.mockResolvedValueOnce([{
      id: "request-1",
      messageMd: "Please advise on the support risk.",
      status: "ACTIVE",
      deadlineAt: null,
      completedAt: null,
      createdAt: new Date("2026-04-30T08:00:00.000Z"),
      updatedAt: new Date("2026-04-30T09:00:00.000Z"),
      process: { subjectType: "TENSION", subjectId: "tension-1" },
    }]).mockResolvedValueOnce([{
      id: "request-2",
      messageMd: "The support risk decision was completed.",
      status: "COMPLETED",
      deadlineAt: null,
      completedAt: new Date("2026-04-30T10:00:00.000Z"),
      createdAt: new Date("2026-04-29T08:00:00.000Z"),
      updatedAt: new Date("2026-04-30T10:00:00.000Z"),
      process: { subjectType: "PROPOSAL", subjectId: "proposal-1" },
    }]);

    const candidates = await collectWorkspaceBriefingCandidates({
      workspaceId: "ws-1",
      since: new Date("2026-04-29T00:00:00.000Z"),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "ADVICE_REQUEST",
        sourceId: "request-1",
        title: "Advice request awaiting input",
        href: "/workspaces/ws-1/tensions/tension-1",
      }),
      expect.objectContaining({
        sourceType: "ADVICE_REQUEST",
        sourceId: "request-2",
        title: "Advice request completed",
        href: "/workspaces/ws-1/proposals/proposal-1",
        occurredAt: new Date("2026-04-30T10:00:00.000Z"),
        dueAt: null,
      }),
    ]));
  });

  it("creates an honest quiet briefing when there are no candidates", async () => {
    const { buildWorkspaceBriefingFromCandidates } = await import("./workspace-briefing");

    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      candidates: [],
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
    });

    expect(briefing.items).toHaveLength(1);
    expect(briefing.items[0]).toEqual(expect.objectContaining({
      kind: "QUIET",
      prominence: "lead",
    }));
    expect(briefing.items[0].summaryMd).toContain("No new high-signal");
  });

  it("renders briefing markdown as narrative instead of source-category sections", async () => {
    const { buildWorkspaceBriefingFromCandidates, renderWorkspaceBriefingMarkdown } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "ACTION",
          sourceId: "action-1",
          title: "Review launch",
          summaryMd: "Review the launch decision with the team today.",
          status: "OPEN",
          strategicScore: 2,
          actionabilityScore: 4,
          sourceRefs: [{ type: "ACTION", id: "action-1", label: "Review launch", href: "/workspaces/ws-1/actions/action-1" }],
        }),
      ],
    });

    const markdown = renderWorkspaceBriefingMarkdown(briefing);

    expect(markdown).toContain("Review the launch decision");
    expect(markdown).toContain("## Source trail");
    expect(markdown).not.toMatch(/## Open Actions|## Meeting Briefs|## Action Items Identified/);
  });

  it("uses upload freshness instead of future meeting dates for ranking", async () => {
    const { collectWorkspaceBriefingCandidates } = await import("./workspace-briefing");
    prismaMock.meeting.findMany.mockResolvedValueOnce([{
      id: "meeting-future",
      title: "Weekly operations recap",
      summaryMd: "The team uploaded a weekly recap today.",
      recordedAt: new Date("2099-01-01T12:00:00.000Z"),
      updatedAt: new Date("2026-04-30T09:00:00.000Z"),
      createdAt: new Date("2026-04-30T08:00:00.000Z"),
      summaryPostedAt: new Date("2026-04-30T10:00:00.000Z"),
      aiProcessedAt: new Date("2026-04-30T09:30:00.000Z"),
      decisionsJson: null,
    }]);

    const candidates = await collectWorkspaceBriefingCandidates({
      workspaceId: "ws-1",
      since: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "MEETING",
        sourceId: "meeting-future",
        occurredAt: new Date("2026-04-30T10:00:00.000Z"),
      }),
    ]));
  });

  it("compares future meetings against the briefing edition timestamp on retries", async () => {
    const { collectWorkspaceBriefingCandidates } = await import("./workspace-briefing");
    prismaMock.meeting.findMany.mockResolvedValueOnce([{
      id: "meeting-after-edition",
      title: "Future meeting for historical edition",
      summaryMd: "The recap was uploaded after the edition cutoff.",
      recordedAt: new Date("2026-05-01T12:00:00.000Z"),
      updatedAt: new Date("2026-04-30T09:00:00.000Z"),
      createdAt: new Date("2026-04-30T08:00:00.000Z"),
      summaryPostedAt: null,
      aiProcessedAt: null,
      decisionsJson: null,
    }]);

    const candidates = await collectWorkspaceBriefingCandidates({
      workspaceId: "ws-1",
      since: new Date("2026-04-01T00:00:00.000Z"),
      now: new Date("2026-04-30T12:00:00.000Z"),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "MEETING",
        sourceId: "meeting-after-edition",
        occurredAt: new Date("2026-04-30T09:00:00.000Z"),
      }),
    ]));
  });

  it("converts briefing narrative into the shared newsletter digest shape", async () => {
    const { buildWorkspaceBriefingFromCandidates, workspaceBriefingToNewspaperDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "BUILD_ARTIFACT",
          sourceId: "build-1",
          title: "Homepage briefing shipped",
          summaryMd: "The new briefing surface shipped.",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          strategicScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "BUILD_ARTIFACT", id: "build-1", label: "Homepage briefing shipped", href: "https://github.com/example/pull/1" }],
        }),
      ],
    });

    const digest = workspaceBriefingToNewspaperDigest(briefing);

    expect(digest.sections).toEqual([
      expect.objectContaining({
        id: "otherUpdates",
        title: "Workspace Narrative",
        items: expect.arrayContaining([expect.stringContaining("The new briefing surface shipped.")]),
      }),
    ]);
    expect(digest.sections[0]?.title).not.toBe("Built / Shipped Work");
  });

  it("routes completed advice requests to neutral newsletter updates", async () => {
    const { buildWorkspaceBriefingFromCandidates, workspaceBriefingToNewspaperDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [
        baseCandidate({
          sourceType: "ADVICE_REQUEST",
          sourceId: "request-completed",
          title: "Advice request completed",
          summaryMd: "The support risk decision was completed.",
          href: "/workspaces/ws-1/proposals/proposal-1",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 2,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "ADVICE_REQUEST", id: "request-completed", label: "Advice request completed", href: "/workspaces/ws-1/proposals/proposal-1" }],
        }),
      ],
    });

    const digest = workspaceBriefingToNewspaperDigest(briefing);

    expect(digest.sections).toEqual([
      expect.objectContaining({
        id: "otherUpdates",
        title: "Workspace Narrative",
        items: expect.arrayContaining([expect.stringContaining("The support risk decision was completed.")]),
      }),
    ]);
    expect(digest.sections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "adviceRequests" }),
    ]));
  });

  it("preserves completed advice status for digest-derived newsletter routing", async () => {
    const { buildWorkspaceBriefingFromDigest, workspaceBriefingToNewspaperDigest } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromDigest({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      digest: {
        intro: null,
        sections: [{
          id: "adviceRequests",
          title: "Requests Awaiting Your Input",
          items: ["Advice request completed: The support risk decision was completed."],
        }],
      },
      candidates: [
        baseCandidate({
          sourceType: "ADVICE_REQUEST",
          sourceId: "request-completed",
          title: "Advice request completed",
          summaryMd: "The support risk decision was completed.",
          href: "/workspaces/ws-1/proposals/proposal-1",
          occurredAt: new Date("2026-04-30T10:00:00.000Z"),
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          status: "COMPLETED",
          strategicScore: 2,
          actionabilityScore: 1,
          evidenceScore: 2,
          sourceRefs: [{ type: "ADVICE_REQUEST", id: "request-completed", label: "Advice request completed", href: "/workspaces/ws-1/proposals/proposal-1" }],
        }),
      ],
    });

    const digest = workspaceBriefingToNewspaperDigest(briefing);

    expect(briefing.items[0].status).toBe("COMPLETED");
    expect(digest.sections).toEqual([
      expect.objectContaining({
        id: "otherUpdates",
        title: "Workspace Narrative",
      }),
    ]);
    expect(digest.sections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "adviceRequests" }),
    ]));
  });

  it("persists the canonical briefing with source refs and generated markdown", async () => {
    const { buildWorkspaceBriefingFromCandidates, upsertWorkspaceBriefing } = await import("./workspace-briefing");
    const briefing = buildWorkspaceBriefingFromCandidates({
      workspaceId: "ws-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      title: "Daily Workspace Briefing - 2026-04-30",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
      candidates: [baseCandidate({ sourceType: "ACTION", sourceId: "action-1", title: "Review launch", sourceRefs: [{ type: "ACTION", id: "action-1", label: "Review launch", href: "/workspaces/ws-1/actions/action-1" }] })],
    });

    await upsertWorkspaceBriefing({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      period: "DAILY",
      dateKey: "2026-04-30",
      runKey: "ws-1:daily-briefing:2026-04-30",
      title: briefing.title,
      modelUsed: "excellent-model",
      briefing,
    });

    expect(prismaMock.workspaceBriefing.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_period_dateKey: {
          workspaceId: "ws-1",
          period: "DAILY",
          dateKey: "2026-04-30",
        },
      },
      create: expect.objectContaining({
        workspaceId: "ws-1",
        workflowJobId: "job-1",
        modelUsed: "excellent-model",
        bodyMd: expect.stringContaining("# Daily Workspace Briefing - 2026-04-30"),
        sourceRefsJson: expect.arrayContaining([
          expect.objectContaining({ type: "ACTION", id: "action-1" }),
        ]),
      }),
    }));
  });
});
