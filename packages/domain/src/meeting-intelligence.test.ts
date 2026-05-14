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
  updateInsight,
  applyInsight,
  autoApplyMeetingInsights,
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
      expect(defaultModelGateway.extract).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.stringContaining("Alice: I will follow up tomorrow."),
      }));
      expect(prisma.meetingInsight.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          type: "ACTION_ITEM",
          title: "#001 > Alice Next Steps - follow up on email",
          bodyMd: expect.stringContaining("**CONTEXT:**"),
        })
      }));
    });

    it("uses the summary and excerpts for long transcripts to avoid extraction timeouts", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [],
        },
      });

      const longTranscript = [
        "Alice: Beginning action item.",
        "Filler ".repeat(6000),
        "Milan: Middle concern.",
        "More filler ".repeat(6000),
        "Jan: Ending decision.",
      ].join("\n");

      (prisma.meeting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "meeting-1",
        workspaceId: "ws-1",
        transcript: longTranscript,
        summaryMd: "Summary: Alice owns the follow-up and Jan confirmed the decision.",
        ingestionGuidanceMd: "Prioritize follow-up actions.",
      });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      const call = (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call.input).toContain("\"transcriptCondensedForExtraction\":true");
      expect(call.input).toContain("Summary: Alice owns the follow-up");
      expect(call.input).toContain("BEGINNING EXCERPT");
      expect(call.input).toContain("MIDDLE EXCERPT");
      expect(call.input).toContain("ENDING EXCERPT");
      expect(call.input.length).toBeLessThan(longTranscript.length);
    });

    it("normalizes model insight enum variants before saving", async () => {
      const { defaultModelGateway } = await import("@corgtex/models");
      (defaultModelGateway.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        output: {
          insights: [
            {
              type: "RESOLUTION",
              operation: "RESOLVE",
              title: "#001 > Proposal resolved",
              body: "**CONTEXT:** Proposal discussed\n**REQUEST:** Decide outcome\n**ANSWER:** Adopted\n**RESULT:** PROCESSED",
              confidence: 0.85,
              targetEntityType: "Proposal",
              targetEntityId: "proposal-123",
              resolutionOutcome: "adopted",
            },
            {
              type: "ACTION_ITEMS",
              operation: "CREATE",
              title: "#002 > Alice Follow-up",
              body: "**CONTEXT:** Follow-up needed\n**REQUEST:** Email customer\n**ANSWER:** Alice owns it\n**RESULT:** OPEN",
              confidence: 0.7,
              sourceQuote: "x".repeat(240),
            },
            {
              type: "RESOLUTION",
              operation: "CREATE",
              title: "#003 > Unsupported loose resolution",
              body: "No concrete target",
              confidence: 0.5,
            },
          ],
        },
      });

      (prisma.meeting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "meeting-1",
        workspaceId: "ws-1",
        transcript: "Meeting transcript.",
      });
      (prisma.proposal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "proposal-123", title: "Existing proposal", status: "OPEN" },
      ]);
      (prisma.meetingInsight.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "insight-1" });

      await extractMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      });

      expect(prisma.meetingInsight.create).toHaveBeenCalledTimes(2);
      expect(prisma.meetingInsight.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
        data: expect.objectContaining({
          type: "PROPOSAL",
          operation: "RESOLVE",
          targetEntityType: "Proposal",
          targetEntityId: "proposal-123",
          resolutionOutcome: "ADOPTED",
        }),
      }));
      expect(prisma.meetingInsight.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
        data: expect.objectContaining({
          type: "ACTION_ITEM",
          operation: "CREATE",
          sourceQuote: "x".repeat(200),
        }),
      }));
      expect(prisma.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "meeting-1" },
        data: expect.objectContaining({ aiProcessedAt: expect.any(Date) }),
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

  describe("updateInsight", () => {
    it("updates editable insight fields and records reviewer metadata", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "SUGGESTED",
      });
      (prisma.meetingInsight.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        title: "Updated title",
      });

      await updateInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
        title: "  Updated title  ",
        bodyMd: "  Updated body  ",
        assigneeHint: "  Milan  ",
      });

      expect(prisma.meetingInsight.update).toHaveBeenCalledWith({
        where: { id: "insight-123" },
        data: {
          title: "Updated title",
          bodyMd: "Updated body",
          assigneeHint: "Milan",
          reviewedByUserId: "user-123",
          reviewedAt: expect.any(Date),
        },
      });
    });

    it("rejects edits after an insight has been applied", async () => {
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-123",
        workspaceId: "ws-1",
        status: "APPLIED",
      });

      await expect(updateInsight(mockActor, {
        workspaceId: "ws-1",
        insightId: "insight-123",
        title: "Updated title",
      })).rejects.toThrow("Only reviewable insights can be edited.");

      expect(prisma.meetingInsight.update).not.toHaveBeenCalled();
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

  describe("autoApplyMeetingInsights", () => {
    it("only loads high-confidence suggested or confirmed insights for auto-apply", async () => {
      (prisma.meetingInsight.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "insight-action",
          operation: "CREATE",
          targetEntityType: null,
          targetEntityId: null,
        },
      ]);
      (prisma.meetingInsight.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "insight-action",
        workspaceId: "ws-1",
        meetingId: "meeting-1",
        type: "ACTION_ITEM",
        operation: "CREATE",
        status: "SUGGESTED",
        title: "Follow up with customer",
        bodyMd: "Milan will follow up.",
        assigneeHint: "Milan",
        meeting: {
          id: "meeting-1",
          title: "Weekly sync",
        },
      });

      await expect(autoApplyMeetingInsights(mockActor, {
        workspaceId: "ws-1",
        meetingId: "meeting-1",
      })).resolves.toMatchObject({
        applied: 1,
        failed: 0,
        threshold: 0.8,
      });

      expect(prisma.meetingInsight.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          meetingId: "meeting-1",
          status: { in: ["SUGGESTED", "CONFIRMED"] },
          confidence: { gte: 0.8 },
        }),
      }));
      expect(createActionMock).toHaveBeenCalledWith(mockActor, expect.objectContaining({
        title: "Follow up with customer",
        assigneeMemberId: "member-raised",
      }));
      expect(prisma.meetingInsight.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "insight-action" },
        data: expect.objectContaining({
          status: "APPLIED",
          autoAppliedAt: expect.any(Date),
        }),
      }));
    });
  });
});
