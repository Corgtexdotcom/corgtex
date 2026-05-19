import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { listCircleTree, suggestMaturityUpgrade, updateCircle } from "./circles";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: vi.fn(),
    circle: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  },
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
  vi.mocked(prisma.event.createMany).mockResolvedValue({ count: 1 } as any);
});

describe("suggestMaturityUpgrade", () => {
  const workspaceId = "ws-1";
  const circleId = "circle-1";

  it("suggestMaturityUpgrade returns ready after 5 weeks of consistent tension processing (GETTING_STARTED)", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array(5).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready to practice proposals");
  });

  it("suggestMaturityUpgrade returns not ready for new circle", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array(2).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(false);
  });

  it("suggestMaturityUpgrade returns ready for FULL_O2 after high volume tension processing", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "BUILDING_MUSCLE",
      tensions: Array(20).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready for full O2");
  });

  it("suggestMaturityUpgrade returns false if already FULL_O2", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "FULL_O2",
      tensions: Array(50).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(workspaceId, circleId);

    expect(result.ready).toBe(false);
  });
});

describe("updateCircle", () => {
  const workspaceId = "ws-1";
  const circleId = "circle-1";

  it("rejects setting a circle as its own parent", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      archivedAt: null,
    } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: circleId,
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("rejects moving a circle under one of its descendants", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "child-2",
        workspaceId,
        parentCircleId: "child-1",
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "child-1",
        workspaceId,
        parentCircleId: circleId,
        archivedAt: null,
      } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "child-2",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("rejects a parent circle outside the workspace", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "other-workspace-circle",
        workspaceId: "ws-2",
        parentCircleId: null,
        archivedAt: null,
      } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "other-workspace-circle",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("updates a valid parent circle", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "parent-1",
        workspaceId,
        parentCircleId: null,
        archivedAt: null,
      } as any);
    vi.mocked(prisma.circle.update).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      parentCircleId: "parent-1",
    } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "parent-1",
    })).resolves.toMatchObject({
      id: circleId,
      parentCircleId: "parent-1",
    });

    expect(prisma.circle.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: circleId },
      data: { parentCircleId: "parent-1" },
    }));
  });
});

describe("listCircleTree", () => {
  it("loads profile fields for visible role fillers", async () => {
    vi.mocked(prisma.circle.findMany).mockResolvedValueOnce([
      {
        id: "circle-1",
        workspaceId: "ws-1",
        parentCircleId: null,
        name: "Product",
        roles: [
          {
            id: "role-1",
            assignments: [
              {
                id: "assignment-1",
                member: {
                  id: "member-1",
                  user: {
                    id: "user-1",
                    email: "member@example.com",
                    displayName: "Member One",
                    avatarUrl: "https://example.com/avatar.png",
                    bio: "Design and delivery.",
                  },
                },
              },
            ],
          },
        ],
      },
    ] as any);

    const result = await listCircleTree("ws-1");

    expect(prisma.circle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        roles: expect.objectContaining({
          include: expect.objectContaining({
            assignments: {
              include: {
                member: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        email: true,
                        displayName: true,
                        avatarUrl: true,
                        bio: true,
                      },
                    },
                  },
                },
              },
            },
          }),
        }),
      }),
    }));
    expect(result[0]?.roles[0]?.assignments[0]?.member.user).toMatchObject({
      avatarUrl: "https://example.com/avatar.png",
      bio: "Design and delivery.",
    });
  });
});
