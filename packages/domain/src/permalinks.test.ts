import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    workspacePermalink: {
      findFirst: vi.fn(),
    },
    workspaceArchiveRecord: {
      findFirst: vi.fn(),
    },
    action: { findFirst: vi.fn() },
    tension: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    brainArticle: { findFirst: vi.fn() },
    meeting: { findFirst: vi.fn() },
    goal: { findFirst: vi.fn() },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

describe("workspace permalinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue(null);
  });

  it("applies goal privacy when resolving permanent links", async () => {
    prismaMock.workspacePermalink.findFirst.mockResolvedValueOnce({
      id: "permalink-1",
      workspaceId: "ws-1",
      entityType: "Goal",
      entityId: "goal-private",
      canonicalPath: "/workspaces/ws-1/goals?goalId=goal-private",
    });
    prismaMock.goal.findFirst.mockResolvedValueOnce(null);

    const { resolveWorkspacePermalink } = await import("./permalinks");
    await expect(resolveWorkspacePermalink(actor, {
      workspaceId: "ws-1",
      permalinkId: "permalink-1",
    })).resolves.toMatchObject({
      status: "MISSING",
    });

    expect(prismaMock.goal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "goal-private",
        workspaceId: "ws-1",
        OR: expect.arrayContaining([
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ]),
      }),
    }));
  });
});
