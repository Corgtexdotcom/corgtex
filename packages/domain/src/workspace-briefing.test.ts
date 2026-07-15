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
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null }),
    }));
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", isPrivate: false, archivedAt: null }),
    }));
    expect(prismaMock.adviceRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "ws-1", audienceType: "WORKSPACE" }),
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
