import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    $transaction: vi.fn(async (cb: any) => cb(mock)),
    document: {
      create: vi.fn(),
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
});
