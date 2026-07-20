import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    $transaction: vi.fn(async (cb: any) => cb(mock)),
    document: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    brainSource: {
      create: vi.fn(),
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
    prismaMock.brainSource.create.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 2,
    });
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
});
