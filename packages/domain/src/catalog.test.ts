import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, randomOpaqueTokenMock, sha256Mock, toInputJsonMock } = vi.hoisted(() => ({
  randomOpaqueTokenMock: vi.fn(() => "secret-1"),
  sha256Mock: vi.fn((value: string) => `hash:${value}`),
  toInputJsonMock: vi.fn((value: unknown) => value),
  prismaMock: {
    $transaction: vi.fn(),
    workspaceToolLink: {
      findMany: vi.fn(),
    },
    workspaceAgentConfig: {
      findMany: vi.fn(),
    },
    buildArtifact: {
      findMany: vi.fn(),
    },
    externalDataSource: {
      findMany: vi.fn(),
    },
    catalogItem: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    catalogFavorite: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    catalogRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    catalogSettings: {
      upsert: vi.fn(),
    },
    modelUsage: {
      findMany: vi.fn(),
    },
    agentCredential: {
      count: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.hoisted(() => vi.fn());
const actorUserIdForWorkspace = vi.hoisted(() => vi.fn());
const recordAudit = vi.hoisted(() => vi.fn());

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  randomOpaqueToken: randomOpaqueTokenMock,
  sha256: sha256Mock,
  toInputJson: toInputJsonMock,
}));

vi.mock("./agent-auth", () => ({
  ALL_SCOPES: [
    "agents:read",
    "brain:read",
    "conversations:write",
    "data-sources:read",
    "documents:write",
    "integrations:read",
    "meetings:read",
    "meetings:write",
    "tools:read",
    "workspace:read",
  ],
}));

vi.mock("./agent-registry", () => ({
  AGENT_REGISTRY: {
    "planning-agent": {
      label: "Planning agent",
      outputs: ["Plans"],
      description: "Turns workspace goals into plans.",
      category: "operations",
      costTier: "low",
    },
  },
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace,
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
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

const createdAt = new Date("2026-05-06T12:00:00.000Z");

function catalogItemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog-1",
    workspaceId: "workspace-1",
    createdByUserId: "user-1",
    ownerUserId: "user-1",
    type: "TOOL",
    sourceType: "TOOL_LINK",
    sourceId: "tool-1",
    title: "Miro board",
    slug: "tool-link-tool-1",
    outcome: "Plan launches together.",
    descriptionMd: "Shared planning board.",
    accessNotesMd: null,
    url: "https://miro.com/app/board/example",
    category: "WHITEBOARD",
    status: "PUBLISHED",
    accessMode: "OPEN",
    requestedScopes: ["tools:read"],
    monthlyBudgetCents: null,
    dailyCallLimit: null,
    featured: false,
    archivedAt: null,
    archivedByUserId: null,
    archiveReason: null,
    createdAt,
    updatedAt: createdAt,
    createdBy: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
    },
    owner: {
      id: "user-1",
      email: "user@example.com",
      displayName: "User",
    },
    ...overrides,
  };
}

describe("catalog domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    actorUserIdForWorkspace.mockResolvedValue("admin-1");
    recordAudit.mockResolvedValue(undefined);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([
      {
        id: "tool-1",
        title: "Miro board",
        url: "https://miro.com/app/board/example",
        category: "WHITEBOARD",
        descriptionMd: "Shared planning board.",
        accessNotesMd: null,
        createdByUserId: "user-1",
      },
    ]);
    prismaMock.workspaceAgentConfig.findMany.mockResolvedValue([]);
    prismaMock.buildArtifact.findMany.mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.upsert.mockResolvedValue(catalogItemFixture());
    prismaMock.catalogItem.findMany.mockResolvedValue([catalogItemFixture()]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([{ catalogItemId: "catalog-1" }]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([{ catalogItemId: "catalog-1" }]);
    prismaMock.catalogSettings.upsert.mockResolvedValue({
      id: "settings-1",
      workspaceId: "workspace-1",
      approvalMode: "ADMIN",
    });
    prismaMock.catalogItem.findFirst.mockResolvedValue(catalogItemFixture());
    prismaMock.catalogRequest.create.mockResolvedValue({
      id: "request-1",
      workspaceId: "workspace-1",
      catalogItemId: "catalog-1",
      requesterUserId: "user-1",
      type: "API_KEY",
      status: "PENDING",
      reasonMd: "Power a dashboard.",
      requestedScopes: ["tools:read"],
      requestedBudgetCents: 1000,
      requestedDailyCallLimit: 50,
      title: null,
      payloadJson: null,
      createdAt,
      updatedAt: createdAt,
    });
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.catalogItem.findUnique.mockResolvedValue(null);
    prismaMock.catalogRequest.findFirst.mockResolvedValue({
      id: "request-1",
      workspaceId: "workspace-1",
      catalogItemId: "catalog-1",
      requesterUserId: "user-1",
      type: "API_KEY",
      status: "PENDING",
      reasonMd: "Power a dashboard.",
      requestedScopes: ["tools:read"],
      requestedBudgetCents: 1000,
      requestedDailyCallLimit: 50,
      title: null,
      payloadJson: null,
      catalogItem: catalogItemFixture({
        requestedScopes: ["tools:read"],
        monthlyBudgetCents: 500,
        dailyCallLimit: 10,
      }),
    });
    prismaMock.catalogRequest.update.mockResolvedValue({
      id: "request-1",
      status: "APPROVED",
      catalogItemId: "catalog-1",
    });
    prismaMock.agentCredential.create.mockResolvedValue({ id: "credential-1" });
  });

  it("derives visible catalog items and annotates favorites, uploads, and pending requests", async () => {
    const { listCatalogItems } = await import("./catalog");

    const result = await listCatalogItems(actor, "workspace-1");

    expect(result.canManage).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "catalog-1",
      title: "Miro board",
      isFavorite: true,
      isUploaded: true,
      pendingRequestCount: 1,
    });
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "TOOL_LINK",
          sourceId: "tool-1",
        },
      },
    }));
    expect(prismaMock.catalogSettings.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      create: { workspaceId: "workspace-1", approvalMode: "ADMIN" },
      update: {},
    });
  });

  it("creates a catalog request with normalized scopes and budget limits", async () => {
    const { createCatalogRequest } = await import("./catalog");

    await createCatalogRequest(actor, {
      workspaceId: "workspace-1",
      catalogItemId: "catalog-1",
      type: "API_KEY",
      reasonMd: " Power a dashboard. ",
      requestedScopes: ["tools:read", "tools:read"],
      requestedBudgetCents: 1000,
      requestedDailyCallLimit: 50,
    });

    expect(prismaMock.catalogRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        catalogItemId: "catalog-1",
        requesterUserId: "user-1",
        type: "API_KEY",
        reasonMd: "Power a dashboard.",
        requestedScopes: ["tools:read"],
        requestedBudgetCents: 1000,
        requestedDailyCallLimit: 50,
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "catalog.request_created",
        entityType: "CatalogRequest",
      }),
    }));
  });

  it("approves API key requests by issuing catalog-scoped credentials", async () => {
    const { decideCatalogRequest } = await import("./catalog");

    const result = await decideCatalogRequest(actor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      status: "APPROVED",
      decisionNoteMd: "Approved.",
    });

    expect(result.token).toBe("agentc-secret-1");
    expect(prismaMock.agentCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        createdByUserId: "user-1",
        catalogItemId: "catalog-1",
        label: "Miro board API key",
        tokenHash: "hash:secret-1",
        scopes: ["tools:read"],
        reasonMd: "Power a dashboard.",
        monthlyBudgetCents: 1000,
        dailyCallLimit: 50,
        isActive: true,
      }),
    });
    expect(prismaMock.catalogRequest.update).toHaveBeenCalledWith({
      where: { id: "request-1" },
      data: expect.objectContaining({
        status: "APPROVED",
        decidedByUserId: "admin-1",
        decisionNoteMd: "Approved.",
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(
      prismaMock,
      actor,
      expect.objectContaining({
        action: "catalog.request_approved",
        entityType: "CatalogRequest",
      }),
    );
  });
});
