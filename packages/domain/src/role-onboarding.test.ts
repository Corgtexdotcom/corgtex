import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    roleOnboardingSession: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    conversationTurn: {
      create: vi.fn(),
    },
    policyCorpus: {
      findMany: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
    },
    tension: {
      findMany: vi.fn(),
    },
    proposal: {
      findMany: vi.fn(),
    },
    meeting: {
      findMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const onboardingRecord = {
  id: "onboarding-1",
  workspaceId: "workspace-1",
  roleId: "role-1",
  memberId: "member-1",
  conversationId: "conversation-1",
  status: "PENDING",
  startedAt: null,
  conversation: {
    id: "conversation-1",
    turns: [],
  },
  role: {
    id: "role-1",
    circleId: "circle-1",
    name: "Integrator",
    purposeMd: "Keep the circle aligned.",
    accountabilities: ["Coordinate priorities"],
    artifacts: ["Operating dashboard"],
    circle: {
      id: "circle-1",
      name: "Operations",
      purposeMd: "Run the operating system.",
      domainMd: "Delivery cadence",
    },
    assignments: [],
    agentAssignments: [],
    versions: [],
  },
  member: {
    id: "member-1",
    user: {
      displayName: "Alex",
      email: "alex@example.com",
      bio: null,
    },
  },
};

describe("role onboarding domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.roleOnboardingSession.findFirst.mockResolvedValue(onboardingRecord);
    prismaMock.roleOnboardingSession.update.mockResolvedValue({ ...onboardingRecord, status: "ACTIVE" });
    prismaMock.conversationTurn.create.mockResolvedValue({});
    prismaMock.policyCorpus.findMany.mockResolvedValue([{ title: "Advice process", bodyMd: "Ask for advice before high-impact changes.", acceptedAt: new Date("2026-01-01") }]);
    prismaMock.action.findMany.mockResolvedValue([{ title: "Publish weekly status", status: "OPEN", dueAt: null }]);
    prismaMock.tension.findMany.mockResolvedValue([{ title: "Unclear delivery priority", priority: 3 }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ title: "Clarify escalation path", summary: "Define who handles blockers." }]);
    prismaMock.meeting.findMany.mockResolvedValue([{ title: "Ops tactical", recordedAt: new Date("2026-02-01"), summaryMd: "Reviewed current delivery risks." }]);
  });

  it("creates the first assistant intro turn and activates the session", async () => {
    const { createRoleOnboardingIntro } = await import("./role-onboarding");

    await expect(createRoleOnboardingIntro({
      workspaceId: "workspace-1",
      onboardingSessionId: "onboarding-1",
    })).resolves.toMatchObject({ status: "ACTIVE" });

    expect(prismaMock.conversationTurn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        sequenceNumber: 1,
        assistantMessage: expect.stringContaining("Integrator"),
      }),
    }));
    expect(prismaMock.roleOnboardingSession.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ACTIVE",
        startedAt: expect.any(Date),
      }),
    }));
  });

  it("builds live role context for onboarding conversation follow-ups", async () => {
    const { buildRoleOnboardingContextForConversation } = await import("./role-onboarding");

    const context = await buildRoleOnboardingContextForConversation({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      userId: "user-1",
    });

    expect(context).toContain("ROLE ONBOARDING CONTEXT");
    expect(context).toContain("Integrator");
    expect(context).toContain("Advice process");
    expect(context).toContain("Publish weekly status");
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { participantIds: { has: "member-1" } },
          { participantIds: { has: "user-1" } },
        ],
      }),
    }));
  });

  it("rejects completion for dismissed onboarding sessions", async () => {
    prismaMock.roleOnboardingSession.findFirst.mockResolvedValue(null);

    const { updateRoleOnboardingStatusByConversation } = await import("./role-onboarding");
    await expect(updateRoleOnboardingStatusByConversation({
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "OPERATOR",
      },
    }, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      status: "COMPLETED",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(prismaMock.roleOnboardingSession.update).not.toHaveBeenCalled();
  });
});
