import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, randomOpaqueTokenMock, sha256Mock, toInputJsonMock } = vi.hoisted(() => ({
  randomOpaqueTokenMock: vi.fn(() => "launch-token"),
  sha256Mock: vi.fn((value: string) => `hash:${value}`),
  toInputJsonMock: vi.fn((value: unknown) => value),
  prismaMock: {
    $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock)),
    appDefinition: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    appRuntime: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    appRelease: {
      updateMany: vi.fn(),
    },
    appInstallation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    appSurfaceAssignment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    appSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.hoisted(() => vi.fn());
const recordAudit = vi.hoisted(() => vi.fn());

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  randomOpaqueToken: randomOpaqueTokenMock,
  sha256: sha256Mock,
  toInputJson: toInputJsonMock,
}));

vi.mock("./agent-auth", () => ({
  ALL_SCOPES: [
    "workspace:read",
    "brain:read",
    "brain:write",
    "finance:read",
    "finance:write",
  ],
}));

vi.mock("./auth", () => ({
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

const now = new Date("2026-06-07T19:00:00.000Z");

function definitionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "definition-1",
    appKey: "practice-ledger",
    title: "Practice Ledger",
    descriptionMd: "Finance app.",
    repositoryUrl: "https://github.com/Corgtexdotcom/practice-ledger",
    manifestUrl: "https://practice-ledger.test/.well-known/corgtex-app.json",
    category: "FINANCE",
    visibility: "CORGTEX_MANAGED",
    defaultHostingMode: "CORGTEX_MANAGED_EXTERNAL",
    defaultIntegrationDepth: "KNOWLEDGE_SYNCED",
    dataClassification: "CLIENT_PRIVATE",
    supportedSurfaces: ["FINANCE"],
    requestedScopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
    manifestJson: {},
    capabilitiesJson: [],
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runtimeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "runtime-1",
    appDefinitionId: "definition-1",
    customerDeploymentId: null,
    mode: "SHARED_MULTI_TENANT",
    status: "ACTIVE",
    environment: "production",
    baseUrl: "https://practice-ledger.test",
    healthUrl: "https://practice-ledger.test/api/health",
    mcpUrl: "https://practice-ledger.test/api/mcp",
    railwayProjectId: null,
    railwayEnvironmentId: null,
    railwayServiceId: null,
    secretsRef: null,
    lastHealthAt: now,
    lastHealthStatus: "ok",
    lastHealthError: null,
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function releaseFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "release-1",
    appDefinitionId: "definition-1",
    runtimeId: "runtime-1",
    version: "0.1.0",
    gitSha: "abc123",
    imageTag: "practice-ledger:0.1.0",
    manifestVersion: "0.1.0",
    status: "ACTIVE",
    healthStatus: "ok",
    releasedAt: now,
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runtimeWithRelationsFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...runtimeFixture(),
    appDefinition: definitionFixture(),
    installations: [installationFixture()],
    releases: [releaseFixture()],
    ...overrides,
  };
}

function installationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "installation-1",
    workspaceId: "workspace-1",
    appDefinitionId: "definition-1",
    catalogItemId: "catalog-1",
    runtimeId: "runtime-1",
    releaseId: null,
    status: "INSTALLED",
    tenantExternalId: "practice-org-1",
    tenantMappingJson: { organizationId: "practice-org-1" },
    installedByUserId: "user-1",
    installedAt: now,
    requestedScopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
    grantedScopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
    launchPath: "/dashboard?embedded=1",
    sessionTtlSeconds: 300,
    configJson: null,
    lastHealthAt: now,
    lastHealthStatus: "ok",
    lastHealthError: null,
    createdAt: now,
    updatedAt: now,
    appDefinition: definitionFixture(),
    runtime: runtimeFixture(),
    release: null,
    catalogItem: {
      id: "catalog-1",
      title: "Practice Ledger",
      url: "https://practice-ledger.test",
      appMcpUrl: "https://practice-ledger.test/api/mcp",
      installationStatus: "INSTALLED",
    },
    surfaceAssignments: [],
    ...overrides,
  };
}

function assignmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "assignment-1",
    workspaceId: "workspace-1",
    surface: "FINANCE",
    appInstallationId: "installation-1",
    enabled: true,
    assignedByUserId: "user-1",
    reasonMd: "Use Practice Ledger for finance.",
    createdAt: now,
    updatedAt: now,
    appInstallation: installationFixture(),
    ...overrides,
  };
}

describe("enterprise app platform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.appDefinition.upsert.mockResolvedValue(definitionFixture());
    prismaMock.appDefinition.update.mockResolvedValue(definitionFixture());
    prismaMock.appDefinition.findUnique.mockResolvedValue(definitionFixture());
    prismaMock.appDefinition.findMany.mockResolvedValue([definitionFixture()]);
    prismaMock.appRuntime.create.mockResolvedValue(runtimeFixture());
    prismaMock.appRuntime.findUnique.mockResolvedValue(runtimeWithRelationsFixture());
    prismaMock.appRuntime.update.mockResolvedValue(runtimeFixture());
    prismaMock.appRelease.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.appInstallation.update.mockResolvedValue(installationFixture());
    prismaMock.appInstallation.findUnique.mockResolvedValue(null);
    prismaMock.appInstallation.findFirst.mockResolvedValue(installationFixture());
    prismaMock.appInstallation.findMany.mockResolvedValue([installationFixture()]);
    prismaMock.appInstallation.upsert.mockResolvedValue({ id: "installation-1" });
    prismaMock.appSurfaceAssignment.findUnique.mockResolvedValue(null);
    prismaMock.appSurfaceAssignment.upsert.mockResolvedValue({});
    prismaMock.appSession.create.mockResolvedValue({ id: "session-1" });
    prismaMock.appSession.update.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes(".well-known")) {
        return Response.json({
          appKey: "practice-ledger",
          version: "0.1.1",
          supportedSurfaces: ["FINANCE"],
          requestedScopes: ["workspace:read", "finance:read"],
          auth: { mode: "corgtex_launch_token" },
          healthUrl: "https://practice-ledger.test/api/health",
          mcpUrl: "https://practice-ledger.test/api/mcp",
          dataClassification: "client private",
          tenantMode: "multi_tenant",
          embed: { supported: true, path: "/dashboard?embedded=1" },
        });
      }
      return Response.json({ status: "ok" });
    }));
    recordAudit.mockResolvedValue(undefined);
  });

  it("validates the required Corgtex app manifest contract", async () => {
    const { validateEnterpriseAppManifest } = await import("./enterprise-apps");
    const manifest = validateEnterpriseAppManifest({
      appKey: "practice-ledger",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["workspace:read", "finance:read"],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://practice-ledger.test/api/health",
      mcpUrl: "https://practice-ledger.test/api/mcp",
      dataClassification: "client private",
      tenantMode: "multi_tenant",
      embed: { supported: true, path: "/dashboard?embedded=1" },
    });

    expect(manifest).toMatchObject({
      appKey: "practice-ledger",
      supportedSurfaces: ["FINANCE"],
      authMode: "corgtex_launch_token",
      dataClassification: "CLIENT_PRIVATE",
    });
  });

  it("rejects manifests missing auth, scopes, surface, or health", async () => {
    const { validateEnterpriseAppManifest } = await import("./enterprise-apps");
    expect(() => validateEnterpriseAppManifest({
      appKey: "practice-ledger",
      version: "0.1.0",
      supportedSurfaces: [],
      requestedScopes: ["finance:read"],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://practice-ledger.test/api/health",
    })).toThrow(/supported surface/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "practice-ledger",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: [],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://practice-ledger.test/api/health",
    })).toThrow(/requestedScopes/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "practice-ledger",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["finance:read"],
      auth: { mode: "password" },
      healthUrl: "https://practice-ledger.test/api/health",
    })).toThrow(/launch-token/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "practice-ledger",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["finance:read"],
      auth: { mode: "corgtex_launch_token" },
    })).toThrow(/healthUrl/i);
  });

  it("keeps installation and surface assignment admin-only", async () => {
    const { installEnterpriseApp } = await import("./enterprise-apps");
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });

    await expect(installEnterpriseApp(actor, {
      workspaceId: "workspace-1",
      appKey: "practice-ledger",
      surface: "FINANCE",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(prismaMock.appInstallation.upsert).not.toHaveBeenCalled();
  });

  it("installs an app and assigns a workspace surface without using feature flag config", async () => {
    const { installEnterpriseApp } = await import("./enterprise-apps");

    await installEnterpriseApp(actor, {
      workspaceId: "workspace-1",
      appKey: "practice-ledger",
      surface: "FINANCE",
      runtimeBaseUrl: "https://practice-ledger.test",
      runtimeMcpUrl: "https://practice-ledger.test/api/mcp",
      tenantExternalId: "practice-org-1",
      reason: "Enterprise finance app.",
    });

    expect(prismaMock.appRuntime.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        baseUrl: "https://practice-ledger.test",
        mcpUrl: "https://practice-ledger.test/api/mcp",
        status: "ACTIVE",
      }),
    }));
    expect(prismaMock.appInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        status: "INSTALLED",
        tenantExternalId: "practice-org-1",
      }),
    }));
    expect(prismaMock.appSurfaceAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_surface: {
          workspaceId: "workspace-1",
          surface: "FINANCE",
        },
      },
    }));
  });

  it("returns native finance when no surface assignment exists", async () => {
    const { getEnterpriseAppSurface } = await import("./enterprise-apps");

    const surface = await getEnterpriseAppSurface(actor, {
      workspaceId: "workspace-1",
      surface: "FINANCE",
    });

    expect(surface).toEqual({
      mode: "native",
      surface: "FINANCE",
      canManage: true,
    });
  });

  it("returns a recovery state for unhealthy assigned apps", async () => {
    const { getEnterpriseAppSurface } = await import("./enterprise-apps");
    prismaMock.appSurfaceAssignment.findUnique.mockResolvedValueOnce(assignmentFixture({
      appInstallation: installationFixture({
        runtime: runtimeFixture({ status: "UNHEALTHY", lastHealthStatus: "degraded" }),
      }),
    }));

    const surface = await getEnterpriseAppSurface(actor, {
      workspaceId: "workspace-1",
      surface: "FINANCE",
    });

    expect(surface).toMatchObject({
      mode: "unavailable",
      nativeAvailable: true,
      reasons: expect.arrayContaining(["Runtime status is UNHEALTHY.", "Runtime health is degraded."]),
    });
  });

  it("runs healthy lifecycle checks and refreshes manifest, runtime, installation, and release health", async () => {
    const { runEnterpriseAppHealthCheckJob } = await import("./enterprise-apps");

    const result = await runEnterpriseAppHealthCheckJob({
      runtimeId: "runtime-1",
      reason: "Scheduled sweep.",
    });

    expect(result).toMatchObject({
      runtimeId: "runtime-1",
      appKey: "practice-ledger",
      status: "ok",
      manifestVersion: "0.1.1",
      installationCount: 1,
    });
    expect(fetch).toHaveBeenCalledWith("https://practice-ledger.test/.well-known/corgtex-app.json", expect.objectContaining({
      method: "GET",
      cache: "no-store",
    }));
    expect(prismaMock.appDefinition.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "definition-1" },
      data: expect.objectContaining({
        dataClassification: "CLIENT_PRIVATE",
        supportedSurfaces: ["FINANCE"],
        requestedScopes: ["workspace:read", "finance:read"],
      }),
    }));
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "runtime-1" },
      data: expect.objectContaining({
        status: "ACTIVE",
        lastHealthStatus: "ok",
        lastHealthError: null,
        metadataJson: expect.objectContaining({
          lastHealthPayload: { status: "ok" },
        }),
      }),
    }));
    expect(prismaMock.appInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "installation-1" },
      data: expect.objectContaining({
        status: "INSTALLED",
        lastHealthStatus: "ok",
      }),
    }));
    expect(prismaMock.appRelease.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        runtimeId: "runtime-1",
        status: { in: ["PREPARED", "ACTIVE"] },
      },
      data: {
        healthStatus: "ok",
      },
    }));
  });

  it("marks runtime and installed apps unhealthy when health reports degraded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      url.includes(".well-known")
        ? Response.json({
            appKey: "practice-ledger",
            version: "0.1.1",
            supportedSurfaces: ["FINANCE"],
            requestedScopes: ["workspace:read", "finance:read"],
            auth: { mode: "corgtex_launch_token" },
            healthUrl: "https://practice-ledger.test/api/health",
            dataClassification: "client private",
            tenantMode: "multi_tenant",
            embed: { supported: true, path: "/dashboard?embedded=1" },
          })
        : Response.json({ status: "degraded" })
    )));
    const { runEnterpriseAppHealthCheckJob } = await import("./enterprise-apps");

    await expect(runEnterpriseAppHealthCheckJob({ runtimeId: "runtime-1" })).resolves.toMatchObject({
      status: "degraded",
      error: "Health reported degraded.",
    });

    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "UNHEALTHY",
        lastHealthStatus: "degraded",
        lastHealthError: "Health reported degraded.",
      }),
    }));
    expect(prismaMock.appInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "UNHEALTHY",
        lastHealthStatus: "degraded",
      }),
    }));
  });

  it("uses the manifest health URL when the runtime has no stored health URL", async () => {
    prismaMock.appRuntime.findUnique.mockResolvedValueOnce(runtimeWithRelationsFixture({
      baseUrl: null,
      healthUrl: null,
    }));
    const { runEnterpriseAppHealthCheckJob } = await import("./enterprise-apps");

    await expect(runEnterpriseAppHealthCheckJob({ runtimeId: "runtime-1" })).resolves.toMatchObject({
      status: "ok",
      manifestVersion: "0.1.1",
    });

    expect(fetch).toHaveBeenCalledWith("https://practice-ledger.test/api/health", expect.objectContaining({
      method: "GET",
    }));
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        healthUrl: "https://practice-ledger.test/api/health",
        lastHealthStatus: "ok",
      }),
    }));
  });

  it("records degraded health when manifest validation fails before probing pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      appKey: "wrong-app",
      version: "0.1.1",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["workspace:read", "finance:read"],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://practice-ledger.test/api/health",
    })));
    const { runEnterpriseAppHealthCheckJob } = await import("./enterprise-apps");

    await expect(runEnterpriseAppHealthCheckJob({ runtimeId: "runtime-1" })).resolves.toMatchObject({
      status: "degraded",
      error: "Manifest app key does not match the app definition.",
    });

    expect(prismaMock.appDefinition.update).not.toHaveBeenCalled();
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "UNHEALTHY",
        lastHealthStatus: "degraded",
      }),
    }));
  });

  it("issues launch sessions with workspace, user, role, scopes, expiry, and audience", async () => {
    const { issueEnterpriseAppSession } = await import("./enterprise-apps");

    const session = await issueEnterpriseAppSession(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
    });

    expect(session).toMatchObject({
      token: "launch-token",
      payload: {
        audience: "practice-ledger",
        workspaceId: "workspace-1",
        appInstallationId: "installation-1",
        user: {
          id: "user-1",
          role: "ADMIN",
        },
        tenantExternalId: "practice-org-1",
        scopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
      },
    });
    expect(session.launchUrl).toContain("https://practice-ledger.test/dashboard");
    expect(session.launchUrl).toContain("corgtex_launch_token=launch-token");
    expect(prismaMock.appSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        audience: "practice-ledger",
        tokenHash: "hash:launch-token",
        scopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
      }),
    }));
  });

  it("validates reusable launch tokens and rejects expired, wrong-audience, and revoked tokens", async () => {
    const { consumeEnterpriseAppSessionToken } = await import("./enterprise-apps");
    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-1",
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      actorUserId: "user-1",
      audience: "practice-ledger",
      tokenHash: "hash:launch-token",
      scopes: ["finance:read"],
      payloadJson: { ok: true },
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      createdAt: now,
      lastUsedAt: null,
      appInstallation: installationFixture(),
    });

    await expect(consumeEnterpriseAppSessionToken({
      token: "launch-token",
      audience: "practice-ledger",
    })).resolves.toMatchObject({
      sessionId: "session-1",
      audience: "practice-ledger",
      workspaceId: "workspace-1",
    });
    expect(prismaMock.appSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session-1" },
      data: expect.objectContaining({
        consumedAt: expect.any(Date),
        lastUsedAt: expect.any(Date),
      }),
    }));

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-1",
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      actorUserId: "user-1",
      audience: "practice-ledger",
      tokenHash: "hash:launch-token",
      scopes: ["finance:read"],
      payloadJson: { ok: true },
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: now,
      revokedAt: null,
      createdAt: now,
      lastUsedAt: now,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({
      token: "launch-token",
      audience: "practice-ledger",
    })).resolves.toMatchObject({
      sessionId: "session-1",
    });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-2",
      audience: "practice-ledger",
      expiresAt: new Date(now.getTime() - 60_000),
      consumedAt: null,
      revokedAt: null,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({ token: "expired" })).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-3",
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      audience: "practice-ledger",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({ token: "wrong", audience: "other-app" })).rejects.toMatchObject({ code: "WRONG_AUDIENCE" });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-4",
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      audience: "practice-ledger",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({
      token: "wrong-workspace",
      workspaceId: "workspace-2",
    })).rejects.toMatchObject({ code: "WRONG_WORKSPACE" });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-5",
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      audience: "practice-ledger",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({
      token: "wrong-installation",
      appInstallationId: "installation-2",
    })).rejects.toMatchObject({ code: "WRONG_INSTALLATION" });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-6",
      audience: "practice-ledger",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: now,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({ token: "revoked" })).rejects.toMatchObject({ code: "TOKEN_REVOKED" });
  });
});
