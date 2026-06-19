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
    workspaceFeatureFlag: {
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
    "brain:write",
    "conversations:write",
    "data-sources:read",
    "documents:write",
    "finance:read",
    "finance:write",
    "integrations:read",
    "meetings:read",
    "meetings:write",
    "runtime:read",
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
    appCategory: "OTHER",
    appVisibility: "WORKSPACE_PRIVATE",
    hostingMode: "EXTERNAL_URL",
    integrationDepth: "CATALOG_ONLY",
    installationStatus: "INSTALLED",
    supportUrl: null,
    appMcpUrl: null,
    dataClassification: "INTERNAL",
    proofUrl: null,
    reviewUrl: null,
    manifestJson: null,
    capabilitiesJson: null,
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
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
    vi.stubEnv("SLACK_CLIENT_ID", "");
    vi.stubEnv("SLACK_CLIENT_SECRET", "");
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
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([]);
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
      update: expect.objectContaining({
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
      }),
    }));
    expect(prismaMock.catalogSettings.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      create: { workspaceId: "workspace-1", approvalMode: "ADMIN" },
      update: {},
    });
  });

  it("hides stale derived catalog items when backing features or connectors are unavailable", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "AGENT_GOVERNANCE", enabled: false },
      { flag: "AI_WORKSPACES", enabled: false },
      { flag: "BUILD_ARTIFACTS", enabled: false },
      { flag: "MANAGED_ENTERPRISE_SERVICES", enabled: false },
      { flag: "MEETING_RECORDERS", enabled: false },
      { flag: "SETTINGS_GENERAL", enabled: false },
    ]);
    prismaMock.catalogItem.findMany.mockResolvedValue([
      catalogItemFixture({ id: "tool-1", title: "Miro board", sourceType: "TOOL_LINK", sourceId: "tool-1" }),
      catalogItemFixture({ id: "agent-1", title: "Planning agent", sourceType: "AGENT_CONFIG", sourceId: "planning-agent" }),
      catalogItemFixture({ id: "build-1", title: "Internal app", sourceType: "BUILD_ARTIFACT", sourceId: "build-1" }),
      catalogItemFixture({ id: "recorder-1", title: "Meeting recorder", sourceType: "MEETING_RECORDER", sourceId: "meeting-recorder" }),
      catalogItemFixture({ id: "data-1", title: "Warehouse", sourceType: "DATA_SOURCE", sourceId: "data-1" }),
      catalogItemFixture({ id: "mcp-1", title: "Corgtex MCP", sourceType: "MCP_CONNECTOR", sourceId: "corgtex-mcp" }),
      catalogItemFixture({ id: "openwork-1", title: "OpenWork Free", sourceType: "AI_WORKSPACE", sourceId: "openwork" }),
      catalogItemFixture({ id: "managed-1", title: "Managed AI workspace", sourceType: "ENTERPRISE_SERVICE", sourceId: "ai_workspace" }),
      catalogItemFixture({ id: "google-1", title: "Google", sourceType: "OAUTH_CONNECTION", sourceId: "google" }),
    ]);

    const result = await listCatalogItems(actor, "workspace-1");

    expect(result.items.map((item) => item.title)).toEqual(["Miro board"]);
  });

  it("derives AI workspace catalog cards from the provider registry when enabled", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "AI_WORKSPACES", enabled: true },
      { flag: "OPENWORK_DEFAULT", enabled: true },
    ]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MCP_CONNECTOR",
          sourceId: "corgtex-mcp",
        },
      },
      create: expect.objectContaining({
        title: "Corgtex MCP",
        url: null,
      }),
      update: expect.objectContaining({
        title: "Corgtex MCP",
        url: null,
      }),
    }));
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "AI_WORKSPACE",
          sourceId: "openwork",
        },
      },
      create: expect.objectContaining({
        type: "CONNECTOR",
        title: "OpenWork Free",
        url: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=openwork",
        category: "AI_DEFAULT",
        accessMode: "OPEN",
        requestedScopes: ["workspace:read", "brain:read", "conversations:write"],
        featured: true,
      }),
      update: expect.objectContaining({
        title: "OpenWork Free",
        url: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=openwork",
        category: "AI_DEFAULT",
        accessMode: "OPEN",
        featured: true,
      }),
    }));
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "AI_WORKSPACE",
          sourceId: "chatgpt",
        },
      },
      create: expect.objectContaining({
        title: "ChatGPT",
        url: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=chatgpt",
        category: "AI_BYO",
        featured: false,
      }),
    }));
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "AI_WORKSPACE",
          sourceId: "copilot",
        },
      },
      create: expect.objectContaining({
        title: "GitHub Copilot",
        url: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=copilot",
        category: "AI_BYO",
        featured: false,
      }),
    }));
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "AI_WORKSPACE",
          sourceId: "generic_mcp",
        },
      },
      create: expect.objectContaining({
        category: "AI_ADVANCED",
      }),
    }));
  });

  it("derives managed enterprise service request cards when enabled", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "AI_WORKSPACES", enabled: true },
      { flag: "MANAGED_ENTERPRISE_SERVICES", enabled: true },
    ]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "ENTERPRISE_SERVICE",
          sourceId: "ai_workspace",
        },
      },
      create: expect.objectContaining({
        type: "TOOL",
        title: "Managed AI workspace",
        url: "/workspaces/workspace-1/settings?tab=ai-workspaces&service=ai_workspace",
        category: "ENTERPRISE_SERVICES",
        accessMode: "REQUEST",
        requestedScopes: ["workspace:read", "integrations:read", "runtime:read"],
      }),
    }));
    expect(prismaMock.catalogItem.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "ENTERPRISE_SERVICE",
          sourceId: "meeting_recorder",
        },
      },
    }));
  });

  it("does not derive Practice Ledger as an installable marketplace app", async () => {
    const { listCatalogItems } = await import("./catalog");
    vi.stubEnv("PRACTICE_LEDGER_APP_URL", "https://practice-ledger.example.com");
    vi.stubEnv("PRACTICE_LEDGER_MCP_URL", "https://practice-ledger.example.com/mcp");
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MARKETPLACE_APP",
          sourceId: "practice-ledger",
        },
      },
    }));
  });

  it("does not derive managed enterprise services without the AI workspace setup surface", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "AI_WORKSPACES", enabled: false },
      { flag: "MANAGED_ENTERPRISE_SERVICES", enabled: true },
    ]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([
      catalogItemFixture({
        id: "managed-1",
        title: "Managed AI workspace",
        sourceType: "ENTERPRISE_SERVICE",
        sourceId: "ai_workspace",
      }),
    ]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    const result = await listCatalogItems(actor, "workspace-1");

    expect(result.items).toHaveLength(0);
    expect(prismaMock.catalogItem.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "ENTERPRISE_SERVICE",
          sourceId: "ai_workspace",
        },
      },
    }));
  });

  it("rejects actions against unavailable derived catalog items", async () => {
    const { createCatalogRequest, setCatalogFavorite } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "AGENT_GOVERNANCE", enabled: false },
    ]);
    prismaMock.catalogItem.findFirst.mockResolvedValue(catalogItemFixture({
      id: "agent-1",
      sourceType: "AGENT_CONFIG",
      sourceId: "planning-agent",
      title: "Planning agent",
    }));

    await expect(createCatalogRequest(actor, {
      workspaceId: "workspace-1",
      catalogItemId: "agent-1",
      type: "API_KEY",
      reasonMd: "Use stale agent.",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    await expect(setCatalogFavorite(actor, {
      workspaceId: "workspace-1",
      catalogItemId: "agent-1",
      favorite: true,
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(prismaMock.catalogRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.catalogFavorite.upsert).not.toHaveBeenCalled();
  });

  it("derives configured connector cards but skips connector routes without env support", async () => {
    const { listCatalogItems } = await import("./catalog");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "OAUTH_CONNECTION",
          sourceId: "google",
        },
      },
    }));
    expect(prismaMock.catalogItem.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "OAUTH_CONNECTION",
          sourceId: "microsoft",
        },
      },
    }));
    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MCP_CONNECTOR",
          sourceId: "box",
        },
      },
      create: expect.objectContaining({
        type: "CONNECTOR",
        title: "Box",
        url: null,
        accessMode: "REQUEST",
        featured: true,
        manifestJson: expect.objectContaining({
          connectorReadiness: expect.objectContaining({
            availability: "PILOT_READY",
            connectMethod: "external_mcp",
          }),
        }),
      }),
    }));
  });

  it("derives meeting transcripts as a requestable Tools option before transcript access is enabled", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MEETING_RECORDER",
          sourceId: "meeting-recorder",
        },
      },
      create: expect.objectContaining({
        type: "TOOL",
        title: "Meeting transcripts",
        url: null,
        category: "MEETINGS",
        accessMode: "REQUEST",
        requestedScopes: ["meetings:read", "meetings:write", "brain:read"],
        featured: true,
      }),
      update: expect.objectContaining({
        type: "TOOL",
        url: null,
        accessMode: "REQUEST",
        requestedScopes: ["meetings:read", "meetings:write", "brain:read"],
        featured: true,
      }),
    }));
  });

  it("keeps meeting transcript setup canonical inside Tools when recorder access is enabled", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "MEETING_RECORDERS", enabled: true },
    ]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MEETING_RECORDER",
          sourceId: "meeting-recorder",
        },
      },
      create: expect.objectContaining({
        type: "TOOL",
        url: null,
        accessMode: "OPEN",
        featured: true,
      }),
      update: expect.objectContaining({
        type: "TOOL",
        url: null,
        accessMode: "OPEN",
        featured: true,
      }),
    }));
  });

  it("opens meeting transcript setup when transcript-source access is enabled without recorder access", async () => {
    const { listCatalogItems } = await import("./catalog");
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([
      { flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true },
      { flag: "MEETING_RECORDERS", enabled: false },
    ]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([]);
    prismaMock.catalogItem.findMany.mockResolvedValue([]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    await listCatalogItems(actor, "workspace-1");

    expect(prismaMock.catalogItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_sourceType_sourceId: {
          workspaceId: "workspace-1",
          sourceType: "MEETING_RECORDER",
          sourceId: "meeting-recorder",
        },
      },
      create: expect.objectContaining({
        title: "Meeting transcripts",
        accessMode: "OPEN",
      }),
      update: expect.objectContaining({
        accessMode: "OPEN",
      }),
    }));
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

  it("ignores stale Practice Ledger app rows when routing finance intents", async () => {
    const { getAppRoutingGuidance } = await import("./catalog");
    prismaMock.catalogItem.findMany.mockResolvedValue([
      catalogItemFixture({
        id: "practice-ledger",
        type: "APP",
        sourceType: "MARKETPLACE_APP",
        sourceId: "practice-ledger",
        title: "Practice Ledger",
        appCategory: "FINANCE",
        integrationDepth: "KNOWLEDGE_SYNCED",
        installationStatus: "INSTALLED",
        appMcpUrl: "https://practice-ledger.example.com/mcp",
        capabilitiesJson: [{ key: "expenses.create_draft" }],
      }),
    ]);
    prismaMock.catalogFavorite.findMany.mockResolvedValue([]);
    prismaMock.catalogRequest.findMany.mockResolvedValue([]);

    const result = await getAppRoutingGuidance(actor, {
      workspaceId: "workspace-1",
      intent: "save these expenses from my account statement",
    });

    expect(result).toMatchObject({
      routing: "CORGTEX_MCP",
      target: {
        appKey: "corgtex",
        title: "Corgtex Practice Ledger",
      },
      corgtexDoesNotProxyWrites: false,
    });
  });
});
