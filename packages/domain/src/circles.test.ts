import { describe, expect, it, vi } from "vitest";
import { listCircleTree, suggestMaturityUpgrade } from "./circles";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    circle: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

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
