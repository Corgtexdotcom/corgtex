import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { finishProducerLineage } from "./producer-lineage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: vi.fn(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))),
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id))),
}));

vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    roleOnboardingSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationTurn: {
      findFirst: vi.fn(),
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

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, requireWorkspaceMembership: (params: Parameters<typeof actual.requireWorkspaceMembership>[0]) => {
    // Operator fixtures also have an explicit ADMIN membership.
    if (params.actor.kind === "user" && params.actor.user.globalRole === "OPERATOR") {
      return actual.requireWorkspaceMembership({ ...params, resolvedMembership: {
        id: "fixture-admin", workspaceId: params.workspaceId, userId: params.actor.user.id, role: "ADMIN", isActive: true,
      } });
    }
    return actual.requireWorkspaceMembership(params);
  } };
});

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
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
    assignments: [
      {
        id: "assignment-active",
        memberId: "holder-active",
        expiresAt: null,
        member: {
          id: "holder-active",
          user: {
            displayName: "Active Holder",
            email: "active@example.com",
          },
        },
      },
      {
        id: "assignment-expired",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
        member: {
          user: {
            displayName: "Expired Holder",
            email: "expired@example.com",
          },
        },
      },
    ],
    agentAssignments: [],
    versions: [],
  },
  member: {
    id: "member-1",
    role: "CONTRIBUTOR",
    userId: "user-1",
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
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row) => row.id)));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.roleOnboardingSession.findFirst.mockResolvedValue(onboardingRecord);
    prismaMock.roleOnboardingSession.update.mockResolvedValue({ ...onboardingRecord, status: "ACTIVE" });
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversationTurn.findFirst.mockResolvedValue(null);
    prismaMock.conversationTurn.create.mockResolvedValue({});
    prismaMock.policyCorpus.findMany.mockResolvedValue([{ id: "policy-1", title: "Advice process", bodyMd: "Ask for advice before high-impact changes.", acceptedAt: new Date("2026-01-01") }]);
    prismaMock.action.findMany.mockResolvedValue([{ id: "action-1", title: "Publish weekly status", status: "OPEN", dueAt: null }]);
    prismaMock.tension.findMany.mockResolvedValue([{ id: "tension-1", title: "Unclear delivery priority", priority: 3 }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "proposal-1", title: "Clarify escalation path", summary: "Define who handles blockers." }]);
    prismaMock.meeting.findMany.mockResolvedValue([{ id: "meeting-1", title: "Ops tactical", recordedAt: new Date("2026-02-01"), summaryMd: "Reviewed current delivery risks." }]);
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
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "onboarding-1",
        status: { in: ["PENDING", "ACTIVE"] },
      }),
      data: expect.objectContaining({
        status: "ACTIVE",
        startedAt: expect.any(Date),
      }),
    }));
  });

  it("does not reactivate a dismissed session when intro activation loses a race", async () => {
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.roleOnboardingSession.findFirst
      .mockResolvedValueOnce(onboardingRecord)
      .mockResolvedValueOnce({ ...onboardingRecord, status: "DISMISSED" });

    const { createRoleOnboardingIntro } = await import("./role-onboarding");

    await expect(createRoleOnboardingIntro({
      workspaceId: "workspace-1",
      onboardingSessionId: "onboarding-1",
    })).resolves.toMatchObject({ status: "DISMISSED" });

    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "onboarding-1",
        status: { in: ["PENDING", "ACTIVE"] },
      }),
    }));
    expect(prismaMock.roleOnboardingSession.update).not.toHaveBeenCalled();
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
    expect(context).toContain("Active Holder");
    expect(context).not.toContain("Expired Holder");
    expect(context).toContain("Advice process");
    expect(context).toContain("Publish weekly status");
    expect(prismaMock.roleOnboardingSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        role: expect.objectContaining({
          include: expect.objectContaining({
            assignments: expect.objectContaining({
              where: {
                OR: [
                  { expiresAt: null },
                  { expiresAt: { gt: expect.any(Date) } },
                ],
              },
            }),
          }),
        }),
      }),
    }));
    expect(prismaMock.meeting.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { participantIds: { has: "member-1" } },
          { participantIds: { has: "user-1" } },
        ],
      }),
    }));
    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
            ],
          },
          {
            OR: [
              { assigneeMemberId: "member-1" },
              { circleId: "circle-1" },
            ],
          },
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

  it("hands off every admitted onboarding context input with its captured receipt", async () => {
    const { buildRoleOnboardingContextWithLineageForConversation } = await import("./role-onboarding");
    const result = await buildRoleOnboardingContextWithLineageForConversation({
      workspaceId: "workspace-1", conversationId: "conversation-1", userId: "user-1",
    });
    expect(result?.lineageInputs).toEqual(expect.arrayContaining([
      { kind: "RoleOnboardingSession", id: "onboarding-1" }, { kind: "Role", id: "role-1" },
      { kind: "Circle", id: "circle-1" }, { kind: "Member", id: "member-1" },
      { kind: "RoleAssignment", id: "assignment-active" }, { kind: "Member", id: "holder-active" },
      { kind: "PolicyCorpus", id: "policy-1" }, { kind: "Action", id: "action-1" },
      { kind: "Tension", id: "tension-1" }, { kind: "Proposal", id: "proposal-1" }, { kind: "Meeting", id: "meeting-1" },
    ]));
    expect(captureArtifactInputProof).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), "workspace-1",
      expect.arrayContaining([expect.objectContaining({ kind: "Action", id: "action-1", snapshot: expect.objectContaining({ title: "Publish weekly status" }) })]));
  });

  it("omits unknown optional onboarding sources and withholds a session with unknown required lineage", async () => {
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) =>
      new Set(kind === "PolicyCorpus" ? [] : rows.map((row) => row.id)));
    const { buildRoleOnboardingContextWithLineageForConversation } = await import("./role-onboarding");
    const params = { workspaceId: "workspace-1", conversationId: "conversation-1", userId: "user-1" };
    const result = await buildRoleOnboardingContextWithLineageForConversation(params);
    expect(result?.context).not.toContain("Advice process");
    expect(result?.lineageInputs).not.toContainEqual({ kind: "PolicyCorpus", id: "policy-1" });
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) =>
      new Set(kind === "RoleOnboardingSession" ? [] : rows.map((row) => row.id)));
    await expect(buildRoleOnboardingContextWithLineageForConversation(params)).resolves.toBeNull();
  });

  it("atomically records copied intro content with its conversation turn", async () => {
    const { createRoleOnboardingIntro } = await import("./role-onboarding");
    prismaMock.conversationTurn.create.mockResolvedValue({ id: "intro-turn-1" });
    await createRoleOnboardingIntro({ workspaceId: "workspace-1", onboardingSessionId: "onboarding-1" });
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock,
      artifact: { kind: "ConversationTurn", id: "intro-turn-1" } }));
  });

});
