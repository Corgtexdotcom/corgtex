import { describe, it, expect, vi, beforeEach } from "vitest";

const { createActionMock, createProposalMock, createTensionMock } = vi.hoisted(() => ({
  createActionMock: vi.fn(),
  createProposalMock: vi.fn(),
  createTensionMock: vi.fn(),
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
      meeting: { update: vi.fn() },
      meetingInsight: {
        createMany: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
});

vi.mock("./actions", () => ({
  createAction: createActionMock,
}));

vi.mock("./proposals", () => ({
  createProposal: createProposalMock,
}));

vi.mock("./tensions", () => ({
  createTension: createTensionMock,
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
    createProposalMock.mockResolvedValue({ id: "proposal-1" });
    createTensionMock.mockResolvedValue({ id: "tension-1" });
  });

  describe("extractMeetingInsights", () => {
    it("should extract insights and update meeting", async () => {
      // For now just testing the module exports exist and are callable
      expect(extractMeetingInsights).toBeDefined();
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
      }));
      expect(createTensionMock).toHaveBeenCalledWith(mockActor, expect.not.objectContaining({
        assigneeMemberId: "member-raised",
      }));
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
