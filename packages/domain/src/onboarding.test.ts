import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    userWorkspaceOnboardingState: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    prisma: prismaMock,
  };
});

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

describe("user workspace onboarding state", () => {
  const actor = {
    kind: "user" as const,
    user: { id: "user-1", email: "user@example.test", displayName: null },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
  });

  it("loads account-saved completion state for a workspace tour", async () => {
    const completedAt = new Date("2026-05-25T10:00:00.000Z");
    prismaMock.userWorkspaceOnboardingState.findUnique.mockResolvedValue({
      id: "state-1",
      tourKey: "self_serve_workspace",
      tourVersion: "v2",
      completedAt,
      restartedAt: null,
      updatedAt: completedAt,
    });
    const { getUserWorkspaceOnboardingState } = await import("./onboarding");

    await expect(getUserWorkspaceOnboardingState(actor, { workspaceId: "workspace-1" })).resolves.toEqual({
      tourKey: "self_serve_workspace",
      tourVersion: "v2",
      completedAt,
      restartedAt: null,
      updatedAt: completedAt,
    });
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.userWorkspaceOnboardingState.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId_workspaceId_tourKey_tourVersion: {
          userId: "user-1",
          workspaceId: "workspace-1",
          tourKey: "self_serve_workspace",
          tourVersion: "v2",
        },
      },
    }));
  });

  it("upserts completion so the tour does not rerun after browser state is cleared", async () => {
    const completedAt = new Date("2026-05-25T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(completedAt);
    prismaMock.userWorkspaceOnboardingState.upsert.mockResolvedValue({
      id: "state-1",
      tourKey: "self_serve_workspace",
      tourVersion: "v2",
      completedAt,
      restartedAt: null,
      updatedAt: completedAt,
    });
    const { completeUserWorkspaceOnboarding } = await import("./onboarding");

    await completeUserWorkspaceOnboarding(actor, { workspaceId: "workspace-1" });

    expect(prismaMock.userWorkspaceOnboardingState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
        completedAt,
      }),
      update: { completedAt },
    }));
    vi.useRealTimers();
  });
});
