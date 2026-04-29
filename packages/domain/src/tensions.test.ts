import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    tension: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1", workspaceId: "ws-1", userId: "u-1", role: "ADMIN", isActive: true }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

const actor = { kind: "user", user: { id: "u-1" } } as any;

describe("tensions domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.member.findFirst.mockResolvedValue({ id: "raised-member-1" });
    prismaMock.tension.count.mockResolvedValue(1);
    prismaMock.tension.create.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "raised-member-1",
    });
    prismaMock.tension.findFirst.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
    });
    prismaMock.tension.findMany.mockResolvedValue([{ id: "t-1" }]);
    prismaMock.tension.findUnique.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      publishedAt: null,
    });
    prismaMock.tension.update.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "raised-member-1",
    });
  });

  it("creates a tension with a valid raised-by member", async () => {
    const { createTension } = await import("./tensions");

    const result = await createTension(actor, {
      workspaceId: "ws-1",
      title: " Test tension ",
      bodyMd: " Details ",
      raisedByMemberId: "raised-member-1",
    });

    expect(result.raisedByMemberId).toBe("raised-member-1");
    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        id: "raised-member-1",
        workspaceId: "ws-1",
        isActive: true,
      },
      select: { id: true },
    });
    expect(prismaMock.tension.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        authorUserId: "u-1",
        title: "Test tension",
        bodyMd: "Details",
        raisedByMemberId: "raised-member-1",
      }),
    });
  });

  it("rejects raised-by members outside the active workspace", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce(null);
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "other-workspace-member",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.tension.create).not.toHaveBeenCalled();
  });

  it("updates a tension raised-by member", async () => {
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: "raised-member-1",
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        id: "raised-member-1",
        workspaceId: "ws-1",
        isActive: true,
      },
      select: { id: true },
    });
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { raisedByMemberId: "raised-member-1" },
    });
  });

  it("clears a tension raised-by member", async () => {
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: null,
    });

    expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { raisedByMemberId: null },
    });
  });

  it("lists tensions with raised-by metadata", async () => {
    const { listTensions } = await import("./tensions");

    await expect(listTensions(actor, "ws-1")).resolves.toMatchObject({
      items: [{ id: "t-1" }],
      total: 1,
    });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        raisedByMember: {
          include: {
            user: {
              select: {
                displayName: true,
                email: true,
              },
            },
          },
        },
      }),
    }));
  });

  it("fetches tension details with raised-by metadata and requires membership", async () => {
    const { getTension } = await import("./tensions");
    const { requireWorkspaceMembership } = await import("./auth");

    const result = await getTension(actor, { workspaceId: "ws-1", tensionId: "t-1" });

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });

    expect(prismaMock.tension.findFirst).toHaveBeenCalledWith({
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
        raisedByMember: { include: { user: { select: { displayName: true, email: true } } } },
        proposal: { select: { id: true, title: true, status: true } },
        upvotes: true,
      },
    });

    expect(result.title).toBe("Test tension");
  });

  it("does not expose private tensions to non-authors by direct id", async () => {
    const { getTension } = await import("./tensions");

    prismaMock.tension.findFirst.mockResolvedValueOnce(null);

    const otherActor = { kind: "user", user: { id: "u-2" } } as any;
    await expect(getTension(otherActor, { workspaceId: "ws-1", tensionId: "t-private" })).rejects.toThrow("Tension not found.");
  });

  it("does not let workspace admins bypass private tension ownership", async () => {
    const { getTension } = await import("./tensions");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    prismaMock.tension.findFirst.mockResolvedValueOnce(null);

    const adminActor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getTension(adminActor, { workspaceId: "ws-1", tensionId: "t-private" })).rejects.toThrow("Tension not found.");

    expect(prismaMock.tension.findFirst).toHaveBeenCalledWith(expect.objectContaining({
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
