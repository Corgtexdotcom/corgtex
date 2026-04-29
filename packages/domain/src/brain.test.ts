import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    brainArticle: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    brainArticleVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();
const appendEvents = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership,
}));

vi.mock("./events", () => ({
  appendEvents,
}));

const ownerActor = {
  kind: "user",
  user: { id: "user-1", email: "owner@example.com", displayName: "Owner" },
} as any;

describe("Brain article draft lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    appendEvents.mockResolvedValue(undefined);
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
  });

  it("lets workspace admins list private draft articles", async () => {
    const { listArticles } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "admin-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.count.mockResolvedValue(0);

    await listArticles({ kind: "user", user: { id: "admin-1" } } as any, { workspaceId: "ws-1" });

    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { workspaceId: "ws-1", archivedAt: null },
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, authority: "DRAFT" },
            ],
          },
        ],
      },
    }));
  });

  it("blocks non-managers from editing another owner's draft article", async () => {
    const { updateArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-2",
      workspaceId: "ws-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Draft",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: "mem-1",
      archivedAt: null,
    });

    await expect(updateArticle({
      kind: "user",
      user: { id: "user-2", email: "other@example.com", displayName: "Other" },
    } as any, {
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("returns a public article to draft for the owner", async () => {
    const { returnArticleToDraft } = await import("./brain");

    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "runbook",
      title: "Runbook",
      bodyMd: "Body",
      authority: "AUTHORITATIVE",
      isPrivate: false,
      ownerMemberId: "mem-1",
      archivedAt: null,
      ownerMember: { id: "mem-1", userId: "user-1" },
    });
    prismaMock.brainArticle.update.mockResolvedValue({
      id: "article-1",
      slug: "runbook",
      authority: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    await expect(returnArticleToDraft(ownerActor, {
      workspaceId: "ws-1",
      slug: "runbook",
    })).resolves.toMatchObject({
      id: "article-1",
      authority: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.brainArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1" },
      data: {
        authority: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      },
    });
  });
});
