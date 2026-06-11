import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    tension: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    tensionUpvote: {
      upsert: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    workItemEvidence: {
      createMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    workItemVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
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
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1", workspaceId: "ws-1", userId: "u-1", role: "MEMBER", isActive: true }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

const actor = { kind: "user", user: { id: "u-1" } } as any;

describe("tensions domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.$executeRaw.mockResolvedValue({});
    prismaMock.workItemVersion.create.mockResolvedValue({});
    prismaMock.workItemVersion.findUnique.mockResolvedValue(null);
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
      authorUserId: "u-1",
      title: "Test tension",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      raisedByMemberId: null,
    });
    prismaMock.tension.update.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "raised-member-1",
    });
    prismaMock.tensionUpvote.upsert.mockResolvedValue({
      id: "upvote-1",
      tensionId: "t-1",
      userId: "u-1",
    });
  });

  it("creates a tension with a valid raised-by member", async () => {
    const { createTension } = await import("./tensions");

    const result = await createTension(actor, {
      workspaceId: "ws-1",
      title: " Test tension ",
      bodyMd: " Details ",
      raisedByMemberId: "raised-member-1",
      priority: 5,
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
        priority: 5,
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      }),
    });
  });

  it("creates unchecked-private tensions as open public records", async () => {
    prismaMock.tension.create.mockResolvedValueOnce({
      id: "t-public",
      workspaceId: "ws-1",
      title: "Public tension",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-05-26T12:00:00.000Z"),
    });
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: " Public tension ",
      isPrivate: false,
    })).resolves.toMatchObject({
      id: "t-public",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.tension.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        title: "Public tension",
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "tension.created",
        entityId: "t-public",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "tension.published",
        entityId: "t-public",
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "tension.published",
          aggregateId: "t-public",
          payload: { tensionId: "t-public" },
        }),
      ],
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

  it("rejects hidden, missing, archived, or cross-workspace linked proposals before creating a tension", async () => {
    prismaMock.proposal.findFirst.mockResolvedValueOnce(null);
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      proposalId: "proposal-missing",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prismaMock.proposal.findFirst).toHaveBeenCalledWith({
      where: {
        id: "proposal-missing",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      select: { id: true },
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
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-1",
        version: 1,
        changedFields: ["raisedByMemberId"],
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { raisedByMemberId: "raised-member-1", version: 2 },
    });
  });

  it("clears a tension raised-by member", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      raisedByMemberId: "raised-member-1",
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: null,
    });

    expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { raisedByMemberId: null, version: 2 },
    });
  });

  it("does not create a version for no-op content updates", async () => {
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: null,
    })).resolves.toMatchObject({
      id: "t-1",
      version: 1,
    });

    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).not.toHaveBeenCalled();
  });

  it("allows the author to edit an open tension and preserves the previous version", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      bodyMd: "Old body",
      status: "OPEN",
      version: 1,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
      raisedByMemberId: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "New title",
      status: "OPEN",
      version: 2,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "New title",
    })).resolves.toMatchObject({
      id: "t-open",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-open",
        version: 1,
        changedFields: ["title"],
        previousState: expect.objectContaining({
          title: "Old title",
          version: 1,
        }),
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-open" },
      data: { title: "New title", version: 2 },
    });
  });

  it("rejects open tension edits by non-authors", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 1,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension({ kind: "user", user: { id: "u-2" } } as any, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "Not mine",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).not.toHaveBeenCalled();
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
      orderBy: [
        { priority: "desc" },
        { upvotes: { _count: "desc" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
    }));
  });

  it("sorts tensions by title when requested", async () => {
    const { listTensions } = await import("./tensions");

    await listTensions(actor, "ws-1", { sort: "alpha" });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [
        { title: "asc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
    }));
  });

  it("applies opened and closed date filters when listing tensions", async () => {
    const { listTensions } = await import("./tensions");
    const openedFrom = new Date("2026-06-01T00:00:00.000Z");
    const openedTo = new Date("2026-06-02T23:59:59.999Z");
    const closedFrom = new Date("2026-06-03T00:00:00.000Z");
    const closedTo = new Date("2026-06-04T23:59:59.999Z");

    await listTensions(actor, "ws-1", {
      openedFrom,
      openedTo,
      closedFrom,
      closedTo,
    });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publishedAt: { gte: openedFrom, lte: openedTo },
        resolvedAt: { gte: closedFrom, lte: closedTo },
      }),
    }));
    expect(prismaMock.tension.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publishedAt: { gte: openedFrom, lte: openedTo },
        resolvedAt: { gte: closedFrom, lte: closedTo },
      }),
    });
  });

  it("sets resolvedAt when resolving a tension", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      resolvedVia: null,
      resolvedAt: null,
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      resolvedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      status: "RESOLVED",
      resolvedVia: " Process changed ",
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-open" },
      data: expect.objectContaining({
        status: "RESOLVED",
        isPrivate: false,
        resolvedVia: "Process changed",
        resolvedAt: expect.any(Date),
      }),
    });
  });

  it("combines member filters with the existing privacy filter", async () => {
    const { listTensions } = await import("./tensions");
    await listTensions(actor, "ws-1", { memberId: "mem-1", circleId: "circle-1" });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        circleId: "circle-1",
        AND: [
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
            ],
          },
          {
            OR: [
              { assigneeMemberId: "mem-1" },
              { raisedByMemberId: "mem-1" },
              {
                author: {
                  memberships: {
                    some: {
                      id: "mem-1",
                      workspaceId: "ws-1",
                      isActive: true,
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    }));
  });

  it("links resolution evidence when resolving a tension", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      resolvedVia: null,
      resolvedAt: null,
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      resolvedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    prismaMock.document.findMany.mockResolvedValueOnce([{ id: "doc-1" }]);
    prismaMock.workItemEvidence.createMany.mockResolvedValueOnce({ count: 1 });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      evidenceDocumentIds: ["doc-1", "doc-1"],
    });

    expect(prismaMock.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "ws-1",
        entityType: "Tension",
        entityId: "t-open",
        documentId: "doc-1",
        purpose: "resolution_evidence",
      }],
      skipDuplicates: true,
    });
  });

  it("rejects upvotes for non-open public tensions", async () => {
    const { upvoteTension } = await import("./tensions");
    for (const tension of [
      { status: "RESOLVED", isPrivate: false, archivedAt: null },
      { status: "DRAFT", isPrivate: true, archivedAt: null },
      { status: "OPEN", isPrivate: true, archivedAt: null },
      { status: "OPEN", isPrivate: false, archivedAt: new Date("2026-06-01T00:00:00.000Z") },
    ]) {
      vi.clearAllMocks();
      prismaMock.tension.findUnique.mockResolvedValueOnce({
        id: "t-1",
        workspaceId: "ws-1",
        ...tension,
      });

      await expect(upvoteTension(actor, {
        workspaceId: "ws-1",
        tensionId: "t-1",
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_STATE",
      });
      expect(prismaMock.tensionUpvote.upsert).not.toHaveBeenCalled();
    }
  });

  it("upvotes open public tensions", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      status: "OPEN",
      isPrivate: false,
      archivedAt: null,
    });
    const { upvoteTension } = await import("./tensions");

    await expect(upvoteTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
    })).resolves.toMatchObject({
      id: "upvote-1",
    });

    expect(prismaMock.tensionUpvote.upsert).toHaveBeenCalledWith({
      where: {
        tensionId_userId: {
          tensionId: "t-1",
          userId: "u-1",
        },
      },
      update: {},
      create: {
        tensionId: "t-1",
        userId: "u-1",
      },
    });
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
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
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

  it("lets workspace admins see private tension drafts", async () => {
    const { getTension } = await import("./tensions");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    prismaMock.tension.findFirst.mockResolvedValueOnce({
      id: "t-private",
      workspaceId: "ws-1",
      title: "Private tension",
      authorUserId: "u-1",
      status: "DRAFT",
      isPrivate: true,
    });

    const adminActor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getTension(adminActor, { workspaceId: "ws-1", tensionId: "t-private" })).resolves.toMatchObject({
      id: "t-private",
    });

    expect(prismaMock.tension.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "t-private",
        workspaceId: "ws-1",
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT" },
        ],
      },
    }));
  });

  it("returns an open tension to draft", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      resolvedAt: null,
      resolvedVia: null,
    });

    const { returnTensionToDraft } = await import("./tensions");

    await expect(returnTensionToDraft(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
    })).resolves.toMatchObject({
      id: "t-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        resolvedVia: null,
        resolvedAt: null,
      },
    });
  });
});
