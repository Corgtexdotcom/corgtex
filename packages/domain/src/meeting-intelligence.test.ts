import { describe, it, expect, vi, beforeEach } from "vitest";

const { createActionMock, updateActionMock, createProposalMock, submitProposalMock, createTensionMock, updateTensionMock } = vi.hoisted(() => ({
  createActionMock: vi.fn(),
  updateActionMock: vi.fn(),
  createProposalMock: vi.fn(),
  submitProposalMock: vi.fn(),
  createTensionMock: vi.fn(),
  updateTensionMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: {
      $transaction: vi.fn(),
      member: {
        findMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: "member-123", workspaceId: "ws-1", userId: "user-123", role: "ADMIN", isActive: true }),
      },
      meeting: {
        update: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
      action: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      tension: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      proposal: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      policyCorpus: {
        upsert: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
      meetingInsight: {
        create: vi.fn(),
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
});

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: {
    extract: vi.fn(),
  },
}));

vi.mock("./actions", () => ({
  createAction: createActionMock,
  updateAction: updateActionMock,
}));

vi.mock("./proposals", () => ({
  createProposal: createProposalMock,
  submitProposal: submitProposalMock,
}));

vi.mock("./tensions", () => ({
  createTension: createTensionMock,
  updateTension: updateTensionMock,
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn(),
}));

import { prisma } from "@corgtex/shared";
import { 
  extractMeetingInsights, 
  confirmInsight, 
  dismissInsight, 
  applyInsight,
  confirmAllInsights
} from "./meeting-intelligence";

const mockActor = {
  kind: "user" as const,
  user: { id: "user-123", email: "test@example.com", displayName: "Test User" },
};

describe("meeting-intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(prisma));
    (prisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "member-raised",
        user: {
          displayName: "Milan",
          email: "milan@example.com",
        },
      },
    ]);
    createActionMock.mockResolvedValue({ id: "action-1" });
    updateActionMock.mockResolvedValue({ id: "action-1" });
    createProposalMock.mockResolvedValue({ id: "proposal-1" });
    submitProposalMock.mockResolvedValue({ proposalId: "proposal-1" });
    createTensionMock.mockResolvedValue({ id: "tension-1" });
    updateTensionMock.mockResolvedValue({ id: "tension-1" });
  });

  describe("extractMeetingInsights", () => {
    it("should call model gateway to extract structured insights and create records", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "ACTION_ITEM",
              operation: "CREATE",
              title: "#001 > Alice Next Steps - follow up on email",
              body: "**CONTEXT:** Received customer feedback\n**REQUEST:** Need to follow up\n**ANSWER:** Alice will follow up\n**RESULT:** OPEN",
              assigneeHint: "Alice",
              confidence: 0.9,
              sourceQuote: "I will follow up tomorrow",
            }
          ]
        }
      });

      // Mock dependencies
      (prisma.meeting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "meeting-1",
        workspaceId: "ws-1",
        transcript: "Alice: I will follow up tomorrow.",
        ingestionGuidanceMd: "Prioritize follow-up actions.",
      });
      (prisma.meetingInsight.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "insight-1" });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1"
      });

      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "ws-1",
        instruction: expect.stringContaining("Number items sequentially"),
        input: expect.stringContaining("Prioritize follow-up actions."),
      }));
      expect(prisma.meetingInsight.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          type: "ACTION_ITEM",
          title: "#001 > Alice Next Steps - follow up on email",
          bodyMd: expect.stringContaining("**CONTEXT:**"),
        })
      }));
    });
  });

  describe("confirmInsight", () => {
    it("updates insight status to CONFIRMED", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });

      await confirmInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123"
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          status: "CONFIRMED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });

  describe("dismissInsight", () => {
    it("updates insight status to DISMISSED", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });

      await dismissInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123"
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          status: "DISMISSED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });

  describe("applyInsight", () => {
    it("is defined and callable", async () => {
      expect(applyInsight).toBeDefined();
    });

    it("uses assignee hints as raised-by members for tension insights", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "TENSION",
        status: "CONFIRMED",
        title: "Onboarding ownership is unclear",
        bodyMd: "The handoff owner was unclear.",
        assigneeHint: "Milan",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });
      (prisma.meetingInsight.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        status: "APPLIED",
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
      });

      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        title: "Onboarding ownership is unclear",
        raisedByMemberId: "member-raised",
        meetingId: "meeting-1",
        isPrivate: false,
      }));
      expect(updateTensionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        workspaceId: "ws-1",
        tensionId: "tension-1",
        status: "OPEN",
      }));
      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.not.objectContaining({
        assigneeMemberId: "member-raised",
      }));
    });

    it("applies adopted proposal resolutions through the proposal approval event path", async () => {
      const { appendEvents } = await import("./events");
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-proposal",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "PROPOSAL",
        operation: "RESOLVE",
        targetEntityType: "Proposal",
        targetEntityId: "proposal-1",
        resolutionOutcome: "ADOPTED",
        status: "SUGGESTED",
        title: "Adopt pricing policy",
        bodyMd: "The group agreed to adopt the pricing policy.",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });
      (prisma.proposal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "proposal-1",
        workspaceId: "ws-1",
        title: "Adopt pricing policy",
        bodyMd: "Pricing policy body",
        circleId: null,
        publishedAt: null,
      });
      (prisma.proposal.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "proposal-1",
        workspaceId: "ws-1",
        title: "Adopt pricing policy",
        bodyMd: "Pricing policy body",
        circleId: null,
        decidedAt: new Date("2026-04-29T12:00:00.000Z"),
      });

      await applyInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-proposal",
      });

      expect(prisma.policyCorpus.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { proposalId: "proposal-1" },
      }));
      expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({
          type: "proposal.approved",
          payload: expect.objectContaining({
            proposalId: "proposal-1",
            subjectId: "proposal-1",
            outcome: "ADOPTED",
          }),
        }),
      ]);
    });
  });

  describe("confirmAllInsights", () => {
    it("updates all suggested insights to confirmed", async () => {
      await confirmAllInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-123"
      });

      expect(prisma.meetingInsight.updateMany).toHaveBeenCalledWith({
        where: { meetingId: "meeting-123", workspaceId: "ws-1", status: "SUGGESTED" },
        data: {
          status: "CONFIRMED",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });
  });
});
