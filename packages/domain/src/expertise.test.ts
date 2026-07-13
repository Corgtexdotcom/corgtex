import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    expertiseTag: {
      findMany: vi.fn(),
    },
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

describe("expertise domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
  });

  it("requires workspace membership before listing active expertise tags", async () => {
    prismaMock.expertiseTag.findMany.mockResolvedValue([
      { id: "tag-1", workspaceId: "workspace-1", label: "Compliance", slug: "compliance" },
    ]);

    const { listExpertiseTags } = await import("./expertise");
    await expect(listExpertiseTags(actor, "workspace-1")).resolves.toEqual([
      { id: "tag-1", workspaceId: "workspace-1", label: "Compliance", slug: "compliance" },
    ]);

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor, workspaceId: "workspace-1" });
    expect(prismaMock.expertiseTag.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", archivedAt: null },
      orderBy: { label: "asc" },
    });
  });
});
