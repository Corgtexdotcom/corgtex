import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const tx = {
    member: {
      findUnique: vi.fn(),
    },
    adviceProcess: {
      create: vi.fn(),
    },
    proposal: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    event: {
      create: vi.fn(),
    },
  };

  return {
    prismaMock: {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
      ...tx,
    },
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import { prisma } from "@corgtex/shared";
import { initiateAdviceProcess } from "./advice-process";

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "author@example.com",
    displayName: "Author",
    globalRole: "USER",
  },
};

describe("advice-process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ role: "CONTRIBUTOR" });
    (prisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "proposal-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "DRAFT",
    });
    (prisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    (prisma.adviceProcess.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "process-1",
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
    });
    (prisma.proposal.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.event.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("starts legacy proposal advice with generic subject metadata", async () => {
    await initiateAdviceProcess(actor, {
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      adviceDeadlineDays: 3,
    });

    expect(prisma.adviceProcess.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        proposalId: "proposal-1",
        authorMemberId: "member-1",
        ownerMemberId: "member-1",
        subjectType: "PROPOSAL",
        subjectId: "proposal-1",
        status: "GATHERING",
      }),
    });
    expect(prisma.proposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-1" },
      data: { status: "OPEN" },
    });
    expect(prisma.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "advice-process.initiated",
        aggregateType: "AdviceProcess",
        aggregateId: "process-1",
        payload: expect.objectContaining({
          proposalId: "proposal-1",
          subjectType: "PROPOSAL",
          subjectId: "proposal-1",
        }),
      }),
    });
  });
});
