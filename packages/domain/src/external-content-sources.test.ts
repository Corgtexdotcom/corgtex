import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  callBoxExternalMcpReadToolForConnectionMock,
  externalContentSourceMock,
  externalContentSyncLogMock,
  externalMcpConnectionMock,
  workflowJobMock,
  brainSourceMock,
  prismaTransactionMock,
  recordAuditMock,
  requireWorkspaceMembershipMock,
  appendEventsMock,
} = vi.hoisted(() => ({
  callBoxExternalMcpReadToolForConnectionMock: vi.fn(),
  externalContentSourceMock: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  externalContentSyncLogMock: {
    create: vi.fn(),
    update: vi.fn(),
  },
  externalMcpConnectionMock: {
    findFirst: vi.fn(),
  },
  workflowJobMock: {
    create: vi.fn(),
  },
  brainSourceMock: {
    create: vi.fn(),
  },
  prismaTransactionMock: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    externalContentSource: externalContentSourceMock,
    externalContentSyncLog: externalContentSyncLogMock,
    workflowJob: workflowJobMock,
    brainSource: brainSourceMock,
  })),
  recordAuditMock: vi.fn(),
  requireWorkspaceMembershipMock: vi.fn(),
  appendEventsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    externalContentSource: externalContentSourceMock,
    externalMcpConnection: externalMcpConnectionMock,
    $transaction: prismaTransactionMock,
  },
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

vi.mock("./external-mcp", () => ({
  callBoxExternalMcpReadToolForConnection: callBoxExternalMcpReadToolForConnectionMock,
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    workspaceId: "workspace-1",
    connectionId: "connection-1",
    selectedByUserId: "user-1",
    providerKey: "box",
    sourceKind: "FILE",
    externalId: "file-1",
    title: "Launch plan",
    externalUrl: "https://app.box.com/file/file-1",
    syncMode: "SELECTED",
    status: "ACTIVE",
    lastRemoteVersion: "v1",
    lastSyncedAt: null,
    lastSyncError: null,
    metadata: {},
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-06-30T20:00:00.000Z"),
    updatedAt: new Date("2026-06-30T20:00:00.000Z"),
    ...overrides,
  };
}

describe("external content sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1" });
    recordAuditMock.mockResolvedValue({ id: "audit-1" });
    appendEventsMock.mockResolvedValue(undefined);
    externalContentSyncLogMock.create.mockResolvedValue({ id: "sync-log-1" });
    externalContentSourceMock.update.mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data }));
    externalContentSourceMock.updateMany.mockResolvedValue({ count: 1 });
    externalContentSyncLogMock.update.mockResolvedValue({ id: "sync-log-1" });
    workflowJobMock.create.mockResolvedValue({ id: "job-queued" });
    brainSourceMock.create.mockResolvedValue({ id: "brain-source-1" });
  });

  it("selects a Box source, stores connection ownership, and queues curated sync", async () => {
    externalMcpConnectionMock.findFirst.mockResolvedValueOnce({
      id: "connection-1",
      providerEmail: "box@example.com",
      providerAccountId: "box-user-1",
    });
    externalContentSourceMock.upsert.mockResolvedValueOnce(source({ status: "SYNCING" }));
    const { selectExternalContentSource } = await import("./external-content-sources");

    const result = await selectExternalContentSource(actor, {
      workspaceId: "workspace-1",
      providerKey: "box",
      sourceKind: "HUB",
      externalId: "hub-1",
      title: "Client Hub",
    });

    expect(result.id).toBe("source-1");
    expect(externalMcpConnectionMock.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-1",
        providerKey: "box",
        status: "ACTIVE",
      }),
    }));
    expect(externalContentSourceMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_providerKey_sourceKind_externalId: {
          workspaceId: "workspace-1",
          providerKey: "box",
          sourceKind: "HUB",
          externalId: "hub-1",
        },
      },
      create: expect.objectContaining({
        connectionId: "connection-1",
        selectedByUserId: "user-1",
        providerKey: "box",
        syncMode: "SELECTED",
        status: "SYNCING",
      }),
    }));
    expect(workflowJobMock.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        type: "knowledge.sync.external-content",
        payload: { sourceId: "source-1" },
      },
    });
  });

  it("syncs a changed selected file into external content chunks and a Brain snapshot", async () => {
    const syncKnowledge = vi.fn().mockResolvedValue(2);
    externalContentSourceMock.findFirst.mockResolvedValueOnce(source());
    callBoxExternalMcpReadToolForConnectionMock
      .mockResolvedValueOnce({
        id: "file-1",
        name: "Launch plan",
        etag: "v2",
        file_version: { id: "v2" },
      })
      .mockResolvedValueOnce({ text: "Launch owner is Milan." });
    const { syncExternalContentSource } = await import("./external-content-sources");

    const result = await syncExternalContentSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      syncKnowledge,
    });

    expect(callBoxExternalMcpReadToolForConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      connectionId: "connection-1",
      toolName: "get_file_details",
      arguments: expect.objectContaining({ file_id: "file-1" }),
    }));
    expect(callBoxExternalMcpReadToolForConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({
      toolName: "get_file_content",
      arguments: { file_id: "file-1" },
    }));
    expect(syncKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceType: "EXTERNAL_CONTENT",
      sourceId: "source-1",
      sourceTitle: "Launch plan",
      content: expect.stringContaining("Launch owner is Milan."),
      metadata: expect.objectContaining({
        providerKey: "box",
        sourceKind: "FILE",
        externalContentSourceId: "source-1",
        snapshotType: "box_synced_snapshot",
        workflowJobId: "job-1",
      }),
      workflowJobId: "job-1",
    }));
    expect(brainSourceMock.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceType: "EXTERNAL_CONTENT",
        externalId: "box:file:file-1:v2",
        channel: "box",
      }),
    }));
    expect(externalContentSyncLogMock.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sync-log-1" },
      data: expect.objectContaining({
        status: "SYNCED",
        remoteVersion: "v2",
        chunksCreated: 2,
        brainSourceId: "brain-source-1",
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "SYNCED",
      chunksCreated: 2,
      brainSourceId: "brain-source-1",
    }));
  });

  it("treats unchanged remote versions as a no-op without replacing chunks", async () => {
    const syncKnowledge = vi.fn();
    externalContentSourceMock.findFirst.mockResolvedValueOnce(source({ lastRemoteVersion: "v2" }));
    callBoxExternalMcpReadToolForConnectionMock
      .mockResolvedValueOnce({ id: "file-1", name: "Launch plan", etag: "v2" })
      .mockResolvedValueOnce({ text: "Launch owner is Milan." });
    const { syncExternalContentSource } = await import("./external-content-sources");

    const result = await syncExternalContentSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      syncKnowledge,
    });

    expect(syncKnowledge).not.toHaveBeenCalled();
    expect(brainSourceMock.create).not.toHaveBeenCalled();
    expect(externalContentSyncLogMock.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "UNCHANGED",
        remoteVersion: "v2",
        chunksCreated: 0,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "UNCHANGED",
      chunksCreated: 0,
    }));
  });

  it("records sync errors without deleting prior good context", async () => {
    externalContentSourceMock.findFirst.mockResolvedValueOnce(source());
    callBoxExternalMcpReadToolForConnectionMock.mockRejectedValueOnce(new Error("Box unavailable"));
    const { syncExternalContentSource } = await import("./external-content-sources");

    await expect(syncExternalContentSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      workflowJobId: "job-1",
      syncKnowledge: vi.fn(),
    })).rejects.toThrow("Box unavailable");

    expect(externalContentSourceMock.updateMany).toHaveBeenCalledWith({
      where: { id: "source-1", workspaceId: "workspace-1" },
      data: {
        status: "ERROR",
        lastSyncError: "Box unavailable",
      },
    });
    expect(externalContentSyncLogMock.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ERROR",
        error: "Box unavailable",
      }),
    }));
    expect(brainSourceMock.create).not.toHaveBeenCalled();
  });
});
