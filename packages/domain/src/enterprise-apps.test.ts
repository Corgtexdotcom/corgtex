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
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
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
      updateMany: vi.fn(),
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
    appKey: "finance-suite",
    title: "Finance Suite",
    descriptionMd: "Finance app.",
    repositoryUrl: "https://github.com/Corgtexdotcom/finance-suite",
    manifestUrl: "https://finance-suite.test/.well-known/corgtex-app.json",
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
    baseUrl: "https://finance-suite.test",
    healthUrl: "https://finance-suite.test/api/health",
    mcpUrl: "https://finance-suite.test/api/mcp",
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
    imageTag: "finance-suite:0.1.0",
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
      title: "Finance Suite",
      url: "https://finance-suite.test",
      appMcpUrl: "https://finance-suite.test/api/mcp",
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
    reasonMd: "Use Finance Suite for finance.",
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
    prismaMock.appRelease.create.mockResolvedValue(releaseFixture());
    prismaMock.appRelease.findFirst.mockResolvedValue(null);
    prismaMock.appRelease.update.mockResolvedValue(releaseFixture());
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
    prismaMock.appSession.updateMany.mockResolvedValue({ count: 2 });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes(".well-known")) {
        return Response.json({
          appKey: "finance-suite",
          version: "0.1.1",
          supportedSurfaces: ["FINANCE"],
          requestedScopes: ["workspace:read", "finance:read"],
          auth: { mode: "corgtex_launch_token" },
          healthUrl: "https://finance-suite.test/api/health",
          mcpUrl: "https://finance-suite.test/api/mcp",
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
      appKey: "finance-suite",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["workspace:read", "finance:read"],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://finance-suite.test/api/health",
      mcpUrl: "https://finance-suite.test/api/mcp",
      dataClassification: "client private",
      tenantMode: "multi_tenant",
      embed: { supported: true, path: "/dashboard?embedded=1" },
    });

    expect(manifest).toMatchObject({
      appKey: "finance-suite",
      supportedSurfaces: ["FINANCE"],
      authMode: "corgtex_launch_token",
      dataClassification: "CLIENT_PRIVATE",
    });
  });

  it("rejects manifests missing auth, scopes, surface, or health", async () => {
    const { validateEnterpriseAppManifest } = await import("./enterprise-apps");
    expect(() => validateEnterpriseAppManifest({
      appKey: "finance-suite",
      version: "0.1.0",
      supportedSurfaces: [],
      requestedScopes: ["finance:read"],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://finance-suite.test/api/health",
    })).toThrow(/supported surface/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "finance-suite",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: [],
      auth: { mode: "corgtex_launch_token" },
      healthUrl: "https://finance-suite.test/api/health",
    })).toThrow(/requestedScopes/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "finance-suite",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["finance:read"],
      auth: { mode: "password" },
      healthUrl: "https://finance-suite.test/api/health",
    })).toThrow(/launch-token/i);
    expect(() => validateEnterpriseAppManifest({
      appKey: "finance-suite",
      version: "0.1.0",
      supportedSurfaces: ["FINANCE"],
      requestedScopes: ["finance:read"],
      auth: { mode: "corgtex_launch_token" },
    })).toThrow(/healthUrl/i);
  });

  it("does not expose retired Practice Ledger definitions for installation", async () => {
    const { listEnterpriseAppDefinitions } = await import("./enterprise-apps");

    await listEnterpriseAppDefinitions();

    expect(prismaMock.appDefinition.findMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        appKey: { notIn: ["practice-ledger"] },
      },
      orderBy: [{ category: "asc" }, { title: "asc" }],
    });
    expect(prismaMock.appDefinition.upsert).not.toHaveBeenCalled();
  });

  it("rejects retired Practice Ledger app installs before provisioning runtime state", async () => {
    const { installEnterpriseApp } = await import("./enterprise-apps");

    await expect(installEnterpriseApp(actor, {
      workspaceId: "workspace-1",
      appKey: "practice-ledger",
      surface: "FINANCE",
      runtimeBaseUrl: "https://practice-ledger.test",
      reason: "Legacy install attempt.",
    })).rejects.toMatchObject({
      status: 410,
      code: "APP_RETIRED",
    });

    expect(prismaMock.appDefinition.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.appRuntime.create).not.toHaveBeenCalled();
    expect(prismaMock.appInstallation.upsert).not.toHaveBeenCalled();
    expect(prismaMock.appSurfaceAssignment.upsert).not.toHaveBeenCalled();
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
      appKey: "finance-suite",
      surface: "FINANCE",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(prismaMock.appInstallation.upsert).not.toHaveBeenCalled();
  });

  it("keeps app management updates admin-only", async () => {
    const {
      probeEnterpriseAppInstallationHealth,
      revokeEnterpriseAppInstallationSessions,
      updateEnterpriseAppInstallation,
    } = await import("./enterprise-apps");
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });

    await expect(updateEnterpriseAppInstallation(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      status: "DISABLED",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(probeEnterpriseAppInstallationHealth(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(revokeEnterpriseAppInstallationSessions(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(prismaMock.appInstallation.update).not.toHaveBeenCalled();
    expect(prismaMock.appSession.updateMany).not.toHaveBeenCalled();
  });

  it("installs an app and assigns a workspace surface without using feature flag config", async () => {
    const { installEnterpriseApp } = await import("./enterprise-apps");

    await installEnterpriseApp(actor, {
      workspaceId: "workspace-1",
      appKey: "finance-suite",
      surface: "FINANCE",
      runtimeBaseUrl: "https://finance-suite.test",
      runtimeMcpUrl: "https://finance-suite.test/api/mcp",
      tenantExternalId: "practice-org-1",
      reason: "Enterprise finance app.",
    });

    expect(prismaMock.appRuntime.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        baseUrl: "https://finance-suite.test",
        mcpUrl: "https://finance-suite.test/api/mcp",
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

  it("updates app installation runtime, tenant mapping, status, and audit state", async () => {
    const { updateEnterpriseAppInstallation } = await import("./enterprise-apps");

    await updateEnterpriseAppInstallation(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      status: "DISABLED",
      runtimeStatus: "DISABLED",
      runtimeBaseUrl: "https://finance-suite-new.test",
      runtimeMcpUrl: "https://finance-suite-new.test/api/mcp",
      tenantExternalId: "practice-org-2",
      tenantMappingJson: { organizationId: "practice-org-2" },
      launchPath: "/embedded",
      grantedScopes: ["workspace:read", "finance:read"],
      reason: "Customer asked to pause finance app.",
    });

    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith({
      where: { id: "runtime-1" },
      data: expect.objectContaining({
        status: "DISABLED",
        baseUrl: "https://finance-suite-new.test",
        healthUrl: "https://finance-suite-new.test/api/health",
        mcpUrl: "https://finance-suite-new.test/api/mcp",
      }),
    });
    expect(prismaMock.appInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "installation-1" },
      data: expect.objectContaining({
        status: "DISABLED",
        tenantExternalId: "practice-org-2",
        tenantMappingJson: { organizationId: "practice-org-2" },
        launchPath: "/embedded",
        grantedScopes: ["workspace:read", "finance:read"],
      }),
    }));
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.updated",
      entityId: "installation-1",
      meta: expect.objectContaining({
        appKey: "finance-suite",
        status: "DISABLED",
        runtimeChanged: true,
        reason: "Customer asked to pause finance app.",
      }),
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

  it("returns native finance for stale Practice Ledger surface assignments", async () => {
    const { getEnterpriseAppSurface } = await import("./enterprise-apps");
    prismaMock.appSurfaceAssignment.findUnique.mockResolvedValueOnce(assignmentFixture({
      appInstallation: installationFixture({
        appDefinition: definitionFixture({
          appKey: "practice-ledger",
          title: "Practice Ledger",
        }),
      }),
    }));

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

  it("returns a native recovery state for disabled assigned apps", async () => {
    const { getEnterpriseAppSurface } = await import("./enterprise-apps");
    prismaMock.appSurfaceAssignment.findUnique.mockResolvedValueOnce(assignmentFixture({
      appInstallation: installationFixture({
        status: "DISABLED",
        runtime: runtimeFixture({ status: "DISABLED" }),
      }),
    }));

    const surface = await getEnterpriseAppSurface(actor, {
      workspaceId: "workspace-1",
      surface: "FINANCE",
    });

    expect(surface).toMatchObject({
      mode: "unavailable",
      nativeAvailable: true,
      reasons: expect.arrayContaining(["Installation status is DISABLED.", "Runtime status is DISABLED."]),
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
      appKey: "finance-suite",
      status: "ok",
      manifestVersion: "0.1.1",
      installationCount: 1,
    });
    expect(fetch).toHaveBeenCalledWith("https://finance-suite.test/.well-known/corgtex-app.json", expect.objectContaining({
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
            appKey: "finance-suite",
            version: "0.1.1",
            supportedSurfaces: ["FINANCE"],
            requestedScopes: ["workspace:read", "finance:read"],
            auth: { mode: "corgtex_launch_token" },
            healthUrl: "https://finance-suite.test/api/health",
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

    expect(fetch).toHaveBeenCalledWith("https://finance-suite.test/api/health", expect.objectContaining({
      method: "GET",
    }));
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        healthUrl: "https://finance-suite.test/api/health",
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
      healthUrl: "https://finance-suite.test/api/health",
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

  it("runs manual health probes and writes an audit entry", async () => {
    const { probeEnterpriseAppInstallationHealth } = await import("./enterprise-apps");

    const result = await probeEnterpriseAppInstallationHealth(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      reason: "Admin requested immediate status.",
    });

    expect(result.result).toMatchObject({
      runtimeId: "runtime-1",
      status: "ok",
    });
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.health_probed",
      entityId: "installation-1",
      meta: expect.objectContaining({
        appKey: "finance-suite",
        status: "ok",
        reason: "Admin requested immediate status.",
      }),
    }));
  });

  it("revokes active sessions for an app installation and audits the count", async () => {
    const { revokeEnterpriseAppInstallationSessions } = await import("./enterprise-apps");

    await expect(revokeEnterpriseAppInstallationSessions(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      reason: "Runtime credentials rotated.",
    })).resolves.toEqual({
      appInstallationId: "installation-1",
      revoked: 2,
    });

    expect(prismaMock.appSession.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        appInstallationId: "installation-1",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.sessions_revoked",
      entityId: "installation-1",
      meta: expect.objectContaining({
        appKey: "finance-suite",
        count: 2,
        reason: "Runtime credentials rotated.",
      }),
    }));
  });

  it("keeps runtime provisioning, preflight, and release mutations admin-only", async () => {
    const {
      createEnterpriseAppRelease,
      preflightEnterpriseAppRuntime,
      promoteEnterpriseAppRelease,
      provisionEnterpriseAppRuntime,
      rollbackEnterpriseAppRelease,
      upgradeEnterpriseAppRuntimeRelease,
    } = await import("./enterprise-apps");
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    const railwayClient = { graphql: vi.fn() } as any;

    await expect(provisionEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      runtimeMode: "SELF_MANAGED_EXTERNAL",
      runtimeBaseUrl: "https://finance-suite.test",
    }, railwayClient)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(preflightEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(createEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      version: "0.2.0",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(promoteEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(rollbackEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(upgradeEnterpriseAppRuntimeRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-1",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
    }, railwayClient)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(railwayClient.graphql).not.toHaveBeenCalled();
  });

  it("provisions a managed Railway app runtime without storing raw secrets", async () => {
    const { provisionEnterpriseAppRuntime } = await import("./enterprise-apps");
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({ projectCreate: { id: "project-1" } })
        .mockResolvedValueOnce({ environments: { edges: [{ node: { id: "env-1", name: "production" } }] } })
        .mockResolvedValueOnce({
          app: { id: "app-1" },
          postgres: { id: "postgres-1" },
          redis: { id: "redis-1" },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ customDomainCreate: { domain: "ledger.acme.test" } }),
    } as any;

    await provisionEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      runtimeMode: "ISOLATED_SINGLE_TENANT",
      runtimeBaseUrl: "https://ledger.acme.test",
      runtimeMcpUrl: "https://ledger.acme.test/api/mcp",
      region: "us-west2",
      customDomain: "ledger.acme.test",
      secretsRef: "railway://project-1/app/env/finance-suite",
      releaseVersion: "0.2.0",
      releaseImageTag: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
      variables: {
        FINANCE_SUITE_API_KEY: "raw-secret-value",
      },
    }, railwayClient);

    expect(railwayClient.graphql).toHaveBeenCalledTimes(9);
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "runtime-1" },
      data: expect.objectContaining({
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayServiceId: "app-1",
        secretsRef: "railway://project-1/app/env/finance-suite",
        metadataJson: expect.objectContaining({
          railwayPostgresServiceId: "postgres-1",
          railwayRedisServiceId: "redis-1",
        }),
      }),
    }));
    const dbWrites = JSON.stringify(prismaMock.appRuntime.update.mock.calls);
    expect(dbWrites).not.toContain("raw-secret-value");
  });

  it("registers self-managed external runtimes without Railway calls", async () => {
    const { provisionEnterpriseAppRuntime } = await import("./enterprise-apps");
    const railwayClient = { graphql: vi.fn() } as any;

    await provisionEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      runtimeMode: "SELF_MANAGED_EXTERNAL",
      runtimeBaseUrl: "https://customer-ledger.example",
      runtimeMcpUrl: "https://customer-ledger.example/api/mcp",
      secretsRef: "customer-vault://finance-suite",
    }, railwayClient);

    expect(railwayClient.graphql).not.toHaveBeenCalled();
    expect(prismaMock.appRuntime.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mode: "SELF_MANAGED_EXTERNAL",
        status: "PROVISIONING",
        baseUrl: "https://customer-ledger.example",
        secretsRef: "customer-vault://finance-suite",
      }),
    }));
  });

  it("rejects retries for partial Railway app runtime stacks", async () => {
    const { provisionEnterpriseAppRuntime } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      runtime: runtimeFixture({
        railwayProjectId: "project-1",
        railwayEnvironmentId: null,
        railwayServiceId: null,
        metadataJson: null,
      }),
    }));
    const railwayClient = { graphql: vi.fn() } as any;

    await expect(provisionEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      runtimeMode: "SHARED_MULTI_TENANT",
      runtimeBaseUrl: "https://finance-suite.test",
      region: "us-west2",
      secretsRef: "railway://project-1/app/env/finance-suite",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
    }, railwayClient)).rejects.toMatchObject({
      status: 409,
      code: "RAILWAY_APP_RUNTIME_RECONCILIATION_REQUIRED",
    });
    expect(railwayClient.graphql).not.toHaveBeenCalled();
  });

  it("preflights manifest compatibility before activating runtime", async () => {
    const { preflightEnterpriseAppRuntime } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      appDefinition: definitionFixture({
        manifestUrl: null,
        requestedScopes: ["workspace:read", "finance:read"],
        manifestJson: {
          appKey: "finance-suite",
          version: "0.2.0",
          supportedSurfaces: ["FINANCE"],
          requestedScopes: ["workspace:read"],
          auth: { mode: "corgtex_launch_token" },
          healthUrl: "https://finance-suite.test/api/health",
        },
      }),
    }));

    await expect(preflightEnterpriseAppRuntime(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
    })).rejects.toMatchObject({
      code: "APP_MANIFEST_INCOMPATIBLE",
    });
    expect(fetch).not.toHaveBeenCalledWith("https://finance-suite.test/api/health", expect.anything());
  });

  it("creates releases scoped to the target runtime and validates manifest compatibility", async () => {
    const { createEnterpriseAppRelease } = await import("./enterprise-apps");

    await createEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      version: "0.2.0",
      gitSha: "abc123",
      imageTag: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
      manifestJson: {
        appKey: "finance-suite",
        version: "0.2.0",
        supportedSurfaces: ["FINANCE"],
        requestedScopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
        auth: { mode: "corgtex_launch_token" },
        healthUrl: "https://finance-suite.test/api/health",
      },
    });

    expect(prismaMock.appRelease.findFirst).toHaveBeenCalledWith({
      where: {
        appDefinitionId: "definition-1",
        runtimeId: "runtime-1",
        version: "0.2.0",
      },
    });
    expect(prismaMock.appRelease.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        appDefinitionId: "definition-1",
        runtimeId: "runtime-1",
        version: "0.2.0",
        manifestVersion: "0.2.0",
        status: "PREPARED",
      }),
    }));
  });

  it("preserves active release status when refreshing existing release metadata", async () => {
    const { createEnterpriseAppRelease } = await import("./enterprise-apps");
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-active",
      version: "0.1.0",
      status: "ACTIVE",
    }));

    await createEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      version: "0.1.0",
      gitSha: "def456",
      imageTag: "ghcr.io/corgtexdotcom/finance-suite:0.1.0",
    });

    expect(prismaMock.appRelease.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "release-active" },
      data: expect.objectContaining({
        status: "ACTIVE",
      }),
    }));
  });

  it("promotes a prepared release and rolls back the prior active release metadata", async () => {
    const { promoteEnterpriseAppRelease } = await import("./enterprise-apps");
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-2",
      version: "0.2.0",
      status: "PREPARED",
    }));

    await promoteEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-2",
      reason: "Promote after preflight.",
    });

    expect(prismaMock.appRelease.updateMany).toHaveBeenCalledWith({
      where: {
        appDefinitionId: "definition-1",
        runtimeId: "runtime-1",
        status: "ACTIVE",
        id: { not: "release-2" },
      },
      data: expect.objectContaining({
        status: "ROLLED_BACK",
        metadataJson: expect.objectContaining({
          rolledBackByReleaseId: "release-2",
        }),
      }),
    });
    expect(prismaMock.appRelease.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "release-2" },
      data: expect.objectContaining({
        status: "ACTIVE",
        releasedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.appInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "installation-1" },
      data: expect.objectContaining({
        releaseId: "release-2",
        status: "INSTALLED",
      }),
    }));
  });

  it("rejects rollback activation of failed releases", async () => {
    const { rollbackEnterpriseAppRelease } = await import("./enterprise-apps");
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-failed",
      version: "0.2.0",
      status: "FAILED",
    }));

    await expect(rollbackEnterpriseAppRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-failed",
    })).rejects.toMatchObject({
      status: 400,
      code: "APP_RELEASE_FAILED",
    });
    expect(prismaMock.appRelease.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.appRelease.update).not.toHaveBeenCalled();
    expect(prismaMock.appInstallation.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ releaseId: "release-failed" }),
    }));
  });

  it("starts managed release upgrades and leaves promotion to a later preflight", async () => {
    const { upgradeEnterpriseAppRuntimeRelease } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      runtime: runtimeFixture({
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayServiceId: "app-1",
        metadataJson: {
          railwayPostgresServiceId: "postgres-1",
          railwayRedisServiceId: "redis-1",
        },
      }),
    }));
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-2",
      version: "0.2.0",
      imageTag: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
      status: "PREPARED",
    }));
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ app: "deploy-app-1" }),
    } as any;

    await upgradeEnterpriseAppRuntimeRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-2",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
    }, railwayClient);

    expect(railwayClient.graphql).toHaveBeenCalledTimes(3);
    expect(prismaMock.appRelease.update).toHaveBeenCalledWith({
      where: { id: "release-2" },
      data: expect.objectContaining({
        status: "PREPARED",
        metadataJson: expect.objectContaining({
          lastUpgradeDeploymentId: "deploy-app-1",
        }),
      }),
    });
    expect(prismaMock.appInstallation.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ releaseId: "release-2" }),
    }));
  });

  it("marks failed app release upgrades without changing the active installation release", async () => {
    const { upgradeEnterpriseAppRuntimeRelease } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      releaseId: "release-active",
      runtime: runtimeFixture({
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayServiceId: "app-1",
        metadataJson: {
          railwayPostgresServiceId: "postgres-1",
          railwayRedisServiceId: "redis-1",
        },
      }),
    }));
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-2",
      version: "0.2.0",
      status: "PREPARED",
    }));
    const railwayClient = {
      graphql: vi.fn(async () => {
        throw new Error("Railway unavailable");
      }),
    } as any;

    await expect(upgradeEnterpriseAppRuntimeRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-2",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.2.0",
    }, railwayClient)).rejects.toThrow("Railway unavailable");

    expect(prismaMock.appRelease.update).toHaveBeenCalledWith({
      where: { id: "release-2" },
      data: expect.objectContaining({
        status: "FAILED",
        metadataJson: expect.objectContaining({
          lastUpgradeError: "Railway unavailable",
        }),
      }),
    });
    expect(prismaMock.appInstallation.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ releaseId: "release-2" }),
    }));
  });

  it("preserves active release status when an in-place app upgrade fails", async () => {
    const { upgradeEnterpriseAppRuntimeRelease } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      releaseId: "release-active",
      runtime: runtimeFixture({
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayServiceId: "app-1",
        metadataJson: {
          railwayPostgresServiceId: "postgres-1",
          railwayRedisServiceId: "redis-1",
        },
      }),
    }));
    prismaMock.appRelease.findFirst.mockResolvedValueOnce(releaseFixture({
      id: "release-active",
      version: "0.1.0",
      status: "ACTIVE",
    }));
    const railwayClient = {
      graphql: vi.fn(async () => {
        throw new Error("Railway unavailable");
      }),
    } as any;

    await expect(upgradeEnterpriseAppRuntimeRelease(actor, {
      workspaceId: "workspace-1",
      appInstallationId: "installation-1",
      releaseId: "release-active",
      appImage: "ghcr.io/corgtexdotcom/finance-suite:0.1.0",
    }, railwayClient)).rejects.toThrow("Railway unavailable");

    expect(prismaMock.appRelease.update).toHaveBeenCalledWith({
      where: { id: "release-active" },
      data: expect.objectContaining({
        status: "ACTIVE",
        metadataJson: expect.objectContaining({
          lastUpgradeError: "Railway unavailable",
        }),
      }),
    });
    expect(prismaMock.appInstallation.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ releaseId: "release-active" }),
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
        audience: "finance-suite",
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
    expect(session.launchUrl).toContain("https://finance-suite.test/dashboard");
    expect(session.launchUrl).toContain("corgtex_launch_token=launch-token");
    expect(prismaMock.appSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        audience: "finance-suite",
        tokenHash: "hash:launch-token",
        scopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
      }),
    }));
  });

  it("invokes installed app MCP with a scoped app session and audit", async () => {
    const { invokeInstalledAppTool } = await import("./enterprise-apps");
    prismaMock.appSurfaceAssignment.findUnique.mockResolvedValueOnce(assignmentFixture());
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      result: { created: 1 },
      persisted: { submitted: true },
    }) as never);

    await expect(invokeInstalledAppTool(actor, {
      workspaceId: "workspace-1",
      surface: "FINANCE",
      toolName: "create_expenses",
      arguments: { expenses: [{ amountCents: 5000 }] },
    })).resolves.toMatchObject({
      appKey: "finance-suite",
      appInstallationId: "installation-1",
      toolName: "create_expenses",
      scopes: ["finance:write"],
      result: {
        persisted: { submitted: true },
      },
    });

    expect(prismaMock.appSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        audience: "finance-suite",
        tokenHash: "hash:launch-token",
        scopes: ["workspace:read", "brain:read", "finance:read", "finance:write"],
      }),
    }));
    expect(fetch).toHaveBeenCalledWith("https://finance-suite.test/api/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer launch-token",
      }),
      body: JSON.stringify({
        toolName: "create_expenses",
        arguments: { expenses: [{ amountCents: 5000 }] },
      }),
    }));
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      workspaceId: "workspace-1",
      action: "enterprise_app.mcp_invoked",
      entityType: "AppInstallation",
      entityId: "installation-1",
      meta: expect.objectContaining({
        appKey: "finance-suite",
        toolName: "create_expenses",
        scopes: ["finance:write"],
        success: true,
      }),
    }));
  });

  it("rejects installed app MCP calls when the app is missing required granted scopes", async () => {
    const { invokeInstalledAppTool } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      grantedScopes: ["workspace:read", "finance:read"],
    }));

    await expect(invokeInstalledAppTool(actor, {
      workspaceId: "workspace-1",
      appKey: "finance-suite",
      toolName: "create_expenses",
    })).rejects.toMatchObject({
      code: "APP_SCOPE_MISSING",
    });

    expect(prismaMock.appSession.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith("https://finance-suite.test/api/mcp", expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.mcp_invoked",
      meta: expect.objectContaining({
        success: false,
        failureReason: expect.stringContaining("finance:write"),
      }),
    }));
  });

  it("rejects installed app MCP calls when the runtime is unhealthy", async () => {
    const { invokeInstalledAppTool } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture({
      runtime: runtimeFixture({ status: "UNHEALTHY", lastHealthStatus: "down" }),
    }));

    await expect(invokeInstalledAppTool(actor, {
      workspaceId: "workspace-1",
      appKey: "finance-suite",
      toolName: "submit_finance_entries",
    })).rejects.toMatchObject({
      code: "APP_RUNTIME_UNAVAILABLE",
    });
    expect(prismaMock.appSession.create).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.mcp_invoked",
      meta: expect.objectContaining({
        success: false,
        failureReason: expect.stringContaining("Runtime status is UNHEALTHY"),
      }),
    }));
  });

  it("rejects installed app MCP calls without inferred or explicit scopes", async () => {
    const { invokeInstalledAppTool } = await import("./enterprise-apps");
    prismaMock.appInstallation.findFirst.mockResolvedValueOnce(installationFixture());

    await expect(invokeInstalledAppTool(actor, {
      workspaceId: "workspace-1",
      appKey: "finance-suite",
      toolName: "unknown_app_tool",
    })).rejects.toMatchObject({
      code: "APP_MCP_SCOPE_REQUIRED",
    });

    expect(prismaMock.appSession.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith("https://finance-suite.test/api/mcp", expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(prismaMock, actor, expect.objectContaining({
      action: "enterprise_app.mcp_invoked",
      meta: expect.objectContaining({
        success: false,
        failureReason: expect.stringContaining("required scope"),
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
      audience: "finance-suite",
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
      audience: "finance-suite",
    })).resolves.toMatchObject({
      sessionId: "session-1",
      audience: "finance-suite",
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
      audience: "finance-suite",
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
      audience: "finance-suite",
    })).resolves.toMatchObject({
      sessionId: "session-1",
    });

    prismaMock.appSession.findUnique.mockResolvedValueOnce({
      id: "session-2",
      audience: "finance-suite",
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
      audience: "finance-suite",
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
      audience: "finance-suite",
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
      audience: "finance-suite",
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
      audience: "finance-suite",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      revokedAt: now,
      appInstallation: installationFixture(),
    });
    await expect(consumeEnterpriseAppSessionToken({ token: "revoked" })).rejects.toMatchObject({ code: "TOKEN_REVOKED" });
  });
});
