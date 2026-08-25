import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    brainArticle: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    brainArticleVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    brainSource: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    brainDiscussionThread: {
      count: vi.fn(),
    },
    brainBacklink: {
      findMany: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
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
const resolveKnowledgeAccessDomains = vi.fn();
const archiveWorkspaceArtifact = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  persistedMemberId: (membership: { id?: string } | null | undefined) => membership?.id === "global-operator" ? null : membership?.id ?? null,
  requireWorkspaceMembership,
}));

vi.mock("./events", () => ({
  appendEvents,
}));

vi.mock("./brain-access", () => ({
  resolveKnowledgeAccessDomains,
}));

vi.mock("./archive", () => ({
  archiveFilterWhere: (filter: "active" | "archived" | "all" = "active") => {
    if (filter === "all") return {};
    if (filter === "archived") return { archivedAt: { not: null } };
    return { archivedAt: null };
  },
  archiveWorkspaceArtifact,
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
    prismaMock.brainArticle.findUnique.mockReset();
    prismaMock.brainArticle.findUnique.mockResolvedValue(null);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
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

  it("keeps draft authorization on the supplied transaction client when updating draft articles", async () => {
    const { updateArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValue(null);
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Draft",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: null,
      archivedAt: null,
    });
    prismaMock.brainArticle.update.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: null,
      archivedAt: null,
    });

    await updateArticle({
      kind: "agent",
      authProvider: "api-key",
      label: "brain-absorb",
      workspaceIds: ["ws-1"],
      scopes: ["brain:write"],
    } as any, {
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
      tx: prismaMock as any,
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(requireWorkspaceMembership).toHaveBeenCalledTimes(2);
    expect(requireWorkspaceMembership).toHaveBeenNthCalledWith(1, expect.objectContaining({ tx: prismaMock }));
    expect(requireWorkspaceMembership).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resolvedMembership: null,
      tx: prismaMock,
    }));
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

  it("does not persist the synthetic global-operator membership as a private article owner", async () => {
    const { createArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "ws-1",
      userId: "operator-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.brainArticle.create.mockResolvedValue({
      id: "article-1",
      slug: "operator-draft",
      title: "Operator draft",
      type: "RUNBOOK",
      authority: "DRAFT",
      isPrivate: true,
    });

    await createArticle({ kind: "user", user: { id: "operator-1" } } as any, {
      workspaceId: "ws-1",
      title: "Operator draft",
      type: "RUNBOOK",
      bodyMd: "Body",
    });

    expect(prismaMock.brainArticle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerMemberId: null,
      }),
    });
  });
});

describe("Brain status access domains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.count.mockResolvedValue(0);
    prismaMock.brainSource.count.mockResolvedValue(2);
    prismaMock.brainDiscussionThread.count.mockResolvedValue(0);
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
  });

  it.each([
    [["WORKSPACE"], 2],
    [["WORKSPACE", "FINANCE"], 3],
  ])("scopes unabsorbed source counts to %j", async (domains, count) => {
    resolveKnowledgeAccessDomains.mockResolvedValue(domains);
    prismaMock.brainSource.count.mockResolvedValue(count);
    const { getBrainStatus } = await import("./brain");

    await expect(getBrainStatus(ownerActor, { workspaceId: "ws-1" }))
      .resolves.toMatchObject({ unabsorbedSources: count });

    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(ownerActor, "ws-1");
    expect(prismaMock.brainSource.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        accessDomain: { in: domains },
        absorbedAt: null,
      },
    });
  });

  it("fails closed before status queries when access resolution fails", async () => {
    const error = new Error("access denied");
    resolveKnowledgeAccessDomains.mockRejectedValue(error);
    const { getBrainStatus } = await import("./brain");

    await expect(getBrainStatus(ownerActor, { workspaceId: "ws-1" }))
      .rejects.toBe(error);

    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.findMany).not.toHaveBeenCalled();
  });
});

describe("brain source ingestion", () => {
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
    prismaMock.brainSource.create.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 1,
      ingestionGuidanceMd: "Highlight launch constraints.",
    });
    prismaMock.brainSource.findFirst.mockResolvedValue(null);
    prismaMock.brainSource.findMany.mockResolvedValue([]);
    prismaMock.brainSource.count.mockResolvedValue(0);
    prismaMock.brainSource.update.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      absorbedAt: null,
    });
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    archiveWorkspaceArtifact.mockResolvedValue({ id: "source-1" });
  });

  it("filters workspace-only source items and totals through the shared access policy", async () => {
    const { listSources } = await import("./brain");

    await expect(listSources(ownerActor, {
      workspaceId: "ws-1",
    })).resolves.toEqual({
      items: [],
      total: 0,
      take: 50,
      skip: 0,
    });

    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(ownerActor, "ws-1");
    const where = {
      workspaceId: "ws-1",
      accessDomain: { in: ["WORKSPACE"] },
      archivedAt: null,
    };
    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prismaMock.brainSource.count).toHaveBeenCalledWith({ where });
  });

  it("preserves source filters and pagination for Finance-authorized domains", async () => {
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    prismaMock.brainSource.count.mockResolvedValue(7);

    const { listSources } = await import("./brain");
    await expect(listSources(ownerActor, {
      workspaceId: "ws-1",
      absorbed: true,
      archiveFilter: "archived",
      take: 12,
      skip: 4,
    })).resolves.toEqual({
      items: [],
      total: 7,
      take: 12,
      skip: 4,
    });

    const where = {
      workspaceId: "ws-1",
      accessDomain: { in: ["WORKSPACE", "FINANCE"] },
      archivedAt: { not: null },
      absorbedAt: { not: null },
    };
    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where,
      orderBy: { createdAt: "desc" },
      take: 12,
      skip: 4,
    }));
    expect(prismaMock.brainSource.count).toHaveBeenCalledWith({ where });
  });

  it("does not query sources when access-domain resolution fails", async () => {
    const error = new Error("access denied");
    resolveKnowledgeAccessDomains.mockRejectedValue(error);

    const { listSources } = await import("./brain");
    await expect(listSources(ownerActor, { workspaceId: "ws-1" }))
      .rejects.toBe(error);

    expect(prismaMock.brainSource.findMany).not.toHaveBeenCalled();
    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
  });

  it("persists trimmed ingestion guidance on brain sources", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      ingestionGuidanceMd: " Highlight launch constraints. ",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        content: "Policy text",
        ingestionGuidanceMd: "Highlight launch constraints.",
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        meta: expect.objectContaining({ hasIngestionGuidance: true }),
      }),
    }));
  });

  it("records the current user membership as the Brain source author", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("defaults explicit null user source authors to the current user membership", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: null,
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("defaults blank user source authors to the current user membership", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: "   ",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("ignores spoofed user source author ids", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: "other-member",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("delegates Brain source archiving to the central archive service", async () => {
    const { deleteSource } = await import("./brain");

    await expect(deleteSource(ownerActor, {
      workspaceId: "ws-1",
      sourceId: "source-1",
    })).resolves.toEqual({ id: "source-1" });

    expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(ownerActor, {
      workspaceId: "ws-1",
      entityType: "BrainSource",
      entityId: "source-1",
      reason: "Archived from Brain source delete path.",
    });
  });

  it("resets absorbed state when a duplicate Brain source is updated", async () => {
    const existingSource = {
      id: "source-existing",
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Policy",
      externalId: null,
      content: "Policy text",
      ingestionGuidanceMd: null,
      metadata: {},
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      absorbedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.brainSource.findMany.mockResolvedValueOnce([existingSource]);
    prismaMock.brainSource.findFirst.mockResolvedValueOnce(existingSource);
    prismaMock.brainSource.update.mockResolvedValueOnce({
      ...existingSource,
      content: "Policy text\n\n---\nAdditional duplicate upload context:\nNew policy detail",
      absorbedAt: null,
    });

    const { ingestSource } = await import("./brain");
    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Policy",
      externalId: "source-external-1",
      content: "New policy detail",
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "source-existing",
      },
    });

    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-existing" },
      data: expect.objectContaining({
        absorbedAt: null,
        externalId: "source-external-1",
      }),
    }));
    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
  });

  it("uses url metadata when checking Brain source duplicates", async () => {
    const existingSource = {
      id: "source-url",
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Vendor notes",
      content: "Vendor notes content",
      externalId: null,
      metadata: { url: "https://example.com/vendor-notes" },
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    };
    prismaMock.brainSource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingSource]);
    prismaMock.brainSource.findFirst.mockResolvedValueOnce(existingSource);

    const { ingestSource } = await import("./brain");
    await expect(ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Vendor notes",
      content: "Vendor notes content",
      metadata: { url: "https://example.com/vendor-notes" },
      duplicateGuard: { onExact: "use_existing" },
    })).resolves.toMatchObject({ id: "source-url" });

    expect(prismaMock.brainSource.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { metadata: { path: ["url"], equals: "https://example.com/vendor-notes" } },
        ]),
      }),
    }));
    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
  });
});
