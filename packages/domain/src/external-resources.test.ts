import type { AppActor } from "@corgtex/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  callBoxExternalMcpReadToolMock,
  getExternalMcpConnectionAccessTokenMock,
  prismaMock,
  recordAuditMock,
  requireWorkspaceMembershipMock,
  txMock,
} = vi.hoisted(() => {
  const tx = {
    action: { findFirst: vi.fn() },
    brainSource: { findFirst: vi.fn() },
    knowledgeChunk: { deleteMany: vi.fn() },
    meeting: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    tension: { findFirst: vi.fn() },
    workflowJob: { upsert: vi.fn() },
    workspaceExternalResource: {
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceExternalResourceAttachment: {
      createMany: vi.fn(),
    },
  };

  return {
    callBoxExternalMcpReadToolMock: vi.fn(),
    getExternalMcpConnectionAccessTokenMock: vi.fn(),
    prismaMock: {
      $transaction: vi.fn(),
      knowledgeChunk: { deleteMany: vi.fn() },
      workspaceExternalResource: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      workspaceExternalResourceAttachment: {
        findMany: vi.fn(),
      },
    },
    recordAuditMock: vi.fn(),
    requireWorkspaceMembershipMock: vi.fn(),
    txMock: tx,
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./external-mcp", () => ({
  callBoxExternalMcpReadTool: callBoxExternalMcpReadToolMock,
  getExternalMcpConnectionAccessToken: getExternalMcpConnectionAccessTokenMock,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

function resourceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    workspaceId: "ws-1",
    createdByUserId: "user-1",
    providerKey: "box",
    externalId: "file:file-123",
    resourceType: "file",
    title: "Budget.xlsx",
    url: "https://app.box.com/file/file-123",
    sharedLinkUrl: "https://app.box.com/s/budget",
    mimeType: "application/x-box-xlsx",
    descriptionMd: "Client budget model",
    summaryMd: "Budget workbook summary",
    metadata: {
      box: {
        id: "file-123",
        type: "file",
      },
      sourceUrl: "https://app.box.com/s/budget",
    },
    lastEnrichedAt: new Date("2026-06-28T17:00:00.000Z"),
    lastEnrichmentError: null,
    archivedAt: null,
    archiveReason: null,
    createdAt: new Date("2026-06-28T17:00:00.000Z"),
    updatedAt: new Date("2026-06-28T17:00:00.000Z"),
    ...overrides,
  };
}

describe("workspace external resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    getExternalMcpConnectionAccessTokenMock.mockResolvedValue({
      accessToken: "box-access-token",
      provider: { providerKey: "box" },
      connection: { id: "box-connection-1" },
    });
    callBoxExternalMcpReadToolMock.mockResolvedValue({ answer: "Budget workbook summary" });
    txMock.action.findFirst.mockResolvedValue({ id: "action-1" });
    txMock.workspaceExternalResource.upsert.mockResolvedValue(resourceFixture());
    txMock.workspaceExternalResourceAttachment.createMany.mockResolvedValue({ count: 1 });
    txMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });
    recordAuditMock.mockResolvedValue({ id: "audit-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a pasted Box shared link, enriches it, and attaches the stable resource to an action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "file-123",
      type: "file",
      name: "Budget.xlsx",
      description: "Original Box description",
      extension: "xlsx",
      etag: "1",
      modified_at: "2026-06-28T16:55:00Z",
      owned_by: { login: "owner@example.com" },
      shared_link: { url: "https://app.box.com/s/budget" },
      size: 2048,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { upsertWorkspaceExternalResourceFromUrl } = await import("./external-resources");
    const result = await upsertWorkspaceExternalResourceFromUrl(actor, {
      workspaceId: "ws-1",
      url: " https://app.box.com/s/budget#preview ",
      descriptionMd: "Client budget model",
      entityType: "Action",
      entityId: "action-1",
      purpose: "reference",
    });

    expect(result).toMatchObject({
      id: "resource-1",
      externalId: "file:file-123",
      title: "Budget.xlsx",
      summaryMd: "Budget workbook summary",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.box.com/2.0/shared_items?fields="),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer box-access-token",
          boxapi: "shared_link=https://app.box.com/s/budget",
        }),
      }),
    );
    expect(callBoxExternalMcpReadToolMock).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1",
      toolName: "ai_qa_single_file",
      arguments: expect.objectContaining({
        file_id: "file-123",
      }),
    }));
    expect(txMock.workspaceExternalResource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_providerKey_externalId: {
          workspaceId: "ws-1",
          providerKey: "box",
          externalId: "file:file-123",
        },
      },
      update: expect.objectContaining({
        archivedAt: null,
        descriptionMd: "Client budget model",
        summaryMd: "Budget workbook summary",
      }),
      create: expect.objectContaining({
        createdByUserId: "user-1",
        providerKey: "box",
        externalId: "file:file-123",
        title: "Budget.xlsx",
      }),
    }));
    expect(txMock.workspaceExternalResourceAttachment.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "ws-1",
        resourceId: "resource-1",
        entityType: "Action",
        entityId: "action-1",
        purpose: "reference",
        createdByUserId: "user-1",
      }],
      skipDuplicates: true,
    });
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "knowledge.sync.external-resource",
        payload: { resourceId: "resource-1" },
      }),
      where: {
        dedupeKey: expect.stringMatching(/^external-resource:resource-1:knowledge:/),
      },
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(
      txMock,
      actor,
      expect.objectContaining({
        action: "external-resource.attached",
        meta: expect.objectContaining({
          providerKey: "box",
          targetType: "Action",
          targetId: "action-1",
        }),
      }),
    );
  });

  it("keeps failed Box AI enrichment from blocking saved references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "file-123",
      type: "file",
      name: "Budget.xlsx",
      extension: "xlsx",
      shared_link: { url: "https://app.box.com/s/budget" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    callBoxExternalMcpReadToolMock.mockRejectedValueOnce(new Error("Box AI temporarily unavailable."));
    txMock.workspaceExternalResource.upsert.mockResolvedValue(resourceFixture({
      descriptionMd: null,
      summaryMd: null,
      lastEnrichmentError: "Box AI temporarily unavailable.",
    }));

    const { upsertWorkspaceExternalResourceFromUrl } = await import("./external-resources");
    const result = await upsertWorkspaceExternalResourceFromUrl(actor, {
      workspaceId: "ws-1",
      url: "https://app.box.com/s/budget",
    });

    expect(result).toMatchObject({
      id: "resource-1",
      summaryMd: null,
      lastEnrichmentError: "Box AI temporarily unavailable.",
    });
    expect(txMock.workspaceExternalResource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        lastEnrichmentError: "Box AI temporarily unavailable.",
      }),
      create: expect.objectContaining({
        lastEnrichmentError: "Box AI temporarily unavailable.",
      }),
    }));
    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it("searches saved external resources by summary and metadata fields without reading Box again", async () => {
    prismaMock.workspaceExternalResource.findMany.mockResolvedValueOnce([resourceFixture()]);

    const { listWorkspaceExternalResources } = await import("./external-resources");
    const resources = await listWorkspaceExternalResources(actor, {
      workspaceId: "ws-1",
      providerKey: "box",
      query: "budget",
      take: 250,
    });

    expect(resources).toHaveLength(1);
    expect(prismaMock.workspaceExternalResource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        archivedAt: null,
        providerKey: "box",
        OR: [
          { title: { contains: "budget", mode: "insensitive" } },
          { descriptionMd: { contains: "budget", mode: "insensitive" } },
          { summaryMd: { contains: "budget", mode: "insensitive" } },
          { url: { contains: "budget", mode: "insensitive" } },
        ],
      }),
      take: 100,
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("archives saved references and removes only the Corgtex-owned Brain summary chunks", async () => {
    prismaMock.workspaceExternalResource.findFirst.mockResolvedValueOnce({ id: "resource-1" });
    txMock.workspaceExternalResource.update.mockResolvedValueOnce(resourceFixture({ archivedAt: new Date("2026-06-28T18:00:00.000Z") }));
    txMock.knowledgeChunk.deleteMany.mockResolvedValueOnce({ count: 1 });

    const { archiveWorkspaceExternalResource } = await import("./external-resources");
    const result = await archiveWorkspaceExternalResource(actor, {
      workspaceId: "ws-1",
      resourceId: "resource-1",
      reason: "Superseded",
    });

    expect(result).toEqual({ id: "resource-1" });
    expect(txMock.workspaceExternalResource.update).toHaveBeenCalledWith({
      where: { id: "resource-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedByUserId: "user-1",
        archiveReason: "Superseded",
      }),
    });
    expect(txMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        sourceType: "EXTERNAL_RESOURCE",
        sourceId: "resource-1",
      },
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      txMock,
      actor,
      expect.objectContaining({
        action: "external-resource.archived",
        entityId: "resource-1",
      }),
    );
  });

  it("rejects non-Box URLs before touching external systems", async () => {
    const { upsertWorkspaceExternalResourceFromUrl } = await import("./external-resources");

    await expect(upsertWorkspaceExternalResourceFromUrl(actor, {
      workspaceId: "ws-1",
      url: "https://example.com/not-box",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(getExternalMcpConnectionAccessTokenMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
