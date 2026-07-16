import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    conversationSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversationPendingOperation: {
      deleteMany: vi.fn(),
    },
    conversationTurn: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    roleOnboardingSession: {
      updateMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  toInputJson: vi.fn((value: unknown) => value),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "OPERATOR",
  },
};

describe("conversations domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.roleOnboardingSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversationPendingOperation.deleteMany.mockResolvedValue({ count: 2 });
  });

  it("serializes turn numbering with a per-conversation lock", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    prismaMock.conversationTurn.findFirst.mockResolvedValue({ sequenceNumber: 2 });
    prismaMock.conversationTurn.create.mockResolvedValue({ id: "turn-3", sequenceNumber: 3 });
    prismaMock.conversationSession.update.mockResolvedValue({ id: "conversation-1" });

    const { addConversationTurn } = await import("./conversations");
    await expect(addConversationTurn(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      userMessage: "What should I do first?",
      assistantMessage: "Start here.",
      contextJson: { source: "test" },
    })).resolves.toMatchObject({ id: "turn-3", sequenceNumber: 3 });

    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.conversationTurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        sequenceNumber: 3,
        userMessage: "What should I do first?",
        assistantMessage: "Start here.",
        contextJson: { source: "test" },
      }),
    });
  });

  it("dismisses onboarding instead of deleting onboarding conversations", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      roleOnboarding: { id: "onboarding-1" },
    });
    prismaMock.conversationSession.update.mockResolvedValue({ id: "conversation-1", status: "COMPLETED" });

    const { deleteConversation } = await import("./conversations");
    await expect(deleteConversation(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).resolves.toMatchObject({ id: "conversation-1", status: "COMPLETED" });

    expect(prismaMock.roleOnboardingSession.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: expect.objectContaining({
        status: "DISMISSED",
        dismissedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.conversationPendingOperation.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: { not: "EXECUTING" },
      },
    });
    expect(prismaMock.conversationSession.delete).not.toHaveBeenCalled();
  });

  it("deletes ordinary conversations", async () => {
    prismaMock.conversationSession.findUnique.mockResolvedValue({
      id: "conversation-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      roleOnboarding: null,
    });
    prismaMock.conversationSession.delete.mockResolvedValue({ id: "conversation-1" });

    const { deleteConversation } = await import("./conversations");
    await expect(deleteConversation(actor, {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).resolves.toEqual({ id: "conversation-1" });

    expect(prismaMock.conversationSession.delete).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
    });
    expect(prismaMock.conversationPendingOperation.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: { not: "EXECUTING" },
      },
    });
  });
});
