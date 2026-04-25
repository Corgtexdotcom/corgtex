import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    tension: {
      findFirst: vi.fn().mockResolvedValue({
        id: "t-1",
        workspaceId: "ws-1",
        title: "Test tension",
      }),
    },
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
}));

describe("getTension", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches tension and requires membership", async () => {
    const { getTension } = await import("./tensions");
    const { prisma } = await import("@corgtex/shared");
    const { requireWorkspaceMembership } = await import("./auth");

    const actor = { kind: "user", user: { id: "u-1" } } as any;
    const result = await getTension(actor, { workspaceId: "ws-1", tensionId: "t-1" });

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });

    expect(prisma.tension.findFirst).toHaveBeenCalledWith({
      where: {
        id: "t-1",
        workspaceId: "ws-1",
        OR: [
          { isPrivate: false },
          { isPrivate: true, authorUserId: "u-1" },
        ],
      },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        circle: { select: { id: true, name: true } },
        proposal: { select: { id: true, title: true, status: true } },
        upvotes: true,
      },
    });

    expect(result.title).toBe("Test tension");
  });

  it("does not expose private tensions to non-authors by direct id", async () => {
    const { getTension } = await import("./tensions");
    const { prisma } = await import("@corgtex/shared");

    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce(null);

    const actor = { kind: "user", user: { id: "u-2" } } as any;
    await expect(getTension(actor, { workspaceId: "ws-1", tensionId: "t-private" })).rejects.toThrow("Tension not found.");
  });

  it("does not let workspace admins bypass private tension ownership", async () => {
    const { getTension } = await import("./tensions");
    const { prisma } = await import("@corgtex/shared");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    vi.mocked(prisma.tension.findFirst).mockResolvedValueOnce(null);

    const actor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getTension(actor, { workspaceId: "ws-1", tensionId: "t-private" })).rejects.toThrow("Tension not found.");

    expect(prisma.tension.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "t-private",
        workspaceId: "ws-1",
        OR: [
          { isPrivate: false },
          { isPrivate: true, authorUserId: "u-admin" },
        ],
      },
    }));
  });
});
