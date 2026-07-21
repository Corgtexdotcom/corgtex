import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  action: {
    findMany: vi.fn(),
  },
  brainSource: {
    findMany: vi.fn(),
  },
  brainArticle: {
    findMany: vi.fn(),
  },
  document: {
    findMany: vi.fn(),
  },
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

describe("duplicate guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.action.findMany.mockResolvedValue([]);
    prismaMock.brainSource.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.document.findMany.mockResolvedValue([]);
  });

  it("normalizes punctuation, accents, and common verb variants", async () => {
    const { normalizeDuplicateGuardText } = await import("./duplicate-guard");

    expect(normalizeDuplicateGuardText("  Sent: R\u00e9sum\u00e9 updates!!  ")).toBe("send resume update");
  });

  it("uses the latest 50 active same-type records by default and clamps overrides", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");

    await checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Follow up with finance",
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        archivedAt: null,
        status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] },
      }),
      take: 50,
    }));

    await checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Follow up with finance",
    }, { candidateLimit: 500, resolution: "create_new" });

    expect(prismaMock.action.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      take: 200,
    }));
  });

  it("throws a confirmation error for identical normalized title and body", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");
    prismaMock.action.findMany.mockResolvedValueOnce([
      {
        id: "action-1",
        title: "Send finance update",
        bodyMd: "Share the revised Q3 forecast.",
        status: "OPEN",
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    await expect(checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Sending finance updates",
      body: "Share the updated Q3 forecast.",
    })).rejects.toMatchObject({
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: expect.objectContaining({
        entityId: "action-1",
        matchKind: "exact",
        score: 1,
      }),
    });
  });

  it("uses title similarity and short-item context for likely action matches", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");
    const dueAt = new Date("2026-07-24T16:00:00.000Z");
    prismaMock.action.findMany.mockResolvedValueOnce([
      {
        id: "action-2",
        title: "Send Acme proposal",
        bodyMd: null,
        assigneeMemberId: "member-1",
        dueAt: new Date("2026-07-24T09:00:00.000Z"),
        status: "OPEN",
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    await expect(checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Send proposal to Acme",
      assigneeMemberId: "member-1",
      dueAt,
    })).rejects.toMatchObject({
      candidate: expect.objectContaining({
        entityId: "action-2",
        matchKind: "likely",
        reasons: expect.arrayContaining(["similar title", "same assignee", "same due date"]),
      }),
      recommendedResolution: "update_existing",
    });
  });

  it("can return a create-new override decision for audit metadata", async () => {
    const { checkWorkspaceDuplicateGuard, duplicateGuardAuditMeta } = await import("./duplicate-guard");
    prismaMock.action.findMany.mockResolvedValueOnce([
      {
        id: "action-3",
        title: "Send Acme proposal",
        bodyMd: null,
        status: "OPEN",
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    const decision = await checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Send Acme proposal",
    }, { resolution: "create_new" });

    expect(decision).toMatchObject({
      resolution: "create_new",
      match: expect.objectContaining({ entityId: "action-3" }),
    });
    expect(duplicateGuardAuditMeta(decision)).toEqual({
      duplicateGuardOverride: expect.objectContaining({
        candidateEntityType: "Action",
        candidateEntityId: "action-3",
      }),
    });
  });

  it("requires a target entity ID before mutable duplicate resolutions", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");

    await expect(checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Action",
      title: "Send Acme proposal",
    }, { resolution: "use_existing" })).rejects.toMatchObject({
      status: 400,
      code: "DUPLICATE_GUARD_TARGET_REQUIRED",
    });

    expect(prismaMock.action.findMany).not.toHaveBeenCalled();
  });

  it("reports exact archived external-id candidates but only allows create-new acknowledgment", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");
    prismaMock.brainSource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "source-archived",
          title: "Vendor transcript",
          content: "Vendor transcript content",
          externalId: "external-1",
          archivedAt: new Date("2026-07-19T10:00:00.000Z"),
          createdAt: new Date("2026-07-18T10:00:00.000Z"),
        },
      ]);

    await expect(checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      title: "Vendor transcript",
      content: "Vendor transcript content",
      externalId: "external-1",
    }, { onExact: "use_existing" })).rejects.toMatchObject({
      candidate: expect.objectContaining({
        entityId: "source-archived",
        matchKind: "exact",
        reasons: expect.arrayContaining(["externalId"]),
      }),
      recommendedResolution: "create_new",
      allowedResolutions: ["create_new"],
    });
    expect(prismaMock.brainSource.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        OR: [{ externalId: "external-1" }],
      },
      take: 5,
    }));
  });

  it("uses Brain source URL metadata for exact matches outside the latest window", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");
    prismaMock.brainSource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "source-url-match",
          title: "Vendor notes",
          content: "Vendor notes content",
          externalId: null,
          metadata: { sourceUrl: "https://example.com/vendor-notes" },
          archivedAt: null,
          createdAt: new Date("2026-07-18T10:00:00.000Z"),
        },
      ]);

    const decision = await checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      title: "Vendor notes",
      content: "Vendor notes content",
      sourceUrl: "https://example.com/vendor-notes",
    }, { onExact: "use_existing" });

    expect(decision).toMatchObject({
      resolution: "use_existing",
      match: expect.objectContaining({
        entityId: "source-url-match",
        reasons: expect.arrayContaining(["sourceUrl"]),
      }),
    });
    expect(prismaMock.brainSource.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        OR: expect.arrayContaining([
          { metadata: { path: ["sourceUrl"], equals: "https://example.com/vendor-notes" } },
        ]),
      }),
      take: 5,
    }));
  });

  it("does not offer update-existing for non-draft Brain article candidates", async () => {
    const { checkWorkspaceDuplicateGuard } = await import("./duplicate-guard");
    prismaMock.brainArticle.findMany.mockResolvedValueOnce([
      {
        id: "article-reference",
        title: "Incident review policy",
        bodyMd: "Incident reviews are published references.",
        authority: "REFERENCE",
        type: "PROCESS",
        isPrivate: false,
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    await expect(checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "BrainArticle",
      title: "Incident review policy",
      body: "Incident reviews are published references.",
      includePrivate: true,
    })).rejects.toMatchObject({
      candidate: expect.objectContaining({
        entityId: "article-reference",
        status: "REFERENCE",
      }),
      recommendedResolution: "use_existing",
      allowedResolutions: ["use_existing", "create_new"],
    });
  });

  it("uses document metadata content hashes for exact matches", async () => {
    const { checkWorkspaceDuplicateGuard, duplicateGuardContentHash } = await import("./duplicate-guard");
    const content = "The launch plan is ready.";
    prismaMock.document.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "document-existing",
          title: "Launch plan",
          textContent: null,
          metadata: { contentHash: duplicateGuardContentHash(content) },
          archivedAt: null,
          createdAt: new Date("2026-07-18T10:00:00.000Z"),
          updatedAt: new Date("2026-07-18T10:05:00.000Z"),
        },
      ]);

    const decision = await checkWorkspaceDuplicateGuard({
      workspaceId: "workspace-1",
      entityType: "Document",
      title: "Launch plan",
      content,
    }, { onExact: "use_existing" });

    expect(decision).toMatchObject({
      resolution: "use_existing",
      match: expect.objectContaining({
        entityId: "document-existing",
        matchKind: "exact",
        reasons: expect.arrayContaining(["contentHash"]),
      }),
    });
    expect(prismaMock.document.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        OR: expect.arrayContaining([
          { metadata: { path: ["contentHash"], equals: duplicateGuardContentHash(content) } },
        ]),
      }),
      take: 5,
    }));
  });
});
