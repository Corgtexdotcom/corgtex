import { describe, expect, it, vi } from "vitest";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    tension: {
      findUnique: vi.fn().mockResolvedValue({
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

    expect(prisma.tension.findUnique).toHaveBeenCalledWith({
      where: { id: "t-1" },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        circle: { select: { id: true, name: true } },
        proposal: { select: { id: true, title: true, status: true } },
        upvotes: true,
      },
    });

    expect(result.title).toBe("Test tension");
  });
});
