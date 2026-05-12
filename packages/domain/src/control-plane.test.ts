import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, encryptSecretMock, decryptSecretMock, memberMocks } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(async (operations: unknown[] | ((tx: unknown) => unknown)) => (
      typeof operations === "function" ? operations(prismaMock) : Promise.all(operations)
    )),
    customerDeploymentAccess: {
      findUnique: vi.fn(),
    },
    customerDeploymentEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    customerAccount: {
      findMany: vi.fn(),
    },
    customerEntitlement: {
      upsert: vi.fn(),
    },
    customerReleaseTarget: {
      upsert: vi.fn(),
    },
    fleetHealthSnapshot: {
      create: vi.fn(),
    },
    customerDeployment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspaceFeatureFlag: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceMeetingRecorderConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workspaceRecorderCalendarSource: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    meetingRecorderSmokeRun: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    meetingRecording: {
      aggregate: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    meeting: {
      create: vi.fn(),
      findFirst: vi.fn(),
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
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
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
  memberMocks: {
    listMembersEnriched: vi.fn(),
    createMember: vi.fn(),
    resendMemberAccessLink: vi.fn(),
    sendMemberSetupEmail: vi.fn(),
    updateMember: vi.fn(),
    deactivateMember: vi.fn(),
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    CONTROL_PLANE_AGENT_API_KEY: "agent-secret",
    CONTROL_PLANE_AGENT_SCOPES: undefined,
    SESSION_COOKIE_SECRET: "test-session-secret",
    MEETING_RECORDER_PUBLIC_BASE_URL: "https://customer-recorder.example",
    RECALL_API_KEY: "recall-key",
    RECALL_WEBHOOK_SECRET: "recall-secret",
    RECALL_REGION: "us-east-1",
  },
  prisma: prismaMock,
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
  randomOpaqueToken: vi.fn(() => "nonce-value"),
}));

vi.mock("./members", () => ({
  listMembersEnriched: memberMocks.listMembersEnriched,
  createMember: memberMocks.createMember,
  resendMemberAccessLink: memberMocks.resendMemberAccessLink,
  sendMemberSetupEmail: memberMocks.sendMemberSetupEmail,
  updateMember: memberMocks.updateMember,
  deactivateMember: memberMocks.deactivateMember,
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
    prismaMock.workflowJob.createMany.mockResolvedValue({ count: 1 });
    prismaMock.customerAccount.findMany.mockResolvedValue([]);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([]);
    memberMocks.sendMemberSetupEmail.mockResolvedValue({ status: "sent" });
  });

  it("allows global operators and rejects normal users without deployment access", async () => {
    const { requireControlPlaneAccess } = await import("./control-plane");

    await expect(requireControlPlaneAccess(operatorActor)).resolves.toEqual({ role: "OPERATOR" });
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValueOnce(null);
    await expect(requireControlPlaneAccess(userActor, { deploymentId: "inst-1" })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("allows future deployment-scoped access primitives", async () => {
    const { requireControlPlaneAccess } = await import("./control-plane");
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValueOnce({
      role: "SUPPORT_VIEWER",
      isActive: true,
    });

    await expect(requireControlPlaneAccess(userActor, { deploymentId: "inst-1" })).resolves.toEqual({ role: "SUPPORT_VIEWER" });
  });

  it("defaults control-plane agent bearer access to read-only scopes", async () => {
    const { resolveControlPlaneAgentFromBearer, runControlPlaneContextOperation } = await import("./control-plane");
    const actor = await resolveControlPlaneAgentFromBearer("cp-agent-secret");

    expect(actor).toMatchObject({
      kind: "agent",
      authProvider: "control-plane",
      scopes: ["control-plane:read"],
    });
    await expect(runControlPlaneContextOperation(actor!, {
      deploymentId: "inst-1",
      operation: "sync_all",
      reason: "Repair context.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_SCOPE_REQUIRED",
    });
  });

  it("encrypts support credentials and does not return ciphertext", async () => {
    const { configureSupportConnector } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      supportCredentialEnc: null,
    });
    prismaMock.customerDeployment.update.mockResolvedValueOnce({
      id: "inst-1",
      supportCredentialEnc: "encrypted:support-token",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportBaseUrl: "https://customer.test",
      supportCredentialLabel: "Corgtex Support",
    });

    const result = await configureSupportConnector(operatorActor, {
      deploymentId: "inst-1",
      supportBaseUrl: "https://customer.test",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredential: "support-token",
      supportCredentialLabel: "Corgtex Support",
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("support-token");
    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        supportCredentialEnc: "encrypted:support-token",
        supportConnectorStatus: "configured",
      }),
    }));
    expect(result.supportCredentialEnc).toBeUndefined();
  });

  it("lists customers with managed workspace summaries and redacted credentials", async () => {
    const { listControlPlaneDeployments } = await import("./control-plane");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: "inst-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "inst-1",
          label: "Acme",
          url: "https://acme.test",
          supportCredentialEnc: "encrypted-token",
          supportOperations: [],
          fleetSnapshots: [],
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
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([]);

    const result = await listControlPlaneDeployments(operatorActor);

    expect(prismaMock.customerAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        primaryDeployment: expect.any(Object),
      }),
    }));
    expect(result[0]).toMatchObject({
      id: "inst-1",
      customerAccountId: "cust-1",
      hasSupportCredential: true,
      managedWorkspace: {
        slug: "acme",
        _count: { brainArticles: 12 },
      },
    });
    expect(result[0].supportCredentialEnc).toBeUndefined();
  });

  it("lists customer accounts that still need a deployment", async () => {
    const { listControlPlaneDeployments } = await import("./control-plane");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([
      {
        id: "cust-2",
        slug: "future-co",
        displayName: "Future Co",
        status: "ONBOARDING",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "ops@corgtex.com",
        notes: null,
        primaryDeploymentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: null,
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([]);

    const result = await listControlPlaneDeployments(operatorActor);

    expect(result[0]).toMatchObject({
      id: "cust-2",
      customerSlug: "future-co",
      customerAccountId: "cust-2",
      hasDeployment: false,
      deploymentStatus: "DRAFT",
      supportConnectorStatus: "not_configured",
    });
  });

  it("configures meeting recorder entitlements for managed workspaces and audits the reason", async () => {
    const { configureControlPlaneMeetingRecorderIntegration } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
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
    prismaMock.customerEntitlement.upsert.mockResolvedValueOnce({
      id: "entitlement-1",
      customerAccountId: "cust-1",
      deploymentId: "inst-1",
      entitlementKey: "MEETING_RECORDERS",
      enabled: true,
      status: "ENABLED",
    });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const result = await configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      deploymentId: "inst-1",
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
    expect(prismaMock.customerEntitlement.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        customerAccountId_scopeKey_entitlementKey: {
          customerAccountId: "cust-1",
          scopeKey: "deployment:inst-1",
          entitlementKey: "MEETING_RECORDERS",
        },
      },
      update: expect.objectContaining({
        deploymentId: "inst-1",
        enabled: true,
        status: "ENABLED",
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "meeting-recorders:reconcile:ws-1:control-plane" },
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "inst-1",
        action: "control_plane.integration.meeting_recorders_configured",
        meta: expect.objectContaining({
          reason: "Customer signed recorder addendum.",
          monthlyMinuteCap: 1200,
        }),
      }),
    }));
    expect(result).toMatchObject({
      deploymentId: "inst-1",
      entitlementEnabled: true,
      entitlement: {
        id: "entitlement-1",
        status: "ENABLED",
      },
    });
  });

  it("requires a reason and managed workspace before configuring meeting recorders", async () => {
    const { configureControlPlaneMeetingRecorderIntegration } = await import("./control-plane");
    await expect(configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      deploymentId: "inst-1",
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

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: null,
      supportCredentialEnc: null,
      managedWorkspace: null,
    });
    await expect(configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      deploymentId: "inst-1",
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

  it("connects a workspace-scoped recorder calendar with encrypted tokens and queues sync", async () => {
    const { saveControlPlaneRecorderCalendarSource } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Customer",
      customerAccountId: "cust-1",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "customer", name: "Customer", _count: {} },
    });
    prismaMock.workspaceRecorderCalendarSource.upsert.mockResolvedValueOnce({
      id: "source-1",
      workspaceId: "ws-1",
      provider: "MICROSOFT",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      displayName: "Customer Recorder",
      expiresAt: new Date("2026-05-05T18:00:00.000Z"),
      scopes: ["Calendars.Read"],
      status: "ACTIVE",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncAt: null,
      lastSyncJobId: null,
      lastSyncError: null,
      lastDryRunAt: null,
      lastUpcomingEventCount: 0,
      lastSchedulableEventCount: 0,
      createdAt: new Date("2026-05-05T17:00:00.000Z"),
      updatedAt: new Date("2026-05-05T17:00:00.000Z"),
    });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const result = await saveControlPlaneRecorderCalendarSource(operatorActor, {
      deploymentId: "inst-1",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@customer.test",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      scopes: ["Calendars.Read"],
      reason: "Customer authorized recorder calendar.",
    });

    expect(encryptSecretMock).toHaveBeenCalledWith("access-token");
    expect(encryptSecretMock).toHaveBeenCalledWith("refresh-token");
    expect(prismaMock.workspaceRecorderCalendarSource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_provider: {
          workspaceId: "ws-1",
          provider: "MICROSOFT",
        },
      },
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting-recorders.calendar.sync",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.meeting_recorder_calendar_connected",
        meta: expect.objectContaining({
          providerAccountEmail: "calendar@customer.test",
        }),
      }),
    }));
    expect(result.source).toMatchObject({ id: "source-1", workspaceId: "ws-1" });
  });

  it("requires a completed smoke before enabling recorder auto-recording", async () => {
    const { runControlPlaneMeetingRecorderOperation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Customer",
      customerAccountId: "cust-1",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "customer", name: "Customer", _count: {} },
    });
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValueOnce(null);

    await expect(runControlPlaneMeetingRecorderOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "enable_auto_recording_after_smoke",
      reason: "Enable after smoke.",
    })).rejects.toMatchObject({
      status: 400,
      code: "RECORDER_SMOKE_REQUIRED",
    });

    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValueOnce({ id: "smoke-1", status: "COMPLETED" });
    prismaMock.workspaceMeetingRecorderConfig.upsert.mockResolvedValueOnce({ workspaceId: "ws-1", enabled: true, autoRecordEnabled: true });

    await expect(runControlPlaneMeetingRecorderOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "enable_auto_recording_after_smoke",
      reason: "Enable after smoke.",
    })).resolves.toMatchObject({
      operation: "enable_auto_recording_after_smoke",
      config: { enabled: true, autoRecordEnabled: true },
    });
    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      update: { autoRecordEnabled: true },
      create: {
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
      },
    });
  });

  it("rejects unsupported meeting recorder operations before mutating config", async () => {
    const { runControlPlaneMeetingRecorderOperation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Customer",
      customerAccountId: "cust-1",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "customer", name: "Customer", _count: {} },
    });

    await expect(runControlPlaneMeetingRecorderOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "unsupported_operation" as "enable_auto_recording_after_smoke",
      reason: "Invalid operation should not mutate.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).not.toHaveBeenCalled();
  });

  it("lists managed customer members including inactive accounts", async () => {
    const { listControlPlaneCustomerMembers } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      deploymentKind: "HOSTED",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
    });
    memberMocks.listMembersEnriched.mockResolvedValueOnce([
      {
        id: "member-1",
        role: "ADMIN",
        isActive: false,
        joinedAt: new Date("2026-01-02T00:00:00.000Z"),
        user: { id: "user-1", email: "admin@acme.test", displayName: "Admin" },
        roleAssignments: [{ role: { name: "Lead", circle: { id: "circle-1", name: "Ops" } } }],
      },
    ]);

    const result = await listControlPlaneCustomerMembers(operatorActor, "inst-1");

    expect(memberMocks.listMembersEnriched).toHaveBeenCalledWith("ws-1", { includeInactive: true });
    expect(result).toMatchObject({
      source: "managed_workspace",
      members: [
        {
          id: "member-1",
          email: "admin@acme.test",
          role: "ADMIN",
          isActive: false,
          roleAssignments: [{ roleName: "Lead", circleName: "Ops" }],
        },
      ],
    });
  });

  it("lists remote customer members with a read-scoped control-plane agent", async () => {
    const { listControlPlaneCustomerMembers } = await import("./control-plane");
    const readAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read"],
    };
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-members", action: "members.list" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-members",
      status: "COMPLETED",
      resultSummary: {
        members: [
          {
            id: "member-r",
            role: "ADMIN",
            isActive: true,
            user: { id: "user-r", email: "admin@remote.test", displayName: "Remote Admin" },
          },
        ],
      },
    });

    const result = await listControlPlaneCustomerMembers(readAgent, "inst-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "members.list" }),
    }));
    expect(result).toMatchObject({
      source: "support_connector",
      operationId: "op-members",
      members: [
        {
          id: "member-r",
          email: "admin@remote.test",
          role: "ADMIN",
          isActive: true,
        },
      ],
    });
  });

  it("creates and resends managed member setup links without returning raw tokens", async () => {
    const { createControlPlaneCustomerMember, resendControlPlaneCustomerMemberAccessLink } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "HOSTED",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    memberMocks.createMember.mockResolvedValueOnce({
      member: { id: "member-2", role: "CONTRIBUTOR", isActive: true, joinedAt: new Date("2026-01-02T00:00:00.000Z") },
      user: { id: "user-2", email: "new@acme.test", displayName: "New Member" },
      token: "setup-token-secret",
    });

    const created = await createControlPlaneCustomerMember(operatorActor, {
      deploymentId: "inst-1",
      email: "new@acme.test",
      displayName: "New Member",
      role: "CONTRIBUTOR",
      reason: "Customer approved onboarding.",
    });

    expect(memberMocks.createMember).toHaveBeenCalledWith(operatorActor, expect.objectContaining({
      workspaceId: "ws-1",
      email: "new@acme.test",
      skipAdminCheck: true,
    }));
    expect(memberMocks.sendMemberSetupEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: "new@acme.test",
      token: "setup-token-secret",
      workspaceName: "Acme",
    }));
    expect(JSON.stringify(created)).not.toContain("setup-token-secret");
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.access.member_created",
        meta: expect.objectContaining({
          reason: "Customer approved onboarding.",
          email: "new@acme.test",
        }),
      }),
    }));

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    memberMocks.resendMemberAccessLink.mockResolvedValueOnce({
      member: { id: "member-2", role: "CONTRIBUTOR", isActive: true },
      user: { id: "user-2", email: "new@acme.test", displayName: "New Member" },
      token: "reset-token-secret",
    });

    const resent = await resendControlPlaneCustomerMemberAccessLink(operatorActor, {
      deploymentId: "inst-1",
      memberId: "member-2",
      reason: "Customer requested a fresh setup link.",
    });

    expect(memberMocks.resendMemberAccessLink).toHaveBeenCalledWith(operatorActor, {
      workspaceId: "ws-1",
      memberId: "member-2",
    });
    expect(JSON.stringify(resent)).not.toContain("reset-token-secret");
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.access.link_resent",
        meta: expect.objectContaining({
          reason: "Customer requested a fresh setup link.",
          memberId: "member-2",
        }),
      }),
    }));
  });

  it("rejects member creation for deployment viewers without write access", async () => {
    const { createControlPlaneCustomerMember } = await import("./control-plane");
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValueOnce({
      role: "SUPPORT_VIEWER",
      isActive: true,
    });

    await expect(createControlPlaneCustomerMember(userActor, {
      deploymentId: "inst-1",
      email: "new@acme.test",
      displayName: "New Member",
      role: "CONTRIBUTOR",
      reason: "Customer approved onboarding.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED",
    });

    expect(memberMocks.createMember).not.toHaveBeenCalled();
  });

  it("allows access-write agents to create remote members through the support connector", async () => {
    const { createControlPlaneCustomerMember } = await import("./control-plane");
    const accessAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:access:write"],
    };
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-member-create", action: "members.invite" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({ id: "op-member-create", status: "COMPLETED" });

    const result = await createControlPlaneCustomerMember(accessAgent, {
      deploymentId: "inst-1",
      email: "new@remote.test",
      displayName: "New Member",
      role: "CONTRIBUTOR",
      reason: "Customer approved onboarding.",
    });

    expect(result).toMatchObject({
      source: "support_connector",
      operation: { id: "op-member-create", status: "COMPLETED" },
    });
  });

  it("lists and toggles managed workspace feature flags with audit evidence", async () => {
    const { listControlPlaneFeatureFlags, setControlPlaneFeatureFlag } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "HOSTED",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValueOnce([
      { flag: "FINANCE", enabled: false, config: null, updatedAt: new Date("2026-01-03T00:00:00.000Z") },
    ]);
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValueOnce([
      {
        actorUserId: "operator-1",
        meta: { flag: "FINANCE" },
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ]);

    const flags = await listControlPlaneFeatureFlags(operatorActor, "inst-1");
    const finance = flags.flags.find((flag) => flag.flag === "FINANCE");

    expect(finance).toMatchObject({
      enabled: false,
      source: "workspace_override",
      lastChangedBy: "operator-1",
    });

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValueOnce({
      workspaceId: "ws-1",
      flag: "FINANCE",
      enabled: true,
    });

    const result = await setControlPlaneFeatureFlag(operatorActor, {
      deploymentId: "inst-1",
      flag: "FINANCE",
      enabled: true,
      reason: "Customer enabled finance module.",
    });

    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId_flag: {
          workspaceId: "ws-1",
          flag: "FINANCE",
        },
      },
      update: { enabled: true },
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.feature_flag.updated",
        meta: expect.objectContaining({
          reason: "Customer enabled finance module.",
          flag: "FINANCE",
          enabled: true,
        }),
      }),
    }));
    expect(result).toMatchObject({
      source: "managed_workspace",
      flag: "FINANCE",
      enabled: true,
    });
  });

  it("lists remote feature flags with a read-scoped control-plane agent", async () => {
    const { listControlPlaneFeatureFlags } = await import("./control-plane");
    const readAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read"],
    };
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-flags", action: "feature_flags.list" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-flags",
      status: "COMPLETED",
      resultSummary: {
        flags: [
          {
            flag: "FINANCE",
            enabled: true,
            source: "remote_override",
          },
        ],
      },
    });

    const result = await listControlPlaneFeatureFlags(readAgent, "inst-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "feature_flags.list" }),
    }));
    expect(result).toMatchObject({
      source: "support_connector",
      operationId: "op-flags",
      flags: [
        {
          flag: "FINANCE",
          enabled: true,
          source: "remote_override",
        },
      ],
    });
  });

  it("allows feature-write agents to set remote feature flags through the support connector", async () => {
    const { setControlPlaneFeatureFlag } = await import("./control-plane");
    const featureAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:features:write"],
    };
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-flag-set", action: "feature_flags.set" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({ id: "op-flag-set", status: "COMPLETED" });

    const result = await setControlPlaneFeatureFlag(featureAgent, {
      deploymentId: "inst-1",
      flag: "FINANCE",
      enabled: true,
      reason: "Enable finance for pilot.",
    });

    expect(result).toMatchObject({
      source: "support_connector",
      flag: "FINANCE",
      enabled: true,
      operation: { id: "op-flag-set", status: "COMPLETED" },
    });
  });

  it("queues sync for all active managed workspace context sources and audits the reason", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
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
      deploymentId: "inst-1",
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
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "inst-1",
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
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
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
      deploymentId: "inst-1",
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
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
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
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
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
      deploymentId: "inst-1",
      operation: "disable_source",
      sourceId: "source-1",
      reason: "Source is creating invalid context.",
    });

    expect(prismaMock.externalDataSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-1" },
      data: { isActive: false },
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
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
      deploymentId: "inst-1",
      operation: "sync_all",
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: null,
      supportCredentialEnc: null,
      managedWorkspace: null,
    });
    await expect(runControlPlaneContextOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "sync_all",
      reason: "Customer asked for context repair.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MANAGED_WORKSPACE_REQUIRED",
    });
  });

  it("rejects context operations for sources outside the managed workspace", async () => {
    const { runControlPlaneContextOperation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
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
      deploymentId: "inst-1",
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
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
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
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValueOnce([
      {
        id: "event-1",
        actorUserId: "operator-1",
        action: "control_plane.release.upgrade_prepared",
        meta: {},
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const result = await runControlPlaneReleaseOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      targetReleaseVersion: "0.2.0",
      reason: "Prepare staged release after smoke checks.",
    });

    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "inst-1",
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
    expect(prismaMock.customerReleaseTarget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deploymentId_targetReleaseImageTag: {
          deploymentId: "inst-1",
          targetReleaseImageTag: "ghcr.io/corgtex/app:new",
        },
      },
      update: expect.objectContaining({
        status: "PREPARED",
        targetReleaseVersion: "0.2.0",
      }),
    }));
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
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

  it("preflights and deploys the configured latest release for one customer", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_VERSION", "0.2.0");
    const { deployLatestControlPlaneRelease, getControlPlaneDeployLatestPreflight } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      customerSlug: "acme",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "release-old",
      releaseVersion: "0.1.0",
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthError: null,
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);

    const preflight = await getControlPlaneDeployLatestPreflight(operatorActor, "inst-1");

    expect(preflight).toMatchObject({
      eligible: true,
      target: {
        releaseImageTag: "release-new",
        releaseVersion: "0.2.0",
        webImage: "ghcr.io/corgtex/web:new",
        workerImage: "ghcr.io/corgtex/worker:new",
      },
    });

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ web: "web-deploy-1", worker: "worker-deploy-1" }),
    };

    const result = await deployLatestControlPlaneRelease(operatorActor, {
      deploymentId: "inst-1",
      reason: "Deploy latest after production smoke passed.",
    }, railwayClient);

    expect(railwayClient.graphql).toHaveBeenCalledTimes(3);
    const deploymentUpdates = prismaMock.customerDeployment.update.mock.calls.map(([call]) => call as { where: unknown; data: Record<string, unknown> });
    expect(deploymentUpdates[0]).toMatchObject({
      where: { id: "inst-1" },
      data: {
        provisioningStatus: "provisioning",
        lastProvisioningError: null,
      },
    });
    expect(deploymentUpdates[0].data).not.toHaveProperty("releaseImageTag");
    expect(deploymentUpdates[0].data).not.toHaveProperty("releaseVersion");
    expect(deploymentUpdates[1]).toMatchObject({
      where: { id: "inst-1" },
      data: {
        provisioningStatus: "active",
        releaseImageTag: "release-new",
      },
    });
    expect(prismaMock.customerReleaseTarget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "APPLYING" }),
    }));
    expect(prismaMock.customerReleaseTarget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: "APPLIED" }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "control_plane.release.deploy_latest_started" }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "control_plane.release.deploy_latest_succeeded" }),
    }));
    expect(result).toMatchObject({
      deploymentId: "inst-1",
      status: "deployed",
      target: { releaseImageTag: "release-new" },
    });
  });

  it("clears the runtime release version variable when latest release has no version", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_VERSION", "");
    const { deployLatestControlPlaneRelease } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      customerSlug: "acme",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "release-old",
      releaseVersion: "0.1.0",
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthError: null,
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    const railwayClient = {
      graphql: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ web: "web-deploy-1", worker: "worker-deploy-1" }),
    };

    await deployLatestControlPlaneRelease(operatorActor, {
      deploymentId: "inst-1",
      reason: "Deploy image-only latest release.",
    }, railwayClient);

    expect(railwayClient.graphql).toHaveBeenCalledTimes(3);
    expect(railwayClient.graphql.mock.calls[1]?.[1]).toMatchObject({
      variables: {
        CORGTEX_RELEASE_IMAGE_TAG: "release-new",
        CORGTEX_RELEASE_VERSION: "",
      },
    });
    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        releaseImageTag: "release-new",
        releaseVersion: null,
      }),
    }));
  });

  it("does not mark a release current when deploy latest fails", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_VERSION", "0.2.0");
    const { deployLatestControlPlaneRelease } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      customerSlug: "acme",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "release-old",
      releaseVersion: "0.1.0",
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthError: null,
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    const railwayClient = {
      graphql: vi.fn().mockRejectedValueOnce(new Error("Railway deployment failed.")),
    };

    await expect(deployLatestControlPlaneRelease(operatorActor, {
      deploymentId: "inst-1",
      reason: "Deploy latest after production smoke passed.",
    }, railwayClient)).rejects.toThrow("Railway deployment failed.");

    const deploymentUpdates = prismaMock.customerDeployment.update.mock.calls.map(([call]) => call as { where: unknown; data: Record<string, unknown> });
    expect(deploymentUpdates[0].data).not.toHaveProperty("releaseImageTag");
    expect(deploymentUpdates[0].data).not.toHaveProperty("releaseVersion");
    expect(deploymentUpdates[1]).toMatchObject({
      where: { id: "inst-1" },
      data: {
        provisioningStatus: "degraded",
        lastProvisioningError: "Railway deployment failed.",
      },
    });
    expect(deploymentUpdates[1].data).not.toHaveProperty("releaseImageTag");
    expect(deploymentUpdates[1].data).not.toHaveProperty("releaseVersion");
  });

  it("does not force deploy when current preflight has non-bypass blockers", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { deployLatestControlPlaneRelease } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Suspended",
      customerAccountId: "cust-1",
      customerSlug: "suspended",
      deploymentKind: "HOSTED",
      deploymentStatus: "SUSPENDED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "release-old",
      releaseVersion: null,
      lastHealthStatus: "down",
      lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
      lastHealthError: "Runtime down.",
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    });
    const railwayClient = { graphql: vi.fn() };

    await expect(deployLatestControlPlaneRelease(operatorActor, {
      deploymentId: "inst-1",
      reason: "Retry previously queued rollout.",
      force: true,
    }, railwayClient)).rejects.toMatchObject({
      status: 400,
      code: "RELEASE_PREFLIGHT_FAILED",
    });

    expect(railwayClient.graphql).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
  });

  it("queues bulk deploy-latest jobs and skips clients that fail preflight", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE, enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "inst-1",
        label: "Acme",
        customerAccountId: "cust-1",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
      },
      {
        id: "inst-2",
        label: "Broken",
        customerAccountId: "cust-2",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "down",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: "Runtime down.",
        railwayProjectId: "project-2",
        railwayEnvironmentId: "env-2",
        railwayWebServiceId: "web-2",
        railwayWorkerServiceId: "worker-2",
      },
    ]);

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      allEligible: true,
      reason: "Deploy latest to healthy customers.",
      limit: 2,
    });

    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: null,
        type: CONTROL_PLANE_RELEASE_DEPLOY_JOB_TYPE,
        payload: expect.objectContaining({
          deploymentId: "inst-1",
          reason: "Deploy latest to healthy customers.",
        }),
      }),
      skipDuplicates: true,
    }));
    expect(result).toMatchObject({
      requested: 2,
      queuedJobs: 1,
      results: [
        { deploymentId: "inst-1", status: "queued" },
        { deploymentId: "inst-2", status: "skipped" },
      ],
    });
  });

  it("rejects empty selected bulk deploy requests unless all eligible clients are explicit", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");

    await expect(enqueueControlPlaneDeployLatestRollout(operatorActor, {
      deploymentIds: [],
      allEligible: false,
      reason: "Deploy latest to selected customers.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
  });

  it("rejects explicit bulk deploy selections that exceed the rollout limit", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");

    await expect(enqueueControlPlaneDeployLatestRollout(operatorActor, {
      deploymentIds: ["inst-1", "inst-2"],
      limit: 1,
      reason: "Deploy latest to selected customers.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
  });

  it("rejects explicit bulk deploy selections with unknown deployment IDs", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "inst-1",
        label: "Acme",
        customerAccountId: "cust-1",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
      },
    ]);

    await expect(enqueueControlPlaneDeployLatestRollout(operatorActor, {
      deploymentIds: ["inst-1", "inst-missing"],
      reason: "Deploy latest to selected customers.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
      message: expect.stringContaining("inst-missing"),
    });

    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
    expect(prismaMock.customerDeploymentEvent.create).not.toHaveBeenCalled();
  });

  it("rejects fleet-wide bulk deploys for deployment-scoped user access", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");

    await expect(enqueueControlPlaneDeployLatestRollout(userActor, {
      allEligible: true,
      reason: "Deploy latest to every eligible customer.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED",
    });

    expect(prismaMock.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
  });

  it("rejects deployment viewer access for privileged customer mutations", async () => {
    const { deployLatestControlPlaneRelease, setControlPlaneFeatureFlag, updateControlPlaneCustomerMemberStatus } = await import("./control-plane");
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValue({
      role: "SUPPORT_VIEWER",
      isActive: true,
    });

    await expect(updateControlPlaneCustomerMemberStatus(userActor, {
      deploymentId: "inst-1",
      memberId: "member-1",
      isActive: false,
      reason: "Suspend stale access.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED",
    });

    await expect(setControlPlaneFeatureFlag(userActor, {
      deploymentId: "inst-1",
      flag: "FINANCE",
      enabled: true,
      reason: "Enable finance module.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED",
    });

    await expect(deployLatestControlPlaneRelease(userActor, {
      deploymentId: "inst-1",
      reason: "Deploy latest.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED",
    });
  });

  it("only bypasses health blockers for explicitly selected bulk deploys", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "inst-1",
        label: "Unhealthy",
        customerAccountId: "cust-1",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "down",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: "Runtime down.",
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
      },
      {
        id: "inst-2",
        label: "Missing Railway",
        customerAccountId: "cust-2",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: null,
        railwayEnvironmentId: "env-2",
        railwayWebServiceId: "web-2",
        railwayWorkerServiceId: "worker-2",
      },
    ]);

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      deploymentIds: ["inst-1", "inst-2"],
      includeUnhealthy: true,
      reason: "Explicitly selected recovery rollout.",
    });

    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          deploymentId: "inst-1",
          force: true,
        }),
      }),
    }));
    expect(result).toMatchObject({
      requested: 2,
      queuedJobs: 1,
      results: [
        { deploymentId: "inst-1", status: "queued" },
        { deploymentId: "inst-2", status: "preflight_failed" },
      ],
    });
  });

  it("reports deduplicated rollout jobs as skipped with release version in the dedupe key", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_VERSION", "0.2.0");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "inst-1",
        label: "Acme",
        customerAccountId: "cust-1",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: "0.1.0",
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-01-01T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
      },
    ]);
    prismaMock.workflowJob.createMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.workflowJob.findUnique.mockResolvedValueOnce({ id: "job-existing", status: "PENDING" });

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      allEligible: true,
      reason: "Retry latest rollout.",
    });

    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dedupeKey: expect.stringContaining(":release-new:0.2.0:"),
      }),
      skipDuplicates: true,
    }));
    expect(prismaMock.workflowJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        dedupeKey: expect.stringContaining(":release-new:0.2.0:"),
      },
    }));
    expect(result).toMatchObject({
      requested: 1,
      queuedJobs: 0,
      results: [
        { deploymentId: "inst-1", status: "skipped" },
      ],
    });
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.release.deploy_latest_skipped",
        meta: expect.objectContaining({
          existingJobId: "job-existing",
        }),
      }),
    }));
  });

  it("requires reason, target image tag, and supported operation for release operations", async () => {
    const { runControlPlaneReleaseOperation } = await import("./control-plane");
    await expect(runControlPlaneReleaseOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
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
      deploymentId: "inst-1",
      operation: "prepare_upgrade",
      targetReleaseImageTag: "",
      reason: "Prepare release.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(runControlPlaneReleaseOperation(operatorActor, {
      deploymentId: "inst-1",
      operation: "upgrade_now",
      targetReleaseImageTag: "ghcr.io/corgtex/app:new",
      reason: "Prepare release.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("probes customer health with scoped release access and records audit evidence", async () => {
    const { probeControlPlaneDeploymentHealth } = await import("./control-plane");
    const scopedAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:releases:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      url: "https://customer.test",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      releaseImageTag: "sha-new",
      releaseVersion: "0.2.0",
      lastHealthStatus: null,
      lastHealthError: null,
      lastHealthCheck: null,
      lastWorkerHealthStatus: null,
      lastWorkerHealthCheck: null,
      lastReleaseCheck: null,
      provisioningStatus: "provisioning",
      bootstrapStatus: "completed",
      lastProvisioningError: null,
    });
    prismaMock.customerDeployment.update.mockResolvedValueOnce({ id: "inst-1" });
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValueOnce([]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        database: "up",
        schema: "ready",
        runtime: { redis: "configured", storage: "configured" },
        release: { gitSha: "sha-new" },
      }),
    })) as any;

    const result = await probeControlPlaneDeploymentHealth(scopedAgent, {
      deploymentId: "inst-1",
      reason: "Post-deploy health check.",
    });

    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inst-1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
        deploymentStatus: "ACTIVE",
      }),
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentId: "inst-1",
        snapshotKind: "HEALTH",
        status: "ok",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.release.health_probed",
        meta: expect.objectContaining({
          reason: "Post-deploy health check.",
          status: "ok",
        }),
      }),
    }));
    expect(result.status).toBe("ok");
  });

  it("records and completes an audited remote support operation", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-1",
      action: "members.invite",
    });
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
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
      deploymentId: "inst-1",
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

  it("refreshes cached connector snapshots without remote calls when connector setup is missing", async () => {
    const { refreshControlPlaneFleetSnapshots } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      supportMcpUrl: null,
      supportConnectorStatus: "not_configured",
      supportLastConnectedAt: null,
      supportLastSyncAt: null,
      supportLastSyncError: null,
    });

    const result = await refreshControlPlaneFleetSnapshots(operatorActor, {
      deploymentId: "inst-1",
      snapshotKinds: ["CONNECTOR", "SUPPORT_READY"],
      reason: "Operator requested cached readiness refresh.",
    });

    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentId: "inst-1",
        snapshotKind: "CONNECTOR",
        status: "not_configured",
      }),
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentId: "inst-1",
        snapshotKind: "SUPPORT_READY",
        status: "not_configured",
      }),
    }));
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      adapterKind: "unconfigured",
      results: [
        { snapshotKind: "CONNECTOR", status: "not_configured" },
        { snapshotKind: "SUPPORT_READY", status: "not_configured" },
      ],
    });
  });

  it("queues bounded fleet snapshot jobs against central deployment rows", async () => {
    const { CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE, enqueueControlPlaneFleetSnapshots } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      { id: "inst-1" },
      { id: "inst-2" },
    ]);
    prismaMock.workflowJob.upsert.mockResolvedValue({ id: "job-1" });

    const result = await enqueueControlPlaneFleetSnapshots(operatorActor, {
      snapshotKinds: ["HEALTH", "RELEASE"],
      reason: "Queue hourly customer fleet sweep.",
      limit: 2,
    });

    expect(prismaMock.customerDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        customerAccountId: { not: null },
        deploymentStatus: { notIn: ["RETIRED", "SUSPENDED"] },
      }),
      take: 2,
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: null,
        type: CONTROL_PLANE_FLEET_SNAPSHOT_JOB_TYPE,
        payload: expect.objectContaining({
          snapshotKinds: ["HEALTH", "RELEASE"],
          reason: "Queue hourly customer fleet sweep.",
        }),
      }),
    }));
    expect(result).toMatchObject({
      queuedJobs: 2,
      deploymentIds: ["inst-1", "inst-2"],
    });
  });
});
