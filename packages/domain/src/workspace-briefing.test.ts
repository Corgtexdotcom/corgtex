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

  it("uses natural intro text instead of mechanical source counts", async () => {
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
          status: "OPEN",
          strategicScore: 3,
          actionabilityScore: 3,
          sourceRefs: [{ type: "PROPOSAL", id: "proposal-1", label: "Proposal update", href: "/workspaces/ws-1/proposals/proposal-1" }],
        }),
        baseCandidate({
          sourceType: "TENSION",
          sourceId: "tension-1",
          title: "Active tension",
          status: "OPEN",
          strategicScore: 2,
          actionabilityScore: 3,
          sourceRefs: [{ type: "TENSION", id: "tension-1", label: "Active tension", href: "/workspaces/ws-1/tensions/tension-1" }],
        }),
        baseCandidate({
          sourceType: "GOAL",
          sourceId: "goal-1",
          title: "Strategic goal",
          strategicScore: 4,
          actionabilityScore: 1,
          sourceRefs: [{ type: "GOAL", id: "goal-1", label: "Strategic goal", href: "/workspaces/ws-1/goals" }],
        }),
      ],
    });

    expect(briefing.introMd).toContain("Today is mostly about");
    expect(briefing.introMd).toContain("open proposals");
    expect(briefing.introMd).toContain("active tensions");
    expect(briefing.introMd).not.toContain("1 proposal");
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
    expect(prismaMock.adviceRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", audienceType: "WORKSPACE", status: "ACTIVE" }),
    }));
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
      title: "Meeting Briefs",
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
      title: "Open Actions",
      href: null,
      sourceRefs: [],
    }));
  });

  it("links workspace advice requests to their actual subject", async () => {
    const { collectWorkspaceBriefingCandidates } = await import("./workspace-briefing");
    prismaMock.adviceRequest.findMany.mockResolvedValue([{
      id: "request-1",
      messageMd: "Please advise on the support risk.",
      status: "ACTIVE",
      deadlineAt: null,
      createdAt: new Date("2026-04-30T08:00:00.000Z"),
      updatedAt: new Date("2026-04-30T09:00:00.000Z"),
      process: { subjectType: "TENSION", subjectId: "tension-1" },
    }]);

    const candidates = await collectWorkspaceBriefingCandidates({
      workspaceId: "ws-1",
      since: new Date("2026-04-29T00:00:00.000Z"),
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "ADVICE_REQUEST",
        sourceId: "request-1",
        href: "/workspaces/ws-1/tensions/tension-1",
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

  it("converts briefing items into the existing newsletter digest shape", async () => {
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
          strategicScore: 3,
          evidenceScore: 2,
          sourceRefs: [{ type: "BUILD_ARTIFACT", id: "build-1", label: "Homepage briefing shipped", href: "https://github.com/example/pull/1" }],
        }),
      ],
    });

    const digest = workspaceBriefingToNewspaperDigest(briefing);

    expect(digest.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "builtWork",
        title: "Built / Shipped Work",
        items: [expect.stringContaining("The new briefing surface shipped.")],
      }),
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
