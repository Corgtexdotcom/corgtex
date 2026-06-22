import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      workspaceFeatureFlag: {
        findUnique: vi.fn(),
      },
      knowledgeChunk: {
        findMany: vi.fn(),
      },
      document: {
        findMany: vi.fn(),
      },
      brainArticle: {
        findMany: vi.fn(),
      },
      circle: {
        findMany: vi.fn(),
      },
      role: {
        findMany: vi.fn(),
      },
      event: {
        findMany: vi.fn(),
      },
      communicationChannel: {
        findMany: vi.fn(),
      },
      communicationMessage: {
        findMany: vi.fn(),
      },
      meeting: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      member: {
        findMany: vi.fn(),
      },
      tension: {
        findMany: vi.fn(),
      },
      action: {
        findMany: vi.fn(),
      },
      proposal: {
        findMany: vi.fn(),
      },
      meetingInsight: {
        findMany: vi.fn(),
      },
      deliberationEntry: {
        findMany: vi.fn(),
      },
    },
  };
});

import { prisma } from "@corgtex/shared";
import { buildMeetingIntelligenceContext } from "./meeting-intelligence-context";

describe("meeting-intelligence-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: true });
    (prisma.meeting.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "meeting-2",
      workspaceId: "ws-1",
      title: "Weekly progress review",
      source: "recorder",
      transcript: "We discussed the open onboarding tension and the pricing proposal.",
      summaryMd: "Current weekly summary",
      ingestionGuidanceMd: "Use Corporate Rebels spelling.",
      recordedAt: new Date("2026-05-13T16:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-13T17:00:00.000Z"),
      seriesId: "series-1",
      series: { title: "Weekly progress review", recurrenceRule: "FREQ=WEEKLY" },
      participantIds: ["user-1"],
      participantEmails: ["alice@example.com"],
    });
    (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "member-1",
        userId: "user-1",
        user: { displayName: "Alice", email: "alice@example.com" },
        roleAssignments: [
          { role: { circleId: "circle-1", circle: { name: "Operations" } } },
        ],
      },
    ]);
    (prisma.tension.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "tension-1",
        title: "Onboarding handoff unclear",
        status: "OPEN",
        priority: 4,
        bodyMd: "The handoff needs an owner.",
        upvotes: [{ id: "vote-1" }],
        circle: { name: "Operations" },
        assigneeMember: null,
        raisedByMember: { user: { displayName: "Alice", email: "alice@example.com" } },
      },
    ]);
    (prisma.action.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "action-1",
        title: "Send onboarding checklist",
        status: "OPEN",
        dueAt: new Date("2026-05-20T12:00:00.000Z"),
        bodyMd: "Send the latest checklist.",
        circle: { name: "Operations" },
        assigneeMember: { user: { displayName: "Alice", email: "alice@example.com" } },
      },
    ]);
    (prisma.proposal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "proposal-1",
        title: "Pricing proposal",
        status: "OPEN",
        summary: "Clarify pricing ownership.",
        bodyMd: "Proposal body.",
        circle: { name: "Operations" },
        author: { displayName: "Alice", email: "alice@example.com" },
        tensions: [{ id: "tension-1", title: "Onboarding handoff unclear", status: "OPEN" }],
        actions: [],
      },
    ]);
    (prisma.meeting.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "meeting-1",
        title: "Weekly progress review",
        recordedAt: new Date("2026-05-06T16:00:00.000Z"),
        summaryMd: "Previous weekly summary",
        decisionsJson: { items: [] },
      },
    ]);
    (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "follow-up-1",
        meetingId: "meeting-1",
        type: "FOLLOW_UP",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Review onboarding next week",
        bodyMd: "Carry this forward.",
        assigneeHint: "Alice",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: null,
        appliedEntityId: null,
      },
      {
        id: "resolved-1",
        meetingId: "meeting-1",
        type: "TENSION",
        operation: "RESOLVE",
        status: "APPLIED",
        title: "Clarified onboarding threshold",
        bodyMd: "Resolved in the previous weekly.",
        assigneeHint: null,
        targetEntityType: "Tension",
        targetEntityId: "tension-old",
        appliedEntityType: "Tension",
        appliedEntityId: "tension-old",
      },
      {
        id: "created-action-1",
        meetingId: "meeting-1",
        type: "ACTION_ITEM",
        operation: "CREATE",
        status: "APPLIED",
        title: "Send onboarding checklist",
        bodyMd: "Created last meeting.",
        assigneeHint: "Alice",
        targetEntityType: null,
        targetEntityId: null,
        appliedEntityType: "Action",
        appliedEntityId: "action-1",
      },
    ]);
    (prisma.deliberationEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "entry-1",
        parentType: "PROPOSAL",
        parentId: "proposal-1",
        entryType: "REACTION",
        bodyMd: "Concern about rollout timing.",
        author: { displayName: "Alice", email: "alice@example.com" },
        createdAt: new Date("2026-05-12T12:00:00.000Z"),
      },
    ]);
    (prisma.knowledgeChunk.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "chunk-1",
        sourceType: "MEETING",
        sourceId: "meeting-1",
        sourceTitle: "Weekly progress review",
        chunkIndex: 0,
        content: "Previous weekly summary mentioned onboarding and pricing.",
        sensitivity: "PUBLIC",
      },
      {
        id: "chunk-2",
        sourceType: "SLACK",
        sourceId: "slack-1",
        sourceTitle: "ops channel",
        chunkIndex: 0,
        content: "Unrelated lunch thread.",
        sensitivity: "PUBLIC",
      },
      {
        id: "chunk-3",
        sourceType: "PROPOSAL",
        sourceId: "private-proposal",
        sourceTitle: "Private proposal",
        chunkIndex: 0,
        content: "Private proposal pricing should not be visible.",
        sensitivity: "PUBLIC",
      },
      {
        id: "chunk-4",
        sourceType: "PROPOSAL",
        sourceId: "proposal-1",
        sourceTitle: "Pricing proposal",
        chunkIndex: 0,
        content: "Confidential pricing proposal should not be visible.",
        sensitivity: "CONFIDENTIAL",
      },
    ]);
    (prisma.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "document-1" }]);
    (prisma.brainArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "brain-1" }]);
    (prisma.circle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "circle-1" }]);
    (prisma.role.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "role-1" }]);
    (prisma.event.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "event-1" }]);
    (prisma.communicationChannel.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { installationId: "slack-installation-1", externalChannelId: "C123" },
    ]);
    (prisma.communicationMessage.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "slack-1" }]);
  });

  it("selects recurring-meeting continuity, open governance records, deliberation, and broad knowledge", async () => {
    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "insights",
    });

    expect(context.contextualIntelligenceEnabled).toBe(true);
    expect(context.previousMeetings).toEqual([
      expect.objectContaining({ id: "meeting-1", summaryMd: "Previous weekly summary" }),
    ]);
    expect(context.tensions).toEqual([
      expect.objectContaining({ id: "tension-1", title: "Onboarding handoff unclear", upvotes: 1 }),
    ]);
    expect(context.actions).toEqual([
      expect.objectContaining({ id: "action-1", owner: "Alice" }),
    ]);
    expect(context.proposals).toEqual([
      expect.objectContaining({ id: "proposal-1", title: "Pricing proposal" }),
    ]);
    expect(prisma.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] }, isPrivate: false }),
      take: 50,
    }));
    expect(prisma.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN"] }, isPrivate: false }),
      take: 50,
    }));
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["DRAFT", "OPEN"] }, isPrivate: false }),
      take: 50,
    }));
    expect(context.followUps).toEqual([
      expect.objectContaining({ id: "follow-up-1", owner: "Alice" }),
    ]);
    expect(context.resolvedTensions).toEqual([
      expect.objectContaining({ id: "resolved-1", targetEntityId: "tension-old" }),
    ]);
    expect(context.createdFromPreviousMeeting).toEqual([
      { meetingId: "meeting-1", entityType: "Action", entityId: "action-1" },
    ]);
    expect(context.deliberationEntries).toEqual([
      expect.objectContaining({ id: "entry-1", parentId: "proposal-1" }),
    ]);
    expect(context.knowledge).toEqual([
      expect.objectContaining({ chunkId: "chunk-1", sourceType: "MEETING" }),
    ]);
    expect(prisma.knowledgeChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sensitivity: "PUBLIC",
        OR: expect.arrayContaining([
          expect.objectContaining({ sourceType: "MEETING", sourceId: { in: expect.arrayContaining(["meeting-1", "meeting-2"]) } }),
          expect.objectContaining({ sourceType: "PROPOSAL", sourceId: { in: ["proposal-1"] } }),
          expect.objectContaining({ sourceType: "SLACK", sourceId: { in: ["slack-1"] } }),
        ]),
      }),
    }));
  });

  it("keeps broad knowledge and deliberation disabled when the workspace flag is off", async () => {
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "summary",
    });

    expect(context.contextualIntelligenceEnabled).toBe(false);
    expect(context.knowledge).toEqual([]);
    expect(prisma.member.findMany).not.toHaveBeenCalled();
    expect(prisma.tension.findMany).not.toHaveBeenCalled();
    expect(prisma.action.findMany).not.toHaveBeenCalled();
    expect(prisma.proposal.findMany).not.toHaveBeenCalled();
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(prisma.deliberationEntry.findMany).not.toHaveBeenCalled();
  });

  it("keeps agenda context scoped to participant circles even when the intelligence flag is off", async () => {
    (prisma.workspaceFeatureFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const context = await buildMeetingIntelligenceContext({
      workspaceId: "ws-1",
      meetingId: "meeting-2",
      mode: "agenda",
    });

    expect(context.contextualIntelligenceEnabled).toBe(true);
    expect(prisma.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN"] },
        publishedAt: { not: null },
        OR: expect.arrayContaining([
          expect.objectContaining({ circleId: { in: ["circle-1"] } }),
          expect.objectContaining({ raisedByMemberId: { in: ["member-1"] } }),
        ]),
      }),
      take: 8,
    }));
    expect(prisma.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN", "IN_PROGRESS"] },
        publishedAt: { not: null },
      }),
      take: 8,
    }));
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ["OPEN"] },
        publishedAt: { not: null },
      }),
      take: 8,
    }));
  });
});
