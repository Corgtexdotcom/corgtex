import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, encryptSecretMock, decryptSecretMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(async (operations: unknown[] | ((tx: unknown) => unknown)) => (
      typeof operations === "function" ? operations(prismaMock) : Promise.all(operations)
    )),
    controlPlaneInstanceAccess: {
      findUnique: vi.fn(),
    },
    hostedInstanceEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    instanceRegistry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspaceFeatureFlag: {
      upsert: vi.fn(),
    },
    workspaceMeetingRecorderConfig: {
      upsert: vi.fn(),
    },
    brainSource: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    externalDataSource: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    knowledgeChunk: {
      count: vi.fn(),
    },
    workflowJob: {
      count: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    agentRun: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    agentToolCall: {
      findMany: vi.fn(),
    },
    modelUsage: {
      aggregate: vi.fn(),
    },
    supportOperation: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  encryptSecretMock: vi.fn((value: string) => `encrypted:${value}`),
  decryptSecretMock: vi.fn(() => "support-token"),
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    CONTROL_PLANE_AGENT_API_KEY: "agent-secret",
  },
  prisma: prismaMock,
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
}));

const operatorActor: AppActor = {
  kind: "user",
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

const userActor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

describe("control plane domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (operations: unknown[] | ((tx: unknown) => unknown)) => (
      typeof operations === "function" ? operations(prismaMock) : Promise.all(operations)
    ));
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        },
      }),
    })) as any;
  });

  it("allows global operators and rejects normal users without instance access", async () => {
    const { requireControlPlaneAccess } = await import("./control-plane");

    await expect(requireControlPlaneAccess(operatorActor)).resolves.toEqual({ role: "OPERATOR" });
    prismaMock.controlPlaneInstanceAccess.findUnique.mockResolvedValueOnce(null);
    await expect(requireControlPlaneAccess(userActor, { instanceId: "inst-1" })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("allows future instance-scoped access primitives", async () => {
    const { requireControlPlaneAccess } = await import("./control-plane");
    prismaMock.controlPlaneInstanceAccess.findUnique.mockResolvedValueOnce({
      role: "SUPPORT_VIEWER",
      isActive: true,
    });

    await expect(requireControlPlaneAccess(userActor, { instanceId: "inst-1" })).resolves.toEqual({ role: "SUPPORT_VIEWER" });
  });

  it("encrypts support credentials and does not return ciphertext", async () => {
    const { configureSupportConnector } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      supportCredentialEnc: null,
    });
    prismaMock.instanceRegistry.update.mockResolvedValueOnce({
      id: "inst-1",
      supportCredentialEnc: "encrypted:support-token",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportBaseUrl: "https://customer.test",
      supportCredentialLabel: "Corgtex Support",
    });

    const result = await configureSupportConnector(operatorActor, {
      instanceId: "inst-1",
      supportBaseUrl: "https://customer.test",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredential: "support-token",
      supportCredentialLabel: "Corgtex Support",
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("support-token");
    expect(prismaMock.instanceRegistry.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        supportCredentialEnc: "encrypted:support-token",
        supportConnectorStatus: "configured",
      }),
    }));
    expect(result.supportCredentialEnc).toBeUndefined();
  });

  it("lists customers with managed workspace summaries and redacted credentials", async () => {
    const { listControlPlaneCustomers } = await import("./control-plane");
    prismaMock.instanceRegistry.findMany.mockResolvedValueOnce([
      {
        id: "inst-1",
        label: "Acme",
        url: "https://acme.test",
        supportCredentialEnc: "encrypted-token",
        supportOperations: [],
        managedWorkspace: {
          id: "ws-1",
          slug: "acme",
          name: "Acme",
          _count: {
            externalDataSources: 2,
            brainArticles: 12,
            agentRuns: 5,
            workflowJobs: 7,
            communicationInstallations: 1,
            meetingRecordings: 3,
          },
        },
        _count: { supportOperations: 0, events: 0 },
      },
    ] as any);

    const result = await listControlPlaneCustomers(operatorActor);

    expect(prismaMock.instanceRegistry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        managedWorkspace: expect.any(Object),
      }),
    }));
    expect(result[0]).toMatchObject({
      id: "inst-1",
      hasSupportCredential: true,
      managedWorkspace: {
        slug: "acme",
        _count: { brainArticles: 12 },
      },
    });
    expect(result[0].supportCredentialEnc).toBeUndefined();
  });

  it("configures meeting recorder entitlements for managed workspaces and audits the reason", async () => {
    const { configureControlPlaneMeetingRecorderIntegration } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        _count: {},
      },
    });
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValueOnce({
      workspaceId: "ws-1",
      flag: "MEETING_RECORDERS",
      enabled: true,
    });
    prismaMock.workspaceMeetingRecorderConfig.upsert.mockResolvedValueOnce({
      workspaceId: "ws-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      autoRecordEnabled: true,
      monthlyMinuteCap: 1200,
    });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const result = await configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      instanceId: "inst-1",
      entitlementEnabled: true,
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      autoRecordEnabled: true,
      monthlyMinuteCap: 1200,
      reason: "Customer signed recorder addendum.",
    });

    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_flag: {
          workspaceId: "ws-1",
          flag: "MEETING_RECORDERS",
        },
      },
      update: { enabled: true },
    }));
    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      update: expect.objectContaining({
        enabled: true,
        defaultProvider: "RECALL_AI",
        monthlyMinuteCap: 1200,
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "meeting-recorders:reconcile:ws-1:control-plane" },
    }));
    expect(prismaMock.hostedInstanceEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        instanceId: "inst-1",
        action: "control_plane.integration.meeting_recorders_configured",
        meta: expect.objectContaining({
          reason: "Customer signed recorder addendum.",
          monthlyMinuteCap: 1200,
        }),
      }),
    }));
    expect(result).toMatchObject({
      instanceId: "inst-1",
      entitlementEnabled: true,
    });
  });

  it("requires a reason and managed workspace before configuring meeting recorders", async () => {
    const { configureControlPlaneMeetingRecorderIntegration } = await import("./control-plane");
    await expect(configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      instanceId: "inst-1",
      entitlementEnabled: true,
      enabled: true,
      defaultProvider: "RECALL_AI",
      autoRecordEnabled: true,
      monthlyMinuteCap: 1200,
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });

    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: null,
      supportCredentialEnc: null,
      managedWorkspace: null,
    });
    await expect(configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      instanceId: "inst-1",
      entitlementEnabled: true,
      enabled: true,
      defaultProvider: "RECALL_AI",
      autoRecordEnabled: true,
      monthlyMinuteCap: 1200,
      reason: "Customer signed recorder addendum.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MANAGED_WORKSPACE_REQUIRED",
    });
  });

  it("queues sync for all active managed workspace context sources and audits the reason", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        _count: {},
      },
    });
    prismaMock.externalDataSource.findMany.mockResolvedValueOnce([
      { id: "source-1", label: "Warehouse" },
      { id: "source-2", label: "CRM" },
    ]);
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });

    const result = await runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "sync_all",
      reason: "Customer requested a full context refresh.",
    });

    expect(prismaMock.externalDataSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "ws-1",
        archivedAt: null,
        isActive: true,
      },
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "data-source.sync",
        payload: expect.objectContaining({
          sourceId: "source-1",
          requestedBy: "control_plane",
        }),
      }),
    }));
    expect(prismaMock.hostedInstanceEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        instanceId: "inst-1",
        action: "control_plane.context.sync_requested",
        meta: expect.objectContaining({
          reason: "Customer requested a full context refresh.",
          queuedJobs: 2,
          sourceIds: ["source-1", "source-2"],
        }),
      }),
    }));
    expect(result).toMatchObject({
      operation: "sync_all",
      queuedJobs: 2,
      sourceIds: ["source-1", "source-2"],
    });
  });

  it("queues sync for one managed workspace context source", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        _count: {},
      },
    });
    prismaMock.externalDataSource.findFirst.mockResolvedValueOnce({
      id: "source-1",
      label: "Warehouse",
      isActive: true,
    });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const result = await runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "sync_source",
      sourceId: "source-1",
      reason: "Repair failed warehouse ingestion.",
    });

    expect(prismaMock.externalDataSource.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "source-1",
        workspaceId: "ws-1",
        archivedAt: null,
      },
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "data-source.sync",
        payload: expect.objectContaining({ sourceId: "source-1" }),
      }),
    }));
    expect(prismaMock.hostedInstanceEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.context.sync_requested",
        meta: expect.objectContaining({
          reason: "Repair failed warehouse ingestion.",
          sourceId: "source-1",
          sourceLabel: "Warehouse",
          workflowJobId: "job-1",
        }),
      }),
    }));
    expect(result).toMatchObject({
      operation: "sync_source",
      queuedJobs: 1,
      sourceIds: ["source-1"],
    });
  });

  it("disables a managed workspace context source and audits the operation", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        _count: {},
      },
    });
    prismaMock.externalDataSource.findFirst.mockResolvedValueOnce({
      id: "source-1",
      label: "Warehouse",
      isActive: true,
    });
    prismaMock.externalDataSource.update.mockResolvedValueOnce({
      id: "source-1",
      label: "Warehouse",
      isActive: false,
    });

    const result = await runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "disable_source",
      sourceId: "source-1",
      reason: "Source is creating invalid context.",
    });

    expect(prismaMock.externalDataSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-1" },
      data: { isActive: false },
    }));
    expect(prismaMock.hostedInstanceEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.context.source_disabled",
        meta: expect.objectContaining({
          reason: "Source is creating invalid context.",
          sourceId: "source-1",
          isActive: false,
        }),
      }),
    }));
    expect(result).toMatchObject({
      operation: "disable_source",
      disabled: true,
      sourceIds: ["source-1"],
    });
  });

  it("requires reason and managed workspace before running context operations", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    await expect(runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "sync_all",
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });

    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: null,
      supportCredentialEnc: null,
      managedWorkspace: null,
    });
    await expect(runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "sync_all",
      reason: "Customer asked for context repair.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MANAGED_WORKSPACE_REQUIRED",
    });
  });

  it("rejects context operations for sources outside the managed workspace", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        _count: {},
      },
    });
    prismaMock.externalDataSource.findFirst.mockResolvedValueOnce(null);

    await expect(runControlPlaneContextOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "sync_source",
      sourceId: "source-2",
      reason: "Repair source.",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("prepares a release upgrade and records readiness evidence without deployment", async () => {
    const { runControlPlaneReleaseOperation } = await import("./control-plane");
    prismaMock.instanceRegistry.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      customerSlug: "acme",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      releaseImageTag: "ghcr.io/corgtex/app:old",
      releaseVersion: "0.1.0",
      lastReleaseCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthError: null,
      lastWorkerHealthStatus: "ok",
      lastWorkerHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      provisioningStatus: "active",
      bootstrapStatus: "completed",
      lastProvisioningError: null,
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    prismaMock.hostedInstanceEvent.findMany.mockResolvedValueOnce([
      {
        id: "event-1",
        actorUserId: "operator-1",
        action: "control_plane.release.upgrade_prepared",
        meta: {},
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const result = await runControlPlaneReleaseOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      targetReleaseVersion: "0.2.0",
      reason: "Prepare staged release after smoke checks.",
    });

    expect(prismaMock.hostedInstanceEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        instanceId: "inst-1",
        action: "control_plane.release.upgrade_prepared",
        meta: expect.objectContaining({
          reason: "Prepare staged release after smoke checks.",
          currentReleaseImageTag: "ghcr.io/corgtex/app:old",
          targetReleaseImageTag: "ghcr.io/corgtex/app:new",
          targetReleaseVersion: "0.2.0",
          checks: expect.objectContaining({
            hasRailwayServices: true,
            rollbackReady: true,
            targetDiffers: true,
          }),
        }),
      }),
    }));
    expect(prismaMock.instanceRegistry.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      operation: "prepare_upgrade",
      target: {
        releaseImageTag: "ghcr.io/corgtex/app:new",
        releaseVersion: "0.2.0",
      },
      checks: {
        rollbackReady: true,
        targetDiffers: true,
      },
      release: {
        rollbackReady: true,
      },
    });
  });

  it("requires reason, target image tag, and supported operation for release operations", async () => {
    const { runControlPlaneReleaseOperation } = await import("./control-plane");
    await expect(runControlPlaneReleaseOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });

    prismaMock.instanceRegistry.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      releaseImageTag: "ghcr.io/corgtex/app:old",
      releaseVersion: "0.1.0",
      lastHealthStatus: "ok",
    });
    await expect(runControlPlaneReleaseOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "",
      reason: "Prepare release.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(runControlPlaneReleaseOperation(operatorActor, {
      instanceId: "inst-1",
      operation: "upgrade_now",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      reason: "Prepare release.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("records and completes an audited remote support operation", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-1",
      action: "members.invite",
    });
    prismaMock.instanceRegistry.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      url: "https://customer.test",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
    });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-1",
      status: "COMPLETED",
    });

    const result = await runCustomerSupportOperation(operatorActor, {
      instanceId: "inst-1",
      action: "members.invite",
      reason: "Pilot onboarding request",
      arguments: {
        email: "new@example.com",
        role: "CONTRIBUTOR",
        supportCredential: "should-redact",
      },
    });

    expect(decryptSecretMock).toHaveBeenCalledWith("encrypted-token");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "RUNNING",
        inputSummary: expect.objectContaining({
          supportCredential: "[redacted]",
        }),
      }),
    }));
    expect(prismaMock.supportOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "op-1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    }));
    expect(result).toMatchObject({ id: "op-1", status: "COMPLETED" });
  });
});
