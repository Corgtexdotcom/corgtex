import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckIn,
  createCompanyUnderstandingQuestion,
  getOverwhelmSignals,
  listCompanyUnderstandingQuestions,
  respondToCheckIn,
  skipCompanyUnderstandingQuestion,
} from "./check-ins";
import { prisma } from "@corgtex/shared";
import { appendEvents } from "./events";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    checkIn: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
  AppActor: {},
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "member-1" }),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(true),
}));

describe("getOverwhelmSignals", () => {
  const workspaceId = "ws-1";
  const memberId = "member-1";
  const actor = {
    kind: "user",
    user: { id: "user-1", email: "user@example.com", displayName: "User" },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked((prisma as any).$transaction).mockImplementation(async (fn: any) => fn(prisma));
  });

  it("getOverwhelmSignals flags member with 3+ negative responses in 7 days", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
      { sentiment: "NEGATIVE" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(3);
  });

  it("getOverwhelmSignals flags member with 1 OVERWHELMED response", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
      { sentiment: "OVERWHELMED" } as any,
    ]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(true);
    expect(result.recentNegativeCount).toBe(1);
  });

  it("getOverwhelmSignals returns clean for member with positive history", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([]);

    const result = await getOverwhelmSignals(workspaceId, memberId);

    expect(result.isOverwhelmed).toBe(false);
    expect(result.recentNegativeCount).toBe(0);
  });

  it("creates company understanding questions with company-knowledge defaults", async () => {
    vi.mocked(prisma.checkIn.create).mockResolvedValueOnce({ id: "checkin-1" } as any);

    await createCompanyUnderstandingQuestion(actor, {
      workspaceId,
      memberId,
      questionText: "What decision is blocking the onboarding process?",
      confidence: 0.72,
      priority: 3,
      relatedEntityType: "BrainSource",
      relatedEntityId: "source-1",
      metadata: { reason: "missing_decision" },
    });

    expect(prisma.checkIn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId,
        memberId,
        questionType: "COMPANY_UNDERSTANDING",
        questionSource: "AI",
        responseUsePolicy: "COMPANY_KNOWLEDGE",
        confidence: 0.72,
        priority: 3,
        relatedEntityType: "BrainSource",
        relatedEntityId: "source-1",
      }),
    }));
  });

  it("keeps regular check-ins under the member check-in response policy", async () => {
    vi.mocked(prisma.checkIn.create).mockResolvedValueOnce({ id: "checkin-1" } as any);

    await createCheckIn(actor, {
      workspaceId,
      memberId,
      questionText: "How are you feeling about your assigned tensions today?",
      questionSource: "AI",
    });

    expect(prisma.checkIn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        questionType: "WELLBEING",
        responseUsePolicy: "MEMBER_CHECKIN",
      }),
    }));
  });

  it("lists open company understanding questions for the signed-in member", async () => {
    vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([{ id: "checkin-1" }] as any);

    const result = await listCompanyUnderstandingQuestions(actor, { workspaceId });

    expect(result).toEqual([{ id: "checkin-1" }]);
    expect(prisma.checkIn.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId,
        memberId,
        questionType: "COMPANY_UNDERSTANDING",
        status: "OPEN",
      }),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    }));
  });

  it("marks check-ins answered when a member responds", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
    } as any);
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      status: "ANSWERED",
    } as any);

    await respondToCheckIn(actor, {
      workspaceId,
      checkInId: "checkin-1",
      responseMd: "The operations lead owns this.",
    });

    expect(prisma.checkIn.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "checkin-1" },
      data: expect.objectContaining({
        responseMd: "The operations lead owns this.",
        status: "ANSWERED",
      }),
    }));
    expect(appendEvents).toHaveBeenCalledWith(prisma, expect.arrayContaining([
      expect.objectContaining({ type: "checkin.response_received" }),
    ]));
  });

  it("skips open company understanding questions", async () => {
    vi.mocked(prisma.checkIn.findUnique).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      questionType: "COMPANY_UNDERSTANDING",
      status: "OPEN",
    } as any);
    vi.mocked(prisma.checkIn.update).mockResolvedValueOnce({
      id: "checkin-1",
      workspaceId,
      memberId,
      status: "SKIPPED",
    } as any);

    await skipCompanyUnderstandingQuestion(actor, {
      workspaceId,
      checkInId: "checkin-1",
    });

    expect(prisma.checkIn.update).toHaveBeenCalledWith({
      where: { id: "checkin-1" },
      data: { status: "SKIPPED" },
    });
    expect(appendEvents).toHaveBeenCalledWith(prisma, expect.arrayContaining([
      expect.objectContaining({ type: "checkin.skipped" }),
    ]));
  });
});
