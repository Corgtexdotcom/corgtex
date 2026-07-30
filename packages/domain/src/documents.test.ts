import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    $transaction: vi.fn(async (cb: any) => cb(mock)),
    document: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };
  return mock;
});
const requireWorkspaceMembershipMock = vi.hoisted(() => vi.fn());
const appendEventsMock = vi.hoisted(() => vi.fn());
const assertTrialStorageCapacityMock = vi.hoisted(() => vi.fn());
const resolveKnowledgeAccessDomainsMock = vi.hoisted(() => vi.fn());

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  persistedMemberId: (membership: { id?: string } | null | undefined) => membership?.id === "global-operator" ? null : membership?.id ?? null,
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

vi.mock("./trial-entitlements", () => ({
  assertTrialStorageCapacity: assertTrialStorageCapacityMock,
}));

vi.mock("./brain-access", () => ({
  resolveKnowledgeAccessDomains: resolveKnowledgeAccessDomainsMock,
}));

describe("listDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.document.findMany.mockResolvedValue([]);
    resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]);
  });

  it("limits callers without an actor to workspace documents", async () => {
    const { listDocuments } = await import("./documents");

    await listDocuments("workspace-1");

    expect(resolveKnowledgeAccessDomainsMock).not.toHaveBeenCalled();
    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        accessDomain: { in: ["WORKSPACE"] },
        archivedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("uses the actor's resolved knowledge access domains", async () => {
    const { listDocuments } = await import("./documents");
    const actor = { kind: "user", user: { id: "finance-reader" } } as any;
    resolveKnowledgeAccessDomainsMock.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);

    await listDocuments("workspace-1", { actor });

    expect(resolveKnowledgeAccessDomainsMock).toHaveBeenCalledWith(actor, "workspace-1");
    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        accessDomain: { in: ["WORKSPACE", "FINANCE"] },
        archivedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("does not query documents when access resolution fails", async () => {
    const { listDocuments } = await import("./documents");
    const error = new Error("Access denied");
    resolveKnowledgeAccessDomainsMock.mockRejectedValueOnce(error);

    await expect(listDocuments("workspace-1", {
      actor: { kind: "user", user: { id: "blocked-user" } } as any,
    })).rejects.toBe(error);

    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });

  it("preserves archived filtering alongside access domains", async () => {
    const { listDocuments } = await import("./documents");

    await listDocuments("workspace-1", { archiveFilter: "archived" });

    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        accessDomain: { in: ["WORKSPACE"] },
        archivedAt: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("createDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    assertTrialStorageCapacityMock.mockResolvedValue(undefined);
    prismaMock.document.create.mockResolvedValue({
      id: "document-1",
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
    });
    prismaMock.document.findFirst.mockResolvedValue(null);
    prismaMock.document.findMany.mockResolvedValue([]);
    prismaMock.document.update.mockResolvedValue({
      id: "document-1",
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
    });
    prismaMock.brainSource.create.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 2,
    });
    prismaMock.brainSource.findMany.mockResolvedValue([]);
    prismaMock.brainSource.update.mockResolvedValue({});
    prismaMock.brainSource.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue({});
    appendEventsMock.mockResolvedValue(undefined);
  });

  it("creates a Brain source and absorption event for text documents", async () => {
    const { createDocument } = await import("./documents");

    await createDocument({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        sourceType: "DOC",
        title: "Critical path",
        content: expect.stringContaining("The critical path runs through finance approval."),
        authorMemberId: "member-1",
        metadata: expect.objectContaining({ documentId: "document-1" }),
      }),
    });
    expect(appendEventsMock).toHaveBeenCalledWith(prismaMock, expect.arrayContaining([
      expect.objectContaining({ type: "document.created" }),
      expect.objectContaining({
        type: "brain-source.created",
        aggregateId: "source-1",
        payload: { sourceId: "source-1" },
      }),
    ]));
  });

  it("does not persist the synthetic global-operator membership as a Brain source author", async () => {
    const { createDocument } = await import("./documents");

    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "workspace-1",
      userId: "operator-1",
      role: "ADMIN",
      isActive: true,
    });

    await createDocument({ kind: "user", user: { id: "operator-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: null,
      }),
    });
  });

  it("does not create a Brain source for documents without text", async () => {
    const { createDocument } = await import("./documents");

    await createDocument({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Image",
      source: "api",
      storageKey: "image-key",
      mimeType: "image/png",
    });

    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
    expect(appendEventsMock).toHaveBeenCalledWith(prismaMock, [
      expect.objectContaining({ type: "document.created" }),
    ]);
  });

  it("uses an existing document when the duplicate guard resolution says to reuse it", async () => {
    const existingDocument = {
      id: "document-existing",
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-existing-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.document.findMany.mockResolvedValueOnce([existingDocument]);
    prismaMock.document.findFirst.mockResolvedValueOnce(existingDocument);

    const { createDocument } = await import("./documents");
    await expect(createDocument({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
      duplicateGuard: {
        resolution: "use_existing",
        targetEntityId: "document-existing",
      },
    })).resolves.toMatchObject({ id: "document-existing" });

    expect(prismaMock.document.create).not.toHaveBeenCalled();
    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
    expect(assertTrialStorageCapacityMock).not.toHaveBeenCalled();
  });

  it("uses supplied URL and content hash metadata for document duplicate checks", async () => {
    const existingDocument = {
      id: "document-existing",
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-existing-key",
      mimeType: "application/pdf",
      textContent: null,
      metadata: {
        url: "https://example.com/critical-path.pdf",
        contentHash: "hash-from-upstream",
      },
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.document.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingDocument]);
    prismaMock.document.findFirst.mockResolvedValueOnce(existingDocument);

    const { createDocument } = await import("./documents");
    await expect(createDocument({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "application/pdf",
      metadata: {
        url: "https://example.com/critical-path.pdf",
        contentHash: "hash-from-upstream",
      },
      duplicateGuard: {
        onExact: "use_existing",
      },
    })).resolves.toMatchObject({ id: "document-existing" });

    expect(prismaMock.document.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { metadata: { path: ["url"], equals: "https://example.com/critical-path.pdf" } },
          { metadata: { path: ["contentHash"], equals: "hash-from-upstream" } },
        ]),
      }),
    }));
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("refreshes document and file-upload Brain sources when a duplicate document is updated", async () => {
    const existingDocument = {
      id: "document-existing",
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-existing-key",
      mimeType: "text/plain",
      textContent: "The critical path runs through finance approval.",
      metadata: { documentId: "document-existing" },
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.document.findMany.mockResolvedValueOnce([existingDocument]);
    prismaMock.document.findFirst.mockResolvedValueOnce(existingDocument);
    prismaMock.brainSource.findMany.mockResolvedValueOnce([{ id: "source-doc" }, { id: "source-file" }]);
    prismaMock.document.update.mockResolvedValueOnce({
      ...existingDocument,
      textContent: "The critical path runs through finance approval.\n\n---\nAdditional duplicate upload context:\nFinance approval is still the blocker.",
      metadata: { documentId: "document-existing", duplicateGuardUpdatedAt: "2026-07-20T10:10:00.000Z" },
    });

    const { createDocument } = await import("./documents");
    await createDocument({ kind: "user", user: { id: "user-1" } } as any, {
      workspaceId: "workspace-1",
      title: "Critical path",
      source: "api",
      storageKey: "doc-key",
      mimeType: "text/plain",
      textContent: "Finance approval is still the blocker.",
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "document-existing",
      },
    });

    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        sourceType: { in: ["DOC", "FILE_UPLOAD"] },
        metadata: { path: ["documentId"], equals: "document-existing" },
      }),
      select: { id: true },
    }));
    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-doc" },
      data: expect.objectContaining({
        absorbedAt: null,
      }),
    }));
    expect(appendEventsMock).toHaveBeenCalledWith(prismaMock, expect.arrayContaining([
      expect.objectContaining({ type: "document.updated", aggregateId: "document-existing" }),
      expect.objectContaining({ type: "brain-source.created", aggregateId: "source-doc", payload: { sourceId: "source-doc" } }),
      expect.objectContaining({ type: "brain-source.created", aggregateId: "source-file", payload: { sourceId: "source-file" } }),
    ]));
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });
});
