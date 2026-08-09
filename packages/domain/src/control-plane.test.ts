import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, encryptSecretMock, decryptSecretMock, memberMocks, communicationMocks } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(async (operations: unknown[] | ((tx: unknown) => unknown)) => (
      typeof operations === "function" ? operations(prismaMock) : Promise.all(operations)
    )),
    customerDeploymentAccess: {
      findUnique: vi.fn(),
    },
    customerDeploymentEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    customerAccount: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    customerEntitlement: {
      count: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    customerReleaseTarget: {
      count: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    fleetHealthSnapshot: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    approvalPolicy: {
      count: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    member: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    circle: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    role: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    roleVersion: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    roleHolderHistory: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    roleAssignment: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    roleOnboardingSession: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    approvalFlow: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    approvalDecision: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    objection: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    customerDeployment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    clientMigrationRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    clientMigrationIdMap: {
      upsert: vi.fn(),
    },
    workspaceFeatureFlag: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workspaceMeetingRecorderConfig: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workspaceRecorderCalendarSource: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    meetingRecorderSmokeRun: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    selfServeSmokeRun: {
      findFirst: vi.fn(),
    },
    meetingRecording: {
      aggregate: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      update: vi.fn(),
    },
    meeting: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    brainSource: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    brainArticle: {
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
      findMany: vi.fn(),
    },
    document: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeClient: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeConsultant: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeProject: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeTimeEntry: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeExpense: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    financeContributionEntry: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    event: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    workflowJob: {
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    agentRun: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    oauthConnection: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    executionRequest: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    executionResult: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphObject: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphRelationship: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    agentToolCall: {
      findMany: vi.fn(),
    },
    agentIdentity: {
      findMany: vi.fn(),
    },
    workspaceAgentConfig: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    agentCredential: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    action: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    proposal: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    tension: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    modelUsage: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    modelUsageBudget: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceBillingProfile: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    workspaceEnterpriseService: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    appInstallation: {
      findMany: vi.fn(),
    },
    communicationInstallation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workspaceToolLink: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    workspaceToolLinkCircleTag: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    catalogItem: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    catalogFavorite: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    catalogRequest: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    catalogSettings: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    goal: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    goalUpdate: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    goalLink: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    recognition: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    checkIn: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    supportOperation: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
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
  communicationMocks: {
    getSlackExpectedTeamIdForWorkspace: vi.fn(),
    saveSlackInstallationForWorkspace: vi.fn(),
    validateSlackPostTarget: vi.fn(),
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
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: "slack-client-secret",
  },
  prisma: prismaMock,
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
  randomOpaqueToken: vi.fn(() => "nonce-value"),
  toInputJson: (value: unknown) => value,
}));

vi.mock("./members", () => ({
  listMembersEnriched: memberMocks.listMembersEnriched,
  createMember: memberMocks.createMember,
  resendMemberAccessLink: memberMocks.resendMemberAccessLink,
  sendMemberSetupEmail: memberMocks.sendMemberSetupEmail,
  updateMember: memberMocks.updateMember,
  deactivateMember: memberMocks.deactivateMember,
}));

vi.mock("./communication", () => ({
  getSlackExpectedTeamIdForWorkspace: communicationMocks.getSlackExpectedTeamIdForWorkspace,
  saveSlackInstallationForWorkspace: communicationMocks.saveSlackInstallationForWorkspace,
  validateSlackPostTarget: communicationMocks.validateSlackPostTarget,
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

const POST_DEPLOY_REQUIRED_READ_SCOPES = [
  "workspace:read",
  "actions:read",
  "proposals:read",
  "tensions:read",
  "meetings:read",
  "execution:read",
  "brain:read",
];

function mcpToolResult(payload: unknown, isError = false) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        ...(isError ? { isError: true } : {}),
        content: [{ type: "text", text: JSON.stringify(payload) }],
      },
    }),
  };
}

const SUPPORT_AUDIT_PARAMS = {
  action: "finance_v2.closeout",
  reason: "Record sanitized Finance V2 closeout.",
  summary: "Finance V2 closeout verified with sanitized evidence.",
};

function supportAuditDeployment(overrides: Record<string, unknown> = {}) {
  return { id: "inst-1", label: "Acme", url: "https://customer.test", supportMcpUrl: "https://customer.test/api/mcp", supportCredentialEnc: "encrypted-token", supportConnectorStatus: "connected", managedWorkspaceId: null, remoteWorkspaceId: null, ...overrides };
}

function supportAuditInputSummary(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, action: SUPPORT_AUDIT_PARAMS.action, outcome: "completed", summary: SUPPORT_AUDIT_PARAMS.summary, evidence: {}, remoteWorkspaceId: null, ...overrides };
}

function recentRecorderProofDate(offsetMs = 0) {
  return new Date(Date.now() - 60 * 60 * 1000 + offsetMs);
}

describe("control plane domain", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.workflowJob.findFirst.mockResolvedValue(null);
    prismaMock.workflowJob.findMany.mockResolvedValue([]);
    prismaMock.agentRun.count.mockResolvedValue(0);
    prismaMock.agentRun.findMany.mockResolvedValue([]);
    prismaMock.agentRun.groupBy.mockResolvedValue([]);
    prismaMock.agentToolCall.findMany.mockResolvedValue([]);
    prismaMock.agentIdentity.findMany.mockResolvedValue([]);
    prismaMock.workspaceAgentConfig.findMany.mockResolvedValue([]);
    prismaMock.agentCredential.findMany.mockResolvedValue([]);
    prismaMock.modelUsage.aggregate.mockResolvedValue({ _sum: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null } });
    prismaMock.modelUsage.findMany.mockResolvedValue([]);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValue(null);
    prismaMock.supportOperation.findMany.mockResolvedValue([]);
    prismaMock.supportOperation.findUnique.mockResolvedValue(null);
    prismaMock.fleetHealthSnapshot.findFirst.mockResolvedValue(null);
    prismaMock.customerDeploymentEvent.findFirst.mockResolvedValue(null);
    prismaMock.selfServeSmokeRun.findFirst.mockResolvedValue(null);
    prismaMock.customerAccount.findMany.mockResolvedValue([]);
    prismaMock.customerAccount.upsert.mockResolvedValue({
      id: "acct_1",
      slug: "acme",
      displayName: "Acme",
      status: "ACTIVE",
      managementAuthority: "CORGTEX",
      supportOwnerEmail: null,
      notes: null,
      primaryDeploymentId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    prismaMock.customerAccount.findUnique.mockResolvedValue({ id: "acct_1", primaryDeploymentId: null });
    prismaMock.customerAccount.update.mockResolvedValue({ id: "acct_1", primaryDeploymentId: "dep-1" });
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue(null);
    prismaMock.customerDeployment.findUnique.mockResolvedValue(null);
    prismaMock.communicationInstallation.findFirst.mockResolvedValue(null);
    prismaMock.communicationInstallation.update.mockResolvedValue({ id: "slack-1" });
    communicationMocks.getSlackExpectedTeamIdForWorkspace.mockResolvedValue(null);
    communicationMocks.saveSlackInstallationForWorkspace.mockResolvedValue({
      id: "slack-1",
      workspaceId: "ws-1",
      provider: "SLACK",
      externalWorkspaceId: "T1",
      externalTeamName: "Acme Slack",
      scopes: ["commands", "chat:write"],
      status: "ACTIVE",
    });
    communicationMocks.validateSlackPostTarget.mockResolvedValue({
      ok: true,
      channelId: "C123",
      channelName: "ops",
    });
    prismaMock.customerDeployment.upsert.mockResolvedValue({
      id: "dep-1",
      label: "Acme",
      url: "https://app.test/workspaces/ws-1",
      customerSlug: "acme",
      customerAccountId: "acct_1",
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      provisioningStatus: "active",
      bootstrapStatus: "not_started",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
    });
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({
      id: "ws-1",
      slug: "acme",
      name: "Acme",
      description: null,
    });
    prismaMock.workspace.count.mockResolvedValue(0);
    prismaMock.workspace.findMany.mockResolvedValue([]);
    prismaMock.approvalPolicy.createMany.mockResolvedValue({ count: 2 });
    prismaMock.member.count.mockResolvedValue(0);
    prismaMock.member.findMany.mockResolvedValue([]);
    for (const modelName of [
      "circle",
      "role",
      "roleVersion",
      "roleHolderHistory",
      "roleAssignment",
      "roleOnboardingSession",
      "approvalPolicy",
      "approvalFlow",
      "approvalDecision",
      "objection",
      "workspaceFeatureFlag",
      "workspaceToolLink",
      "workspaceToolLinkCircleTag",
      "catalogItem",
      "catalogFavorite",
      "catalogRequest",
      "catalogSettings",
      "brainSource",
      "brainArticle",
      "externalDataSource",
      "knowledgeChunk",
      "document",
      "financeClient",
      "financeConsultant",
      "financeProject",
      "financeTimeEntry",
      "financeExpense",
      "financeContributionEntry",
      "meeting",
      "meetingRecording",
      "action",
      "proposal",
      "tension",
      "auditLog",
      "event",
      "workflowJob",
      "agentRun",
      "agentCredential",
      "oauthConnection",
      "executionRequest",
      "executionResult",
      "contextGraphObject",
      "contextGraphRelationship",
      "goal",
      "goalUpdate",
      "goalLink",
      "recognition",
      "checkIn",
      "modelUsageBudget",
      "workspaceBillingProfile",
      "workspaceEnterpriseService",
      "appInstallation",
      "communicationInstallation",
      "supportOperation",
      "customerDeploymentEvent",
      "fleetHealthSnapshot",
      "customerEntitlement",
      "customerReleaseTarget",
    ]) {
      const model = (prismaMock as Record<string, { count?: ReturnType<typeof vi.fn>; findMany?: ReturnType<typeof vi.fn> }>)[modelName];
      model?.count?.mockResolvedValue(0);
      model?.findMany?.mockResolvedValue([]);
    }
    prismaMock.clientMigrationIdMap.upsert.mockResolvedValue({ id: "map-1" });
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([]);
    prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([]);
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue(null);
    prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue(null);
    prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([]);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.aggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } });
    prismaMock.meetingRecording.count.mockResolvedValue(0);
    prismaMock.meetingRecording.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.findMany.mockResolvedValue([]);
    prismaMock.meetingRecording.groupBy.mockResolvedValue([]);
    memberMocks.sendMemberSetupEmail.mockResolvedValue({ status: "sent" });
    vi.stubEnv("RAILWAY_API_TOKEN", "test-railway-token");
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

  it("creates a shared-workspace client with account deployment registration and feature posture", async () => {
    const { createControlPlaneClient } = await import("./control-plane");
    memberMocks.createMember.mockResolvedValueOnce({
      user: { id: "user-admin", email: "admin@example.com", displayName: "Admin" },
      member: { id: "member-admin", role: "ADMIN" },
      token: "setup-token",
    });

    const result = await createControlPlaneClient(operatorActor, {
      mode: "shared_workspace",
      label: "Acme",
      customerSlug: "acme",
      reason: "Approved onboarding.",
      supportOwnerEmail: "ops@corgtex.com",
      featurePosture: "minimal",
      initialAdmins: [{ email: "admin@example.com", displayName: "Admin" }],
    });

    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Acme",
        slug: "acme",
      }),
    });
    expect(prismaMock.customerDeployment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        customerSlug: "acme",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
        managedWorkspaceId: "ws-1",
      }),
    }));
    expect(memberMocks.createMember).toHaveBeenCalledWith(operatorActor, expect.objectContaining({
      workspaceId: "ws-1",
      email: "admin@example.com",
      role: "ADMIN",
      skipAdminCheck: true,
    }));
    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_flag: { workspaceId: "ws-1", flag: "MEETING_RECORDERS" } },
      update: { enabled: false },
    }));
    expect(result).toMatchObject({
      clientMode: "shared_workspace",
      deployment: { id: "dep-1", deploymentKind: "SHARED_WORKSPACE" },
      readiness: { status: "ready" },
    });
  });

  it("rejects raw runtime variables in hosted client creation", async () => {
    const { createControlPlaneClient } = await import("./control-plane");

    await expect(createControlPlaneClient(operatorActor, {
      mode: "hosted_dedicated",
      label: "Acme Hosted",
      customerSlug: "acme-hosted",
      reason: "Approved onboarding.",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      variables: { MODEL_PROVIDER: "openrouter" },
    })).rejects.toMatchObject({
      status: 400,
      code: "RAW_RUNTIME_VARIABLES_REJECTED",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("keeps production client creation disabled unless explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createControlPlaneClient } = await import("./control-plane");

    await expect(createControlPlaneClient(operatorActor, {
      mode: "shared_workspace",
      label: "Acme",
      customerSlug: "acme",
      reason: "Approved onboarding.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_CLIENT_CREATE_DISABLED",
    });
    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("keeps production hosted creation behind a separate capability gate", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONTROL_PLANE_CLIENT_CREATE_ENABLED", "true");
    const { createControlPlaneClient } = await import("./control-plane");

    await expect(createControlPlaneClient(operatorActor, {
      mode: "hosted_dedicated",
      label: "Acme Hosted",
      customerSlug: "acme-hosted",
      reason: "Approved onboarding.",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_HOSTED_CREATE_DISABLED",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("rejects hosted client creation as primary until readiness or migration cutover promotes it", async () => {
    const { createControlPlaneClient } = await import("./control-plane");

    await expect(createControlPlaneClient(operatorActor, {
      mode: "hosted_dedicated",
      label: "Acme Hosted",
      customerSlug: "acme-hosted",
      reason: "Approved onboarding.",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      primary: true,
    })).rejects.toMatchObject({
      status: 400,
      code: "HOSTED_PRIMARY_UNSUPPORTED",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("rejects hosted client setup inputs that cannot be applied without a generated bootstrap bundle", async () => {
    const { createControlPlaneClient } = await import("./control-plane");

    await expect(createControlPlaneClient(operatorActor, {
      mode: "hosted_dedicated",
      label: "Acme Hosted",
      customerSlug: "acme-hosted",
      reason: "Approved onboarding.",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      initialAdmins: [{ email: "admin@example.com" }],
    })).rejects.toMatchObject({
      status: 400,
      code: "HOSTED_INITIAL_ADMINS_UNSUPPORTED",
    });

    await expect(createControlPlaneClient(operatorActor, {
      mode: "hosted_dedicated",
      label: "Acme Hosted",
      customerSlug: "acme-hosted",
      reason: "Approved onboarding.",
      region: "eu-west4",
      dataResidency: "eu",
      releaseImageTag: "sha-1",
      featurePosture: "minimal",
    })).rejects.toMatchObject({
      status: 400,
      code: "HOSTED_FEATURE_POSTURE_UNSUPPORTED",
    });
    expect(prismaMock.customerDeployment.upsert).not.toHaveBeenCalled();
  });

  it("fails migration dry-run when active source writes are not confirmed quiesced", async () => {
    const { runControlPlaneClientMigrationDryRun } = await import("./control-plane");
    const sourceDeployment = {
      id: "dep-source",
      label: "Acme Shared",
      customerSlug: "acme",
      customerAccountId: "acct_1",
      customerAccount: {
        id: "acct_1",
        slug: "acme",
        displayName: "Acme",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: "dep-source",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(sourceDeployment);
    prismaMock.clientMigrationRun.create.mockResolvedValue({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: null,
      direction: "shared_to_hosted",
      status: "planned",
      reason: "Move to hosted.",
      planSummary: {},
    });
    prismaMock.clientMigrationRun.update.mockResolvedValue({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: null,
      direction: "shared_to_hosted",
      status: "dry_run_failed",
      reason: "Move to hosted.",
      verificationSummary: {
        dryRun: {
          passed: false,
          checks: [{ key: "source_writes_quiesced", ok: false }],
        },
      },
      sourceDeployment,
      destinationDeployment: null,
      customerAccount: sourceDeployment.customerAccount,
      _count: { idMaps: 0 },
    });

    const result = await runControlPlaneClientMigrationDryRun(operatorActor, {
      sourceDeploymentId: "dep-source",
      targetMode: "hosted_dedicated",
      reason: "Move to hosted.",
    });

    expect(prismaMock.clientMigrationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "dry_run_failed",
        error: "Dry-run checks failed.",
      }),
    }));
    expect(result).toMatchObject({
      id: "mig-1",
      status: "dry_run_failed",
      verificationSummary: {
        dryRun: {
          passed: false,
        },
      },
    });
  });

  it("includes native Finance entities in managed-workspace migration inventory", async () => {
    const { runControlPlaneClientMigrationDryRun } = await import("./control-plane");
    const sourceDeployment = {
      id: "dep-source",
      label: "Acme Shared",
      customerSlug: "acme",
      customerAccountId: "acct_1",
      customerAccount: {
        id: "acct_1",
        slug: "acme",
        displayName: "Acme",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: "dep-source",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(sourceDeployment);
    prismaMock.clientMigrationRun.create.mockResolvedValue({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: null,
      direction: "shared_to_hosted",
      status: "planned",
      reason: "Move to hosted.",
      planSummary: {},
    });
    prismaMock.clientMigrationRun.update.mockImplementationOnce(async ({ data }) => ({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: null,
      direction: "shared_to_hosted",
      status: data.status,
      reason: "Move to hosted.",
      verificationSummary: data.verificationSummary,
      sourceDeployment,
      destinationDeployment: null,
      customerAccount: sourceDeployment.customerAccount,
      _count: { idMaps: data.verificationSummary.dryRun.idMapSeedCount },
    }));

    await runControlPlaneClientMigrationDryRun(operatorActor, {
      sourceDeploymentId: "dep-source",
      targetMode: "hosted_dedicated",
      writesQuiesced: true,
      reason: "Move to hosted.",
    });

    const updateArg = prismaMock.clientMigrationRun.update.mock.calls[0]?.[0];
    expect(updateArg.data.verificationSummary.dryRun.inventory).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: expect.stringMatching(/^Practice/) }),
    ]));
    expect(updateArg.data.verificationSummary.dryRun.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "FinanceClient" }),
      expect.objectContaining({ entityType: "FinanceConsultant" }),
      expect.objectContaining({ entityType: "FinanceProject" }),
      expect.objectContaining({ entityType: "FinanceTimeEntry" }),
      expect.objectContaining({ entityType: "FinanceExpense" }),
      expect.objectContaining({ entityType: "FinanceContributionEntry" }),
    ]));
    expect(updateArg.data.verificationSummary.dryRun.idMapSeedCount).toBe(0);
  });

  it("keeps production migration dry-run disabled unless explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { runControlPlaneClientMigrationDryRun } = await import("./control-plane");

    await expect(runControlPlaneClientMigrationDryRun(operatorActor, {
      sourceDeploymentId: "dep-source",
      targetMode: "hosted_dedicated",
      reason: "Move to hosted.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_MIGRATION_DRY_RUN_DISABLED",
    });
    expect(prismaMock.clientMigrationRun.create).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.findUnique).not.toHaveBeenCalled();
  });

  it("records worker verification before migration execution can run", async () => {
    const { recordControlPlaneClientMigrationWorkerVerification } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "BOOTSTRAPPING",
    };
    const run = {
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "dry_run_passed",
      reason: "Move to hosted.",
      verificationSummary: {
        dryRun: {
          inventory: [
            { entityType: "Member", count: 2 },
            { entityType: "SupportOperation", count: 0 },
          ],
        },
      },
      customerAccount: { id: "acct_1", slug: "acme", displayName: "Acme" },
      sourceDeployment: {
        id: "dep-source",
        customerAccountId: "acct_1",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
      },
      destinationDeployment,
      _count: { idMaps: 0 },
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce(run);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);
    prismaMock.clientMigrationRun.update.mockResolvedValueOnce({
      ...run,
      status: "import_verified",
      verificationSummary: {
        previous: run.verificationSummary,
        worker: { verified: true },
      },
      _count: { idMaps: 2 },
    });

    const result = await recordControlPlaneClientMigrationWorkerVerification(operatorActor, {
      migrationRunId: "mig-1",
      verificationSummary: {
        verified: true,
        verificationSource: "control_plane_migration_worker",
        importJobId: "import-1",
        sourceChecksum: "checksum-1",
        destinationChecksum: "checksum-1",
        healthStatus: "ok",
        counts: {
          Member: { source: 2, destination: 2 },
          SupportOperation: { source: 0, destination: 0 },
        },
      },
      idMaps: [
        { entityType: "Member", sourceId: "member-1", destinationId: "member-a", checksum: "hash-1" },
        { entityType: "Member", sourceId: "member-2", destinationId: "member-b", checksum: "hash-2" },
      ],
      reason: "Worker import completed.",
    });

    expect(prismaMock.clientMigrationIdMap.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        migrationRunId_entityType_sourceId: {
          migrationRunId: "mig-1",
          entityType: "Member",
          sourceId: "member-1",
        },
      },
      update: expect.objectContaining({
        destinationId: "member-a",
        checksum: "hash-1",
      }),
    }));
    expect(prismaMock.clientMigrationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "import_verified",
        error: null,
      }),
    }));
    expect(result).toMatchObject({
      id: "mig-1",
      status: "import_verified",
      idMapCount: 2,
    });
  });

  it("queues migration worker verification without changing primary routing", async () => {
    const { CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE, enqueueControlPlaneClientMigrationWorkerVerification } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "BOOTSTRAPPING",
    };
    const run = {
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "dry_run_passed",
      reason: "Move to hosted.",
      verificationSummary: {
        dryRun: {
          inventory: [
            { entityType: "Member", count: 2 },
          ],
        },
      },
      customerAccount: { id: "acct_1", slug: "acme", displayName: "Acme", primaryDeploymentId: "dep-source" },
      sourceDeployment: {
        id: "dep-source",
        customerAccountId: "acct_1",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
      },
      destinationDeployment,
      _count: { idMaps: 0 },
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce(run);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-verify" });
    prismaMock.clientMigrationRun.update.mockResolvedValueOnce({
      ...run,
      status: "import_verification_queued",
      _count: { idMaps: 0 },
    });

    const result = await enqueueControlPlaneClientMigrationWorkerVerification(operatorActor, {
      migrationRunId: "mig-1",
      verificationSummary: {
        verified: true,
        verificationSource: "control_plane_migration_worker",
        importJobId: "import-1",
        sourceChecksum: "checksum-1",
        destinationChecksum: "checksum-1",
        healthStatus: "ok",
        counts: {
          Member: { source: 2, destination: 2 },
        },
      },
      idMaps: [
        { entityType: "Member", sourceId: "member-1", destinationId: "member-a", checksum: "hash-1" },
        { entityType: "Member", sourceId: "member-2", destinationId: "member-b", checksum: "hash-2" },
      ],
      reason: "Worker import completed.",
    });

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: null,
        type: CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE,
        payload: expect.objectContaining({
          migrationRunId: "mig-1",
          destinationDeploymentId: "dep-destination",
          reason: "Worker import completed.",
        }),
      }),
    }));
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      migration: {
        id: "mig-1",
        status: "import_verification_queued",
      },
      job: {
        id: "job-verify",
        type: CONTROL_PLANE_CLIENT_MIGRATION_VERIFY_JOB_TYPE,
      },
    });
  });

  it("runs queued migration worker verification from the workflow worker", async () => {
    const { runControlPlaneClientMigrationWorkerVerificationJob } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "BOOTSTRAPPING",
    };
    const run = {
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "import_verification_queued",
      reason: "Move to hosted.",
      verificationSummary: {
        dryRun: {
          inventory: [
            { entityType: "Member", count: 1 },
          ],
        },
      },
      customerAccount: { id: "acct_1", slug: "acme", displayName: "Acme" },
      sourceDeployment: {
        id: "dep-source",
        customerAccountId: "acct_1",
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
      },
      destinationDeployment,
      _count: { idMaps: 0 },
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce(run);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);
    prismaMock.clientMigrationRun.update.mockResolvedValueOnce({
      ...run,
      status: "import_verified",
      verificationSummary: {
        previous: run.verificationSummary,
        worker: { verified: true },
      },
      _count: { idMaps: 1 },
    });

    const result = await runControlPlaneClientMigrationWorkerVerificationJob({
      migrationRunId: "mig-1",
      destinationDeploymentId: "dep-destination",
      verificationSummary: {
        verified: true,
        verificationSource: "control_plane_migration_worker",
        importJobId: "import-1",
        sourceChecksum: "checksum-1",
        destinationChecksum: "checksum-1",
        healthStatus: "ok",
        counts: {
          Member: { source: 1, destination: 1 },
        },
      },
      idMaps: [
        { entityType: "Member", sourceId: "member-1", destinationId: "member-a", checksum: "hash-1" },
      ],
      reason: "Queued worker verification.",
    });

    expect(prismaMock.clientMigrationIdMap.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        migrationRunId_entityType_sourceId: {
          migrationRunId: "mig-1",
          entityType: "Member",
          sourceId: "member-1",
        },
      },
    }));
    expect(result).toMatchObject({
      id: "mig-1",
      status: "import_verified",
      idMapCount: 1,
    });
  });

  it("rejects migration destinations from another customer account", async () => {
    const { planControlPlaneClientMigration } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "dep-source",
        label: "Acme Shared",
        customerAccountId: "acct_1",
        customerAccount: { id: "acct_1" },
        deploymentKind: "SHARED_WORKSPACE",
        deploymentStatus: "ACTIVE",
        managedWorkspaceId: "ws-1",
      })
      .mockResolvedValueOnce({
        id: "dep-destination",
        customerAccountId: "acct_2",
        customerAccount: { id: "acct_2" },
        deploymentKind: "HOSTED_DEDICATED",
        deploymentStatus: "ACTIVE",
      });

    await expect(planControlPlaneClientMigration(operatorActor, {
      sourceDeploymentId: "dep-source",
      targetMode: "hosted_dedicated",
      destinationDeploymentId: "dep-destination",
      reason: "Move to hosted.",
    })).rejects.toMatchObject({
      code: "MIGRATION_DESTINATION_ACCOUNT_MISMATCH",
    });
    expect(prismaMock.clientMigrationRun.create).not.toHaveBeenCalled();
  });

  it("rejects hosted-source migration dry-run until remote inventory is available", async () => {
    const { runControlPlaneClientMigrationDryRun } = await import("./control-plane");
    const sourceDeployment = {
      id: "dep-hosted",
      label: "Acme Hosted",
      customerSlug: "acme",
      customerAccountId: "acct_1",
      customerAccount: { id: "acct_1" },
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      supportCredentialEnc: "encrypted-support-token",
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce(sourceDeployment)
      .mockResolvedValueOnce(sourceDeployment);
    prismaMock.clientMigrationRun.create.mockResolvedValue({
      id: "mig-hosted",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-hosted",
      destinationDeploymentId: null,
      direction: "hosted_to_shared",
      status: "planned",
      reason: "Move back to shared.",
      planSummary: {},
    });

    await expect(runControlPlaneClientMigrationDryRun(operatorActor, {
      sourceDeploymentId: "dep-hosted",
      targetMode: "shared_workspace",
      writesQuiesced: true,
      acceptRequiresReauth: true,
      reason: "Move back to shared.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MIGRATION_SOURCE_INVENTORY_UNAVAILABLE",
    });
    expect(prismaMock.clientMigrationRun.update).not.toHaveBeenCalled();
  });

  it("does not execute record-only migrations before the migration worker is available", async () => {
    const { executeControlPlaneClientMigration } = await import("./control-plane");

    await expect(executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Verified import.",
    })).rejects.toMatchObject({
      status: 501,
      code: "MIGRATION_EXECUTION_NOT_IMPLEMENTED",
    });
    expect(prismaMock.clientMigrationRun.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.clientMigrationRun.update).not.toHaveBeenCalled();
  });

  it("does not rollback or mutate routing before the migration worker is available", async () => {
    const { rollbackControlPlaneClientMigration } = await import("./control-plane");

    await expect(rollbackControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Rollback failed dry run.",
    })).rejects.toMatchObject({
      status: 501,
      code: "MIGRATION_EXECUTION_NOT_IMPLEMENTED",
    });
    expect(prismaMock.clientMigrationRun.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ primaryDeploymentId: "dep-source" }),
    }));
  });

  it("requires stored worker verification before gated migration execution mutates source state", async () => {
    vi.stubEnv("CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED", "true");
    vi.stubEnv("CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED", "true");
    const { executeControlPlaneClientMigration } = await import("./control-plane");
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "dry_run_passed",
      verificationSummary: {
        dryRun: {
          inventory: [{ entityType: "Member", count: 2 }],
        },
      },
      customerAccount: { id: "acct_1", primaryDeploymentId: "dep-source" },
      sourceDeployment: { id: "dep-source", customerAccountId: "acct_1" },
      destinationDeployment: { id: "dep-destination", customerAccountId: "acct_1" },
      _count: { idMaps: 0 },
    });

    await expect(executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Approved cutover.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MIGRATION_WORKER_VERIFICATION_REQUIRED",
    });
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("does not execute migrations when runtime source read-only enforcement is not enabled", async () => {
    vi.stubEnv("CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED", "true");
    const { executeControlPlaneClientMigration } = await import("./control-plane");

    await expect(executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Approved cutover.",
    })).rejects.toMatchObject({
      status: 501,
      code: "MIGRATION_READ_ONLY_ENFORCEMENT_REQUIRED",
    });
    expect(prismaMock.clientMigrationRun.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("rechecks destination readiness before migration execution cutover", async () => {
    vi.stubEnv("CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED", "true");
    vi.stubEnv("CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED", "true");
    const { executeControlPlaneClientMigration } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "BOOTSTRAPPING",
      lastHealthStatus: "ok",
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "import_verified",
      verificationSummary: { worker: { verified: true } },
      customerAccount: { id: "acct_1", primaryDeploymentId: "dep-source" },
      sourceDeployment: { id: "dep-source", customerAccountId: "acct_1" },
      destinationDeployment,
      _count: { idMaps: 1 },
    });
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);

    await expect(executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Approved cutover.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MIGRATION_DESTINATION_NOT_READY",
    });
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("rechecks hosted destination health before migration execution cutover", async () => {
    vi.stubEnv("CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED", "true");
    vi.stubEnv("CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED", "true");
    const { executeControlPlaneClientMigration } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "ACTIVE",
      lastHealthStatus: "degraded",
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce({
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "import_verified",
      verificationSummary: { worker: { verified: true } },
      customerAccount: { id: "acct_1", primaryDeploymentId: "dep-source" },
      sourceDeployment: { id: "dep-source", customerAccountId: "acct_1" },
      destinationDeployment,
      _count: { idMaps: 1 },
    });
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);

    await expect(executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Approved cutover.",
    })).rejects.toMatchObject({
      status: 400,
      code: "MIGRATION_DESTINATION_HEALTH_REQUIRED",
    });
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(prismaMock.customerAccount.update).not.toHaveBeenCalled();
  });

  it("gated migration execution cuts over primary routing and marks the source read-only before finalization", async () => {
    vi.stubEnv("CONTROL_PLANE_MIGRATION_EXECUTE_ENABLED", "true");
    vi.stubEnv("CONTROL_PLANE_MIGRATION_READ_ONLY_ENFORCED", "true");
    const { executeControlPlaneClientMigration } = await import("./control-plane");
    const destinationDeployment = {
      id: "dep-destination",
      customerAccountId: "acct_1",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "ACTIVE",
      lastHealthStatus: "ok",
    };
    const run = {
      id: "mig-1",
      customerAccountId: "acct_1",
      sourceDeploymentId: "dep-source",
      destinationDeploymentId: "dep-destination",
      direction: "shared_to_hosted",
      status: "import_verified",
      verificationSummary: {
        worker: {
          verified: true,
          evidence: {
            importJobId: "import-1",
            healthStatus: "ok",
          },
        },
      },
      customerAccount: { id: "acct_1", primaryDeploymentId: "dep-source" },
      sourceDeployment: { id: "dep-source", customerAccountId: "acct_1" },
      destinationDeployment,
      _count: { idMaps: 2 },
    };
    prismaMock.clientMigrationRun.findUnique.mockResolvedValueOnce(run);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(destinationDeployment);
    prismaMock.clientMigrationRun.update.mockResolvedValueOnce({
      ...run,
      status: "executed",
      executedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await executeControlPlaneClientMigration(operatorActor, {
      migrationRunId: "mig-1",
      reason: "Approved cutover.",
    });

    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith({
      where: { id: "dep-source" },
      data: {
        provisioningStatus: "read_only_pending_finalize",
      },
    });
    expect(prismaMock.customerAccount.update).toHaveBeenCalledWith({
      where: { id: "acct_1" },
      data: { primaryDeploymentId: "dep-destination" },
    });
    expect(result).toMatchObject({
      id: "mig-1",
      status: "executed",
    });
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
    const accountListArgs = prismaMock.customerAccount.findMany.mock.calls[0]?.[0] as any;
    expect(accountListArgs.include.primaryDeployment.include.supportOperations).toBeUndefined();
    expect(accountListArgs.include.primaryDeployment.include._count).toBeUndefined();
    expect(result[0]).toMatchObject({
      id: "inst-1",
      customerAccountId: "cust-1",
      hasSupportCredential: true,
      supportOperations: [],
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

  it("returns lean MCP-compatible customer summaries", async () => {
    const { listControlPlaneCustomerSummaries } = await import("./control-plane");
    const observedAt = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        primaryDeploymentId: "inst-1",
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([{
      id: "inst-1",
      label: "Acme",
      url: "https://acme.test",
      customDomain: "acme.example.com",
        customerSlug: "acme",
        customerAccountId: "cust-1",
        deploymentKind: "REMOTE_MANAGED",
        deploymentStatus: "ACTIVE",
        environment: "production",
        cloudProvider: "RAILWAY",
      providerProjectId: null,
      providerEnvironmentId: null,
      providerResourceGroup: null,
      providerLogsUrl: "https://portal.azure.com/logs",
      providerCostUrl: "https://portal.azure.com/costs",
      railwayProjectId: "railway-project-1",
      railwayEnvironmentId: "railway-env-1",
      railwayWebServiceId: "railway-web-1",
      railwayWorkerServiceId: "railway-worker-1",
      railwayPostgresServiceId: "railway-postgres-1",
      railwayRedisServiceId: "railway-redis-1",
      remoteWorkspaceSlug: "acme-remote",
      remoteWorkspaceId: "remote-ws-1",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncError: null,
      provisioningStatus: "active",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: observedAt,
      lastReleaseCheck: observedAt,
      releaseImageTag: "sha-1",
      releaseVersion: "main-2026-06-01",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme-workspace", name: "Acme Workspace" },
      createdAt: observedAt,
      updatedAt: observedAt,
    }] as any);

    const result = await listControlPlaneCustomerSummaries(operatorActor, {
      query: "acme",
      health: "ok",
      support: "connected",
      limit: 10,
    });

    expect(result).toEqual([{
      id: "inst-1",
      label: "Acme",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      primaryDeploymentId: "inst-1",
      url: "https://acme.test",
      customDomain: "acme.example.com",
      hasDeployment: true,
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      environment: "production",
      cloudProvider: "RAILWAY",
      providerLabel: "Railway",
      providerProjectId: "railway-project-1",
      providerEnvironmentId: "railway-env-1",
      providerResourceGroup: null,
      providerWebServiceId: "railway-web-1",
      providerWorkerServiceId: "railway-worker-1",
      providerLogsUrl: "https://portal.azure.com/logs",
      providerCostUrl: "https://portal.azure.com/costs",
      hasSupportCredential: true,
      supportConnectorStatus: "connected",
      supportConnectorLabel: "Managed workspace",
      supportConnectorDetail: "Managed workspace state is available locally.",
      supportAccessMode: "managed_workspace",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: observedAt,
      lastReleaseCheck: observedAt,
      releaseImageTag: "sha-1",
      releaseVersion: "main-2026-06-01",
      managedWorkspaceId: "ws-1",
      managedWorkspaceSlug: "acme-workspace",
      managedWorkspaceName: "Acme Workspace",
      remoteWorkspaceSlug: "acme-remote",
      remoteWorkspaceId: "remote-ws-1",
      provisioningStatus: "active",
      supportOperations: [],
    }]);
    expect(prismaMock.customerAccount.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        displayName: true,
        primaryDeploymentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(prismaMock.customerDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        deploymentKind: true,
        managedWorkspace: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      }),
    }));
    expect(prismaMock.customerDeployment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({
        fleetSnapshots: expect.anything(),
        supportOperations: expect.anything(),
      }),
    }));
  });

  it("returns a null deployment kind for account-only inventory rows", async () => {
    const { listControlPlaneCustomerSummaries } = await import("./control-plane");
    const observedAt = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([{
      id: "cust-pending",
      slug: "pending",
      displayName: "Pending",
      primaryDeploymentId: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([]);

    const result = await listControlPlaneCustomerSummaries(operatorActor);

    expect(result).toEqual([expect.objectContaining({
      id: "cust-pending",
      hasDeployment: false,
      deploymentKind: null,
    })]);
  });

  it("can include secondary deployments for validation target resolution", async () => {
    const { listControlPlaneCustomerSummaries } = await import("./control-plane");
    const older = new Date("2026-06-01T10:00:00.000Z");
    const newer = new Date("2026-06-02T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        primaryDeploymentId: "dep-primary",
        createdAt: older,
        updatedAt: newer,
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "dep-primary",
        label: "Acme Primary",
        url: "https://acme-primary.test",
        customDomain: null,
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentStatus: "ACTIVE",
      environment: "production",
      cloudProvider: "RAILWAY",
        remoteWorkspaceSlug: null,
        remoteWorkspaceId: null,
        supportCredentialEnc: null,
        supportConnectorStatus: "connected",
        supportLastSyncError: null,
        provisioningStatus: "active",
        lastHealthStatus: "ok",
        lastHealthError: null,
        lastHealthCheck: older,
        lastReleaseCheck: older,
        releaseImageTag: "sha-primary",
        releaseVersion: "main-primary",
        managedWorkspaceId: null,
        managedWorkspace: null,
        createdAt: older,
        updatedAt: older,
      },
      {
        id: "dep-secondary",
        label: "Acme Secondary",
        url: "https://acme-secondary.test",
        customDomain: "secondary.acme.test",
        customerSlug: "acme-secondary",
        customerAccountId: "cust-1",
        deploymentStatus: "ACTIVE",
        environment: "production",
        cloudProvider: "RAILWAY",
        remoteWorkspaceSlug: "acme-secondary-remote",
        remoteWorkspaceId: "remote-secondary",
        supportCredentialEnc: null,
        supportConnectorStatus: "connected",
        supportLastSyncError: null,
        provisioningStatus: "active",
        lastHealthStatus: "ok",
        lastHealthError: null,
        lastHealthCheck: newer,
        lastReleaseCheck: newer,
        releaseImageTag: "sha-secondary",
        releaseVersion: "main-secondary",
        managedWorkspaceId: "ws-secondary",
        managedWorkspace: { id: "ws-secondary", slug: "secondary-workspace", name: "Secondary Workspace" },
        createdAt: newer,
        updatedAt: newer,
      },
    ] as any);

    const result = await listControlPlaneCustomerSummaries(operatorActor, {
      includeAllDeployments: true,
      uncapped: true,
      limit: 1,
    });

    expect(result.map((row) => row.id)).toEqual(["dep-secondary", "dep-primary"]);
    expect(result[0]).toMatchObject({
      customerAccountId: "cust-1",
      primaryDeploymentId: "dep-primary",
      deploymentStatus: "ACTIVE",
      environment: "production",
      customDomain: "secondary.acme.test",
      managedWorkspaceSlug: "secondary-workspace",
      managedWorkspaceName: "Secondary Workspace",
      remoteWorkspaceSlug: "acme-secondary-remote",
      remoteWorkspaceId: "remote-secondary",
    });
  });

  it("returns a compact deployment detail overview without heavy logs", async () => {
    const { getControlPlaneDeployment } = await import("./control-plane");
    const observedAt = new Date("2026-06-29T18:00:00.000Z");
    const hugeSummary = { payload: "x".repeat(1_100_000) };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Enterprise Alpha Production",
      url: "https://enterprise-alpha.example.com",
      customerSlug: "enterprise-alpha",
      customerAccountId: "cust-1",
      supportCredentialEnc: "encrypted:support-token",
      accessGrants: [],
      customerAccount: null,
      managedWorkspace: null,
      fleetSnapshots: [
        {
          id: "snapshot-1",
          snapshotKind: "SUPPORT_READY",
          status: "ok",
          error: null,
          summary: hugeSummary,
          observedAt,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
        {
          id: "snapshot-duplicate",
          snapshotKind: "SUPPORT_READY",
          status: "ok",
          error: null,
          summary: { duplicate: true },
          observedAt,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
        {
          id: "snapshot-health",
          snapshotKind: "HEALTH",
          status: "ok",
          error: null,
          summary: { status: "ok" },
          observedAt,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      ],
      supportOperations: [{
        id: "operation-1",
        resultSummary: { payload: "y".repeat(3_000_000) },
      }],
      events: [{
        id: "event-1",
        meta: { payload: "z".repeat(100_000) },
      }],
    } as any);

    const result = await getControlPlaneDeployment(operatorActor, "inst-1") as any;
    const args = prismaMock.customerDeployment.findUnique.mock.calls[0]?.[0] as any;

    expect(args.include.supportOperations).toBeUndefined();
    expect(args.include.events).toBeUndefined();
    expect(result.hasSupportCredential).toBe(true);
    expect(result.supportCredentialEnc).toBeUndefined();
    expect(result.supportOperations).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.fleetSnapshots).toHaveLength(2);
    expect(result.fleetSnapshots[0].summary).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
      preview: expect.any(String),
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(250_000);
  });

  it("lists support operations with truncated summary previews", async () => {
    const { listControlPlaneSupportOperations } = await import("./control-plane");
    const observedAt = new Date("2026-06-29T18:00:00.000Z");
    prismaMock.supportOperation.findMany.mockResolvedValueOnce([{
      id: "operation-1",
      deploymentId: "inst-1",
      workspaceId: "ws-1",
      actorUserId: "operator-1",
      actorLabel: "Corgtex Support",
      action: "agents.list_runs",
      reason: "Inspect recent agent runs.",
      status: "COMPLETED",
      inputSummary: { filter: "recent" },
      resultSummary: { runs: "x".repeat(1_000_000) },
      error: null,
      idempotencyKey: null,
      startedAt: observedAt,
      completedAt: observedAt,
      createdAt: observedAt,
      updatedAt: observedAt,
    } as any]);

    const operations = await listControlPlaneSupportOperations(operatorActor, "inst-1");
    const args = prismaMock.supportOperation.findMany.mock.calls[0]?.[0] as any;

    expect(args).toMatchObject({
      where: { deploymentId: "inst-1" },
      take: 30,
      select: expect.objectContaining({
        resultSummary: true,
        inputSummary: true,
      }),
    });
    expect(operations[0]).toMatchObject({
      action: "agents.list_runs",
      resultSummary: {
        truncated: true,
        originalBytes: expect.any(Number),
        preview: expect.any(String),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(operations), "utf8")).toBeLessThan(20_000);
  });

  it("lists Azure self-serve support sessions as ready without requiring an enterprise connector", async () => {
    const { listControlPlaneCustomerSummaries } = await import("./control-plane");
    const observedAt = new Date("2026-06-10T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValueOnce([
      {
        id: "cust-selfserve",
        slug: "corgtex-selfserve-production",
        displayName: "Corgtex Azure Self-Serve Production",
        primaryDeploymentId: "selfserve-1",
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([{
      id: "selfserve-1",
      label: "Corgtex Azure Self-Serve Production",
      url: "https://selfserve.corgtex.com",
      customerSlug: "corgtex-selfserve-production",
      customerAccountId: "cust-selfserve",
      deploymentStatus: "ACTIVE",
      cloudProvider: "AZURE",
      providerProjectId: "ca-corgtex-ss-prod-web",
      providerEnvironmentId: "cae-corgtex-ss-prod",
      providerResourceGroup: "rg-corgtex-selfserve-production-wus3",
      providerLogsUrl: "https://portal.azure.com/logs",
      providerCostUrl: "https://portal.azure.com/costs",
      providerWebServiceId: "ca-corgtex-ss-prod-web",
      providerWorkerServiceId: "ca-corgtex-ss-prod-worker",
      providerPostgresServiceId: "pg-corgtex-ss-prod",
      providerRedisServiceId: "redis-corgtex-ss-prod",
      providerStorageResourceId: "storage-corgtex-ss-prod",
      railwayProjectId: null,
      railwayEnvironmentId: null,
      railwayWebServiceId: null,
      railwayWorkerServiceId: null,
      railwayPostgresServiceId: null,
      railwayRedisServiceId: null,
      remoteWorkspaceSlug: null,
      supportCredentialEnc: null,
      supportConnectorStatus: "not_configured",
      supportLastSyncError: null,
      provisioningStatus: "active",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: observedAt,
      lastReleaseCheck: observedAt,
      releaseImageTag: "sha-bdd9c12",
      releaseVersion: "main-20260611T0249Z",
      managedWorkspaceId: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }] as any);

    const result = await listControlPlaneCustomerSummaries(operatorActor, {
      query: "selfserve",
      health: "ok",
      support: "ready",
      limit: 10,
    });

    expect(result).toEqual([expect.objectContaining({
      id: "selfserve-1",
      cloudProvider: "AZURE",
      providerWebServiceId: "ca-corgtex-ss-prod-web",
      providerWorkerServiceId: "ca-corgtex-ss-prod-worker",
      hasSupportCredential: false,
      supportConnectorStatus: "ready",
      supportConnectorLabel: "Self-serve support sessions",
      supportConnectorDetail: "Audited self-serve support sessions and provider read-model inspection are available.",
      supportAccessMode: "self_serve_sessions",
    })]);
  });

  it("returns a read-only Azure provider status from stored control-plane facts", async () => {
    const { getControlPlaneProviderStatus } = await import("./control-plane");
    const observedAt = new Date("2026-06-09T12:00:00.000Z");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "dep-azure",
      label: "Azure Self Serve",
      url: "https://selfserve.corgtex.com",
      customerSlug: "selfserve",
      customerAccountId: "acct_azure",
      deploymentKind: "HOSTED_DEDICATED",
      deploymentStatus: "ACTIVE",
      cloudProvider: "AZURE",
      provisioningStatus: "active",
      bootstrapStatus: "completed",
      releaseVersion: "main-2026-06-09",
      releaseImageTag: "sha-azure",
      lastHealthStatus: "ok",
      lastHealthError: null,
      lastHealthCheck: observedAt,
      lastWorkerHealthStatus: "ok",
      lastWorkerHealthCheck: observedAt,
      lastReleaseCheck: observedAt,
      providerSubscriptionId: "sub-1",
      providerResourceGroup: "rg-corgtex-selfserve-staging",
      providerEnvironmentId: "aca-env-1",
      providerWebServiceId: "web-app",
      providerWorkerServiceId: "worker-app",
      providerPostgresServiceId: "pg-flex",
      providerRedisServiceId: "redis-cache",
      providerStorageResourceId: "storage-account",
      providerLogsUrl: "https://portal.azure.com/logs",
      providerCostUrl: "https://portal.azure.com/costs",
      providerMetadata: {
        azure: {
          costSummary: {
            currentMonthUsd: "12.34",
            secretToken: "do-not-return",
          },
        },
      },
      supportCredentialEnc: null,
      supportMcpUrl: null,
      supportConnectorStatus: "not_configured",
      managedWorkspaceId: null,
      managedWorkspace: null,
    } as any);
    prismaMock.fleetHealthSnapshot.findMany.mockResolvedValueOnce([
      {
        id: "snap-health",
        snapshotKind: "HEALTH",
        status: "ok",
        summary: { health: { database: "up", secretToken: "hidden" } },
        error: null,
        observedAt,
        createdAt: observedAt,
      },
      {
        id: "snap-release",
        snapshotKind: "RELEASE",
        status: "ok",
        summary: { observedRelease: { imageTag: "sha-azure" } },
        error: null,
        observedAt,
        createdAt: observedAt,
      },
    ] as any);
    prismaMock.selfServeSmokeRun.findFirst.mockResolvedValueOnce({
      runId: "smoke-1",
      runKind: "browser",
      status: "PASSED",
      baseUrl: "https://selfserve.corgtex.com",
      siteUrl: "https://www.corgtex.com",
      summary: {
        email: "private-admin@example.com",
        steps: [{ name: "signup", status: "PASSED", token: "hidden" }],
        warnings: [{ name: "budget", status: "WARN", token: "hidden" }],
      },
      error: null,
      startedAt: observedAt,
      completedAt: observedAt,
      createdAt: observedAt,
    });
    prismaMock.customerDeploymentEvent.findFirst.mockResolvedValueOnce({
      id: "event-1",
      meta: {
        sourceId: "azure-selfserve",
        sourceUrl: "https://selfserve.corgtex.com",
        sourceDeploymentId: "dep-azure",
        summary: { total: 1, activeTrials: 1 },
        items: [{ trialId: "trial-private", adminEmail: "private-admin@example.com" }],
        receivedAt: "2026-06-09T12:01:00.000Z",
      },
      createdAt: observedAt,
    });

    const result = await getControlPlaneProviderStatus(operatorActor, "dep-azure");

    expect(result).toMatchObject({
      deploymentId: "dep-azure",
      adapter: {
        kind: "azure_read_model",
        readOnly: true,
        canReadProviderStatus: true,
      },
      provider: {
        cloudProvider: "AZURE",
        providerLabel: "Azure",
        resourceGroup: "rg-corgtex-selfserve-staging",
        webServiceId: "web-app",
      },
      health: {
        status: "ok",
        latestSnapshot: { id: "snap-health", status: "ok" },
      },
      release: {
        releaseImageTag: "sha-azure",
        latestSnapshot: { id: "snap-release", status: "ok" },
      },
      logs: {
        url: "https://portal.azure.com/logs",
        available: true,
      },
      smoke: {
        status: "PASSED",
        runId: "smoke-1",
        summary: {
          steps: [{ name: "signup", status: "PASSED" }],
          warnings: [{ name: "budget", status: "WARN" }],
        },
      },
      cost: {
        url: "https://portal.azure.com/costs",
        available: true,
        source: "provider_metadata",
        summary: {
          currentMonthUsd: "12.34",
          secretToken: "[redacted]",
        },
      },
      registrySync: {
        eventId: "event-1",
        sourceId: "azure-selfserve",
        itemCount: 1,
        summary: { total: 1, activeTrials: 1 },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-admin@example.com");
    expect(serialized).not.toContain("do-not-return");
    expect(serialized).not.toContain("hidden");
    expect(prismaMock.customerDeployment.update).not.toHaveBeenCalled();
    expect(prismaMock.customerDeploymentEvent.create).not.toHaveBeenCalled();
  });

  it("rejects Azure provider status reads for non-Azure deployments", async () => {
    const { getControlPlaneProviderStatus } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "dep-railway",
      cloudProvider: "RAILWAY",
      railwayProjectId: "project-1",
      railwayEnvironmentId: "env-1",
      supportCredentialEnc: null,
      managedWorkspaceId: null,
      managedWorkspace: null,
    } as any);

    await expect(getControlPlaneProviderStatus(operatorActor, "dep-railway")).rejects.toMatchObject({
      status: 400,
      code: "AZURE_PROVIDER_REQUIRED",
    });
    expect(prismaMock.fleetHealthSnapshot.findMany).not.toHaveBeenCalled();
    expect(prismaMock.selfServeSmokeRun.findFirst).not.toHaveBeenCalled();
  });

  it("builds client switcher options and wide local fleet overview rows without impersonation state", async () => {
    const { getControlPlaneClientOptions, getControlPlaneFleetOverview } = await import("./control-plane");
    const observedAt = new Date("2026-06-01T10:00:00.000Z");
    vi.stubEnv("MEETING_RECORDER_PUBLIC_BASE_URL", "https://recorder.test");
    vi.stubEnv("RECALL_API_KEY", "recall-token");
    vi.stubEnv("RECALL_WEBHOOK_SECRET", "recall-secret");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "owner@corgtex.com",
        notes: null,
        primaryDeploymentId: "inst-1",
        createdAt: observedAt,
        updatedAt: observedAt,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "inst-1",
          label: "Acme",
          url: "https://acme.test",
          customerSlug: "acme",
          customerAccountId: "cust-1",
          supportOwnerEmail: "owner@corgtex.com",
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          lastHealthError: null,
          releaseImageTag: "web:2026.06.01",
          releaseVersion: "2026.06.01",
          supportConnectorStatus: "connected",
          supportCredentialEnc: null,
          managedWorkspaceId: "ws-1",
          managedWorkspace: {
            id: "ws-1",
            slug: "acme",
            name: "Acme",
            _count: {
              members: 7,
              externalDataSources: 2,
              brainArticles: 12,
              brainSources: 1,
              agentRuns: 5,
              workflowJobs: 7,
              communicationInstallations: 1,
              meetingRecordings: 3,
            },
          },
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      },
      {
        id: "cust-2",
        slug: "future-co",
        displayName: "Future Co",
        status: "ONBOARDING",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: null,
        createdAt: observedAt,
        updatedAt: observedAt,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: null,
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([
      {
        id: "remote-1",
        label: "Remote Co",
        url: "https://remote.test",
        customerSlug: "remote-co",
        customerAccountId: null,
        supportOwnerEmail: null,
        provisioningStatus: "active",
        lastHealthStatus: null,
        lastHealthError: "Release drift: web image is behind target.",
        releaseImageTag: "web:old",
        releaseVersion: null,
        supportConnectorStatus: "not_configured",
        supportCredentialEnc: null,
        managedWorkspaceId: null,
        managedWorkspace: null,
        supportOperations: [],
        fleetSnapshots: [
          {
            snapshotKind: "HEALTH",
            status: "degraded",
            observedAt,
            createdAt: observedAt,
            summary: null,
            error: null,
          },
        ],
        _count: { supportOperations: 0, events: 0 },
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ] as any);
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue([{ workspaceId: "ws-1" }, { workspaceId: "ws-1" }]);
    prismaMock.agentCredential.findMany.mockResolvedValue([{ workspaceId: "ws-1" }]);
    prismaMock.appInstallation.findMany.mockResolvedValue([{ workspaceId: "ws-1" }]);
    prismaMock.communicationInstallation.findMany.mockResolvedValue([{ workspaceId: "ws-1" }]);
    prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
      workspaceId: "ws-1",
      enabled: true,
      autoRecordEnabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      monthlyMinuteCap: 6000,
      updatedAt: observedAt,
    }]);
    prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([{
      workspaceId: "ws-1",
      providerAccountId: "calendar-1",
      providerAccountEmail: "calendar@acme.test",
      status: "ACTIVE",
      lastSyncAt: new Date("2026-06-01T09:00:00.000Z"),
      lastSyncError: null,
      updatedAt: observedAt,
    }]);
    prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([{
      workspaceId: "ws-1",
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 55 * 60 * 1000),
    }]);
    prismaMock.workflowJob.findMany.mockResolvedValue([]);
    prismaMock.meetingRecording.groupBy
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _sum: { durationSeconds: 3600 } }])
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _count: { _all: 2 } }]);

    const options = await getControlPlaneClientOptions(operatorActor);
    const matrix = await getControlPlaneFleetOverview(operatorActor, { pageSize: 25 });

    expect(options.map((option) => option.id)).toEqual(["inst-1", "remote-1"]);
    expect(options.find((option) => option.id === "future-co")).toBeUndefined();
    expect(matrix.cacheMeta).toMatchObject({
      source: "local",
      liveRefreshRequired: true,
    });
    expect(matrix.items).toHaveLength(3);
    expect(matrix.items.find((row) => row.id === "inst-1")).toMatchObject({
      recorder: {
        status: "ready",
        availability: { status: "available" },
        provider: "RECALL_AI",
        monthlyUsageMinutes: 60,
        failureCount: 2,
      },
      agents: { status: "active", runCount: 5 },
      tools: {
        status: "active",
        total: 6,
        toolLinks: 2,
        agentCredentials: 1,
        enterpriseApps: 1,
        communicationIntegrations: 1,
        enabledToolFlags: 1,
      },
      lastCheckedAt: observedAt,
      users: { status: "managed", count: 7 },
      support: { mode: "managed" },
    });
    expect(matrix.items.find((row) => row.id === "remote-1")).toMatchObject({
      release: { status: "drift" },
      recorder: { status: "requires_connector", availability: { status: "requires_connector" } },
      agents: { status: "requires_connector" },
      tools: { status: "available", total: null, detail: "Remote enterprise tool inventory is not mirrored locally." },
      users: { status: "requires_connector" },
    });
    expect(matrix.items.find((row) => row.id === "remote-1")?.issues.map((issue) => issue.source)).toContain("release");

    prismaMock.meetingRecording.groupBy
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _sum: { durationSeconds: 3600 } }])
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _count: { _all: 2 } }]);
    const filteredMatrix = await getControlPlaneFleetOverview(operatorActor, {
      query: "remote",
      health: ["degraded", "down"],
      support: ["requires_connector", "degraded"],
      issues: "1",
      pageSize: 25,
    });
    expect(filteredMatrix.total).toBe(1);
    expect(filteredMatrix.items.map((row) => row.id)).toEqual(["remote-1"]);
    expect(filteredMatrix.filters.health).toEqual(["degraded", "down"]);
    expect(filteredMatrix.filters.support).toEqual(["requires_connector", "degraded"]);

    prismaMock.meetingRecording.groupBy
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _sum: { durationSeconds: 3600 } }])
      .mockResolvedValueOnce([{ workspaceId: "ws-1", _count: { _all: 2 } }]);
    const remoteMissingToolsMatrix = await getControlPlaneFleetOverview(operatorActor, {
      query: "remote",
      missingTools: "1",
      pageSize: 25,
    });
    expect(remoteMissingToolsMatrix.total).toBe(0);
  });

  it("shows Azure self-serve support sessions as ready without an enterprise connector", async () => {
    const { listControlPlaneMatrix } = await import("./control-plane");
    const observedAt = new Date("2026-06-10T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-selfserve",
        slug: "selfserve",
        displayName: "Corgtex Self-Serve",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "support@corgtex.com",
        notes: null,
        primaryDeploymentId: "selfserve-1",
        createdAt: observedAt,
        updatedAt: observedAt,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "selfserve-1",
          label: "Corgtex Self-Serve",
          url: "https://selfserve.corgtex.com",
          customerSlug: "selfserve",
          customerAccountId: "cust-selfserve",
          cloudProvider: "AZURE",
          supportOwnerEmail: "support@corgtex.com",
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          lastHealthCheck: observedAt,
          lastHealthError: null,
          releaseImageTag: "sha-new",
          releaseVersion: "2026.06.10",
          supportConnectorStatus: "not_configured",
          supportCredentialEnc: null,
          supportLastSyncError: null,
          managedWorkspaceId: null,
          managedWorkspace: null,
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);

    const matrix = await listControlPlaneMatrix(operatorActor, {});
    const row = matrix.items.find((item) => item.id === "selfserve-1");

    expect(row).toMatchObject({
      support: {
        status: "ready",
        mode: "remote",
        detail: "Azure self-serve uses audited support sessions and provider read-model inspection.",
      },
    });
    expect(row?.issues.map((issue) => issue.source)).not.toContain("support");
  });

  it("builds a 100-client local fleet overview without remote connector calls", async () => {
    const { getControlPlaneFleetOverview } = await import("./control-plane");
    const observedAt = new Date("2026-06-01T10:00:00.000Z");
    const customers = Array.from({ length: 100 }, (_, index) => {
      const number = index + 1;
      const id = `cust-${number}`;
      const deploymentId = `dep-${number}`;
      const workspaceId = `ws-${number}`;
      return {
        id,
        slug: `client-${number}`,
        displayName: `Client ${number}`,
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "ops@corgtex.com",
        notes: null,
        primaryDeploymentId: deploymentId,
        createdAt: observedAt,
        updatedAt: observedAt,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: deploymentId,
          label: `Client ${number}`,
          url: `https://client-${number}.test`,
          customerSlug: `client-${number}`,
          customerAccountId: id,
          supportOwnerEmail: "ops@corgtex.com",
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          lastHealthCheck: observedAt,
          lastHealthError: null,
          releaseImageTag: "web:2026.06.01",
          releaseVersion: "2026.06.01",
          supportConnectorStatus: "connected",
          supportCredentialEnc: null,
          managedWorkspaceId: workspaceId,
          managedWorkspace: {
            id: workspaceId,
            slug: `client-${number}`,
            name: `Client ${number}`,
            _count: {
              members: 3,
              externalDataSources: 1,
              brainArticles: 2,
              brainSources: 1,
              agentRuns: 2,
              workflowJobs: 1,
              communicationInstallations: 1,
              meetingRecordings: 0,
            },
          },
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      };
    });
    prismaMock.customerAccount.findMany.mockResolvedValue(customers as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.workspaceToolLink.findMany.mockResolvedValue(
      customers.map((customer) => ({ workspaceId: customer.primaryDeployment.managedWorkspaceId })),
    );

    const startedAt = performance.now();
    const overview = await getControlPlaneFleetOverview(operatorActor, { pageSize: 100 });
    const durationMs = performance.now() - startedAt;

    expect(overview.items).toHaveLength(100);
    expect(overview.items.every((row) => row.tools.status === "active")).toBe(true);
    expect(durationMs).toBeLessThan(1_000);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prismaMock.workspaceToolLink.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.agentCredential.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.appInstallation.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.communicationInstallation.findMany).toHaveBeenCalledTimes(1);
  });

  it("marks disabled recorders when entitlement is off", async () => {
    const { listControlPlaneRecorderMatrix } = await import("./control-plane");
    const now = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: "inst-1",
        createdAt: now,
        updatedAt: now,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "inst-1",
          label: "Acme",
          url: "https://acme.test",
          customerSlug: "acme",
          supportOwnerEmail: null,
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          releaseImageTag: "web:latest",
          releaseVersion: null,
          supportConnectorStatus: "connected",
          supportCredentialEnc: null,
          managedWorkspaceId: "ws-1",
          managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 2, agentRuns: 0 } },
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: now,
          updatedAt: now,
        },
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: false }]);
    prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
      workspaceId: "ws-1",
      enabled: false,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      monthlyMinuteCap: 3000,
      updatedAt: now,
    }]);

    const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "disabled" });

    expect(matrix.items).toHaveLength(1);
    expect(matrix.items[0]).toMatchObject({
      deploymentId: "inst-1",
      status: "disabled",
      availability: { status: "disabled" },
      entitlementEnabled: false,
      configured: true,
      monthlyMinuteCap: 3000,
    });
  });

  function managedRecorderMatrixCustomer(now: Date) {
    return [{
      id: "cust-1",
      slug: "acme",
      displayName: "Acme",
      supportOwnerEmail: null,
      notes: null,
      primaryDeploymentId: "inst-1",
      createdAt: now,
      updatedAt: now,
      fleetSnapshots: [],
      deployments: [],
      primaryDeployment: {
        id: "inst-1",
        label: "Acme",
        url: "https://acme.test",
        customerSlug: "acme",
        supportOwnerEmail: null,
        provisioningStatus: "active",
        lastHealthStatus: "ok",
        releaseImageTag: "web:latest",
        releaseVersion: null,
        supportConnectorStatus: "connected",
        supportCredentialEnc: null,
        managedWorkspaceId: "ws-1",
        managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 2, agentRuns: 0 } },
        supportOperations: [],
        fleetSnapshots: [],
        _count: { supportOperations: 0, events: 0 },
        createdAt: now,
        updatedAt: now,
      },
    }] as any;
  }

  it("marks managed recorder matrix ready from an eligible Corgtex scheduled meeting without calendar sync", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      const meetingAt = new Date("2026-06-02T16:00:00.000Z");
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
        updatedAt: now,
      }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
	      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([{
	        workspaceId: "ws-1",
	        status: "COMPLETED",
	        createdAt: now,
	        completedAt: now,
	      }]);
      prismaMock.meeting.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        recordedAt: meetingAt,
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        series: null,
        recordings: [],
      }]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "ready" });

      expect(matrix.items).toHaveLength(1);
      expect(matrix.items[0]).toMatchObject({
        deploymentId: "inst-1",
        status: "ready",
        readiness: {
          ready: true,
          detail: "Recorder readiness checks are passing.",
        },
        calendarSource: null,
      });
      expect(matrix.items[0].readiness.failedChecks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks managed recorder matrix ready from already-covered Corgtex meetings without smoke proof", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      const meetingAt = new Date("2026-06-01T10:05:00.000Z");
      const meetingUrl = "https://meet.google.com/abc-defg-hij";
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: false,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
        updatedAt: now,
      }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([]);
      prismaMock.meetingRecording.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        status: "SCHEDULED",
        scheduledAt: new Date("2026-06-01T09:55:00.000Z"),
        joinAt: meetingAt,
        startedAt: null,
        endedAt: null,
        createdAt: new Date("2026-06-01T09:55:00.000Z"),
      }]);
      prismaMock.meeting.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        recordedAt: meetingAt,
        meetingUrl,
        series: null,
        recordings: [{
          status: "SCHEDULED",
          meetingUrl,
          failureCode: null,
        }],
      }]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "ready" });

      expect(matrix.items).toHaveLength(1);
      expect(matrix.items[0]).toMatchObject({
        deploymentId: "inst-1",
        status: "ready",
        readiness: {
          ready: true,
          detail: "Recorder readiness checks are passing.",
        },
        lastSmokeRun: null,
      });
      expect(matrix.items[0].readiness.failedChecks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks managed recorder matrix ready from recent joining provider updates without startedAt", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      const meetingAt = new Date("2026-06-01T10:30:00.000Z");
      const meetingUrl = "https://meet.google.com/abc-defg-hij";
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
        updatedAt: now,
      }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([]);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{
          workspaceId: "ws-1",
          status: "JOINING",
          scheduledAt: new Date("2026-06-01T09:40:00.000Z"),
          joinAt: new Date("2026-06-01T09:45:00.000Z"),
          startedAt: null,
          endedAt: null,
          createdAt: new Date("2026-06-01T09:40:00.000Z"),
          updatedAt: new Date("2026-06-01T10:02:00.000Z"),
        }])
        .mockResolvedValueOnce([{
          workspaceId: "ws-1",
          failureCode: "vendor_http_error",
          failureMessage: "RECALL_AI returned 401: authentication_failed Invalid API token for region.",
          updatedAt: new Date("2026-06-01T09:55:00.000Z"),
        }]);
      prismaMock.meeting.findMany.mockResolvedValue([{ workspaceId: "ws-1", recordedAt: meetingAt, meetingUrl, series: null, recordings: [] }]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "ready" });

      expect(matrix.items).toHaveLength(1);
      expect(matrix.items[0].readiness.failedChecks).toEqual([]);
      expect(prismaMock.meetingRecording.findMany.mock.calls[0]?.[0]?.where.OR).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "JOINING",
          externalBotId: { not: null },
          OR: expect.arrayContaining([
            { updatedAt: { gte: new Date("2026-05-02T10:00:00.000Z") } },
          ]),
        }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use incomplete completed smoke rows as matrix provider proof", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      const meetingAt = new Date("2026-06-01T10:30:00.000Z");
      const meetingUrl = "https://meet.google.com/abc-defg-hij";
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
        updatedAt: now,
      }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        status: "COMPLETED",
        createdAt: now,
        completedAt: null,
      }]);
      prismaMock.meetingRecording.findMany.mockResolvedValue([]);
      prismaMock.meeting.findMany.mockResolvedValue([{ workspaceId: "ws-1", recordedAt: meetingAt, meetingUrl, series: null, recordings: [] }]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "needs_setup" });

      expect(matrix.items[0].readiness.failedChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "provider_proof" }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks managed recorder matrix proof when auth failure is newer than scheduled bot proof", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      const meetingAt = new Date("2026-06-01T10:30:00.000Z");
      const meetingUrl = "https://meet.google.com/abc-defg-hij";
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
        updatedAt: now,
      }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([]);
      prismaMock.meetingRecording.findMany
        .mockResolvedValueOnce([{ workspaceId: "ws-1", status: "SCHEDULED", scheduledAt: new Date("2026-06-01T09:55:00.000Z"), joinAt: meetingAt, startedAt: null, endedAt: null, createdAt: new Date("2026-06-01T09:55:00.000Z") }])
        .mockResolvedValueOnce([{ workspaceId: "ws-1", failureCode: "vendor_http_error", failureMessage: "RECALL_AI returned 401: authentication_failed Invalid API token for region.", updatedAt: new Date("2026-06-01T10:05:00.000Z") }]);
      prismaMock.meeting.findMany.mockResolvedValue([{ workspaceId: "ws-1", recordedAt: meetingAt, meetingUrl, series: null, recordings: [{ status: "SCHEDULED", meetingUrl, failureCode: null }] }]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "needs_setup" });

      expect(matrix.items[0].readiness.failedChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "provider_proof", detail: "Recall authentication failed; verify the configured API token and region." }),
      ]));
      expect(prismaMock.meetingRecording.findMany.mock.calls[1]?.[0]?.where).toMatchObject({
        status: "FAILED",
        updatedAt: { gte: new Date("2026-05-02T10:00:00.000Z") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps recorder matrix schedule blocked when only meetings after the first 100 are eligible", async () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { listControlPlaneRecorderMatrix } = await import("./control-plane");
      prismaMock.customerAccount.findMany.mockResolvedValue(managedRecorderMatrixCustomer(now));
      prismaMock.customerDeployment.findMany.mockResolvedValue([]);
      prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
      prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true, autoRecordEnabled: true, defaultProvider: "RECALL_AI", fallbackProvider: null, monthlyMinuteCap: 6000, updatedAt: now }]);
      prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
      prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([{ workspaceId: "ws-1", status: "COMPLETED", createdAt: now, completedAt: now }]);
      prismaMock.meeting.findMany.mockResolvedValue([
        ...Array.from({ length: 100 }, (_, index) => ({ workspaceId: "ws-1", recordedAt: new Date(now.getTime() + (index + 1) * 60 * 60 * 1000), meetingUrl: null, series: null, recordings: [] })),
        { workspaceId: "ws-1", recordedAt: new Date(now.getTime() + 101 * 60 * 60 * 1000), meetingUrl: "https://meet.google.com/abc-defg-hij", series: null, recordings: [] },
      ]);

      const matrix = await listControlPlaneRecorderMatrix(operatorActor, { status: "needs_setup" });

      expect(matrix.items[0].readiness.failedChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "recording_schedule" }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters recorder matrix by client and surfaces readiness failures and missing remote data", async () => {
    const { listControlPlaneRecorderMatrix } = await import("./control-plane");
    const now = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-1",
        slug: "acme",
        displayName: "Acme",
        supportOwnerEmail: null,
        notes: null,
        primaryDeploymentId: "inst-1",
        createdAt: now,
        updatedAt: now,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "inst-1",
          label: "Acme",
          url: "https://acme.test",
          customerSlug: "acme",
          supportOwnerEmail: null,
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          releaseImageTag: "web:latest",
          releaseVersion: null,
          supportConnectorStatus: "connected",
          supportCredentialEnc: null,
          managedWorkspaceId: "ws-1",
          managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 2, agentRuns: 0 } },
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: now,
          updatedAt: now,
        },
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([
      {
        id: "remote-1",
        label: "Remote Co",
        url: "https://remote.test",
        customerSlug: "remote-co",
        supportOwnerEmail: null,
        provisioningStatus: "active",
        lastHealthStatus: "ok",
        releaseImageTag: "web:latest",
        releaseVersion: null,
        supportConnectorStatus: "connected",
        supportCredentialEnc: "encrypted-token",
        managedWorkspaceId: null,
        managedWorkspace: null,
        supportOperations: [],
        fleetSnapshots: [],
        _count: { supportOperations: 0, events: 0 },
        createdAt: now,
        updatedAt: now,
      },
    ] as any);
    prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([{ workspaceId: "ws-1", enabled: true }]);
    prismaMock.workspaceMeetingRecorderConfig.findMany.mockResolvedValue([{
      workspaceId: "ws-1",
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      monthlyMinuteCap: 6000,
      updatedAt: now,
    }]);
    prismaMock.workspaceRecorderCalendarSource.findMany.mockResolvedValue([]);
    prismaMock.meetingRecorderSmokeRun.findMany.mockResolvedValue([]);

    const filtered = await listControlPlaneRecorderMatrix(operatorActor, { client: ["inst-1", "remote-1"], status: ["needs_setup", "available"] });
    const unfiltered = await listControlPlaneRecorderMatrix(operatorActor, {});

    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      deploymentId: "inst-1",
      status: "needs_setup",
      availability: { status: "available" },
      readiness: {
        ready: false,
      },
    });
    expect(filtered.items[0].readiness.failedChecks.map((check) => check.key)).toContain("recording_schedule");
    expect(unfiltered.items.find((row) => row.deploymentId === "remote-1")).toMatchObject({
      status: "unavailable",
      configured: null,
      readiness: {
        detail: "No cached recorder integration snapshot is available.",
      },
    });
  });

  it("uses customer recorder entitlement evidence for remote-only deployments", async () => {
    const { listControlPlaneMatrix, listControlPlaneRecorderMatrix } = await import("./control-plane");
    const now = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-remote",
        slug: "remote-co",
        displayName: "Remote Co",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "ops@corgtex.com",
        notes: null,
        primaryDeploymentId: "remote-1",
        createdAt: now,
        updatedAt: now,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "remote-1",
          label: "Remote Co",
          url: "https://remote.test",
          customerSlug: "remote-co",
          customerAccountId: "cust-remote",
          supportOwnerEmail: "ops@corgtex.com",
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          lastHealthError: null,
          releaseImageTag: "web:latest",
          releaseVersion: null,
          supportConnectorStatus: "connected",
          supportCredentialEnc: "encrypted-token",
          managedWorkspaceId: null,
          managedWorkspace: null,
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: now,
          updatedAt: now,
        },
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.customerEntitlement.findMany.mockResolvedValue([{
      customerAccountId: "cust-remote",
      deploymentId: "remote-1",
      scopeKey: "deployment:remote-1",
      enabled: true,
      status: "ENABLED",
      evidence: {
        configEnabled: true,
        defaultProvider: "RECALL_AI",
        monthlyMinuteCap: 6000,
      },
      createdAt: new Date("2026-06-01T08:30:00.000Z"),
      updatedAt: now,
    }]);

    const recorderMatrix = await listControlPlaneRecorderMatrix(operatorActor, {});
    const fleetMatrix = await listControlPlaneMatrix(operatorActor, {});

    expect(recorderMatrix.items[0]).toMatchObject({
      deploymentId: "remote-1",
      status: "needs_setup",
      availability: { status: "available" },
      entitlementEnabled: true,
      configured: true,
      provider: "RECALL_AI",
      monthlyMinuteCap: 6000,
      readiness: {
        ready: false,
        detail: "No cached recorder integration snapshot is available.",
        failedChecks: [
          {
            key: "remote_snapshot",
            label: "Remote recorder snapshot",
          },
        ],
      },
    });
    expect(fleetMatrix.items[0]).toMatchObject({
      recorder: {
        status: "needs_setup",
        availability: { status: "available" },
      },
    });
    const recorderIssue = fleetMatrix.items[0].issues.find((issue) => issue.source === "recorder");
    expect(recorderIssue).toMatchObject({
      title: "Recorder readiness gap",
      status: "needs_setup",
      detail: expect.stringContaining("Remote recorder snapshot"),
    });
  });

  it("falls back to same-account recorder entitlement evidence when deployments are replaced", async () => {
    const { listControlPlaneRecorderMatrix } = await import("./control-plane");
    const now = new Date("2026-06-01T10:00:00.000Z");
    prismaMock.customerAccount.findMany.mockResolvedValue([
      {
        id: "cust-remote",
        slug: "remote-co",
        displayName: "Remote Co",
        status: "ACTIVE",
        managementAuthority: "CORGTEX",
        supportOwnerEmail: "ops@corgtex.com",
        notes: null,
        primaryDeploymentId: "remote-current",
        createdAt: now,
        updatedAt: now,
        fleetSnapshots: [],
        deployments: [],
        primaryDeployment: {
          id: "remote-current",
          label: "Remote Co",
          url: "https://remote.test",
          customerSlug: "remote-co",
          customerAccountId: "cust-remote",
          supportOwnerEmail: "ops@corgtex.com",
          provisioningStatus: "active",
          lastHealthStatus: "ok",
          lastHealthError: null,
          releaseImageTag: "web:latest",
          releaseVersion: null,
          supportConnectorStatus: "connected",
          supportCredentialEnc: "encrypted-token",
          managedWorkspaceId: null,
          managedWorkspace: null,
          supportOperations: [],
          fleetSnapshots: [],
          _count: { supportOperations: 0, events: 0 },
          createdAt: now,
          updatedAt: now,
        },
      },
    ] as any);
    prismaMock.customerDeployment.findMany.mockResolvedValue([]);
    prismaMock.customerEntitlement.findMany.mockResolvedValue([{
      customerAccountId: "cust-remote",
      deploymentId: "remote-archived",
      scopeKey: "deployment:remote-archived",
      enabled: true,
      status: "ENABLED",
      evidence: {
        configEnabled: true,
        defaultProvider: "RECALL_AI",
        monthlyMinuteCap: 6000,
      },
      createdAt: new Date("2026-05-30T08:30:00.000Z"),
      updatedAt: new Date("2026-06-01T08:30:00.000Z"),
    }]);

    const recorderMatrix = await listControlPlaneRecorderMatrix(operatorActor, {});

    expect(prismaMock.customerEntitlement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        entitlementKey: "MEETING_RECORDERS",
        OR: expect.arrayContaining([
          { customerAccountId: { in: ["cust-remote"] } },
        ]),
      }),
    }));
    expect(recorderMatrix.items[0]).toMatchObject({
      deploymentId: "remote-current",
      status: "needs_setup",
      availability: { status: "available" },
      entitlementEnabled: true,
      configured: true,
      provider: "RECALL_AI",
      monthlyMinuteCap: 6000,
      readiness: {
        ready: false,
        detail: "No cached recorder integration snapshot is available.",
      },
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
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValueOnce({ id: "smoke-1", status: "COMPLETED" });

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
          smokeRunId: "smoke-1",
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

  it("returns compact meeting operations readiness for managed workspaces", async () => {
    const { getControlPlaneMeetingOperationsReadiness } = await import("./control-plane");
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const nextMeetingAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
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
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "slack-1",
      settings: { defaultAgendaChannelId: "C123", agendaTimezone: "UTC" },
    });
    const recorderMeetingUrl = "https://meet.google.com/abc-defg-hij";
    prismaMock.meeting.findMany
      .mockResolvedValueOnce([
        {
          id: "meeting-1",
          workspaceId: "ws-1",
          title: "Weekly update",
          status: "SCHEDULED",
          recordedAt: nextMeetingAt,
          scheduledEndAt: new Date(nextMeetingAt.getTime() + 60 * 60 * 1000),
          agendaJson: { title: "Agenda", sections: [] },
          agendaChannelId: "C123",
          agendaMessageTs: "1710000001.000100",
          agendaPostedAt: recent,
          seriesId: "series-1",
          series: { recurrenceRule: "FREQ=WEEKLY" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "meeting-covered",
          seriesId: "series-1",
          recordedAt: nextMeetingAt,
          scheduledEndAt: new Date(nextMeetingAt.getTime() + 60 * 60 * 1000),
          meetingUrl: recorderMeetingUrl,
          series: { meetingUrl: null },
          recordings: [{
            status: "SCHEDULED",
            meetingUrl: recorderMeetingUrl,
            failureCode: null,
          }],
        },
      ]);
    prismaMock.workflowJob.findFirst.mockResolvedValue(null);
    prismaMock.workspaceFeatureFlag.findUnique
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ enabled: true });
    prismaMock.workspaceMeetingRecorderConfig.findUnique
      .mockResolvedValueOnce({
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: false,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
      })
      .mockResolvedValueOnce({
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: false,
        defaultProvider: "RECALL_AI",
        fallbackProvider: null,
        monthlyMinuteCap: 6000,
      });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      status: "ACTIVE",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "calendar@example.com",
      lastSyncAt: recent,
      lastSyncError: null,
    });
    prismaMock.workflowJob.count.mockResolvedValueOnce(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: recent,
      completedAt: recent,
    });
    prismaMock.meetingRecording.findFirst.mockResolvedValue(null);
    prismaMock.meetingRecording.findMany.mockResolvedValue([]);

    const result = await getControlPlaneMeetingOperationsReadiness(operatorActor, "inst-1");

    expect(result).toMatchObject({
      deploymentId: "inst-1",
      managedWorkspaceId: "ws-1",
      agenda: {
        status: "ready",
        ready: true,
        nextMeeting: {
          id: "meeting-1",
          hasAgendaJson: true,
          hasPostedAgenda: true,
        },
      },
      recorder: {
        status: "ready",
        ready: true,
        provider: "RECALL_AI",
        gates: {
          controlPlane: { status: "pass" },
          tenantConfig: { status: "pass" },
          vendor: { status: "pass" },
          calendar: { status: "pass", label: "Recording schedule" },
          meetingState: { status: "pass" },
          liveVendorProof: { status: "pass" },
        },
        upcomingCoverage: {
          counts: expect.objectContaining({
            total: expect.any(Number),
          }),
          meetings: expect.any(Array),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("supportCredentialEnc");
  });

  it("returns meeting operations readiness through support connector when no managed workspace exists", async () => {
    const { getControlPlaneMeetingOperationsReadiness } = await import("./control-plane");
    const remoteReadiness = {
      workspaceId: "remote-workspace",
      ready: true,
      configured: true,
      provider: "RECALL_AI",
      fallbackProvider: null,
      status: "ready",
      detail: "Recorder readiness checks are passing.",
      checks: [
        { key: "entitlement", label: "Recorder entitlement", ok: true, detail: "MEETING_RECORDERS is enabled." },
        { key: "recorder_config", label: "Recorder config", ok: true, detail: "RECALL_AI enabled." },
        { key: "public_base_url", label: "Public recorder URL", ok: true, detail: "Configured." },
        { key: "recall_api_key", label: "Recall API key", ok: true, detail: "Configured." },
        { key: "recall_webhook_secret", label: "Recall webhook secret", ok: true, detail: "Configured." },
        { key: "recording_schedule", label: "Corgtex recorder schedule", ok: true, detail: "1 upcoming Corgtex scheduled meeting(s) already have recorder coverage." },
        { key: "provider_proof", label: "Recorder provider proof", ok: true, detail: "Recent recorder proof at 2026-07-20T06:00:00.000Z." },
      ],
      coverage: {
        window: {
          from: "2026-07-20T06:00:00.000Z",
          to: "2026-08-19T06:00:00.000Z",
        },
        counts: {
          total: 1,
          eligible: 0,
          blockers: { already_covered: 1, auto_recording_off: 1 },
        },
        meetings: [{
          meetingId: "meeting-1",
          recordedAt: "2026-07-22T16:00:00.000Z",
          hasOccurrenceUrl: false,
          hasSeriesUrl: false,
          blockerReasons: ["already_covered", "auto_recording_off"],
        }],
      },
      lastSmokeRun: {
        status: "COMPLETED",
        createdAt: "2026-07-20T05:00:00.000Z",
        completedAt: "2026-07-20T05:02:00.000Z",
      },
      lastSuccessfulRecording: {
        provider: "RECALL_AI",
        status: "COMPLETED",
        observedAt: "2026-07-20T06:00:00.000Z",
      },
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Acme",
        customerAccountId: "cust-1",
        managedWorkspaceId: null,
        supportCredentialEnc: "encrypted:support-token",
        managedWorkspace: null,
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Acme",
        url: "https://remote.example",
        customerSlug: "remote-acme",
        customerAccountId: "cust-1",
        deploymentKind: "RAILWAY",
        deploymentStatus: "ACTIVE",
        supportMcpUrl: "https://remote.example/api/mcp",
        supportCredentialEnc: "encrypted:support-token",
        supportConnectorStatus: "ACTIVE",
      });
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-readiness", action: "meeting_recorders.readiness" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-readiness",
      status: "COMPLETED",
      resultSummary: remoteReadiness,
    });
    global.fetch = vi.fn(async () => mcpToolResult(remoteReadiness)) as any;

    const result = await getControlPlaneMeetingOperationsReadiness(operatorActor, "inst-1");

    expect(result).toMatchObject({
      deploymentId: "inst-1",
      managedWorkspaceId: null,
      accessMode: "support_connector",
      agenda: null,
      recorder: {
        workspaceId: "remote-workspace",
        ready: true,
        status: "ready",
        configured: true,
        provider: "RECALL_AI",
        fallbackProvider: null,
        upcomingCoverage: {
          counts: {
            total: 1,
            eligible: 0,
            blockers: { already_covered: 1, auto_recording_off: 1 },
          },
        },
      },
    });
    expect(result.recorder.gates).toMatchObject({
      controlPlane: { status: "pass" },
      tenantConfig: { status: "pass" },
      vendor: { status: "pass" },
      calendar: { status: "pass", label: "Recording schedule" },
      meetingState: { status: "pass" },
      liveVendorProof: { status: "pass" },
    });
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "meeting_recorders.readiness",
        inputSummary: {},
      }),
    }));
    const body = JSON.parse(String(vi.mocked(global.fetch).mock.calls[0][1]?.body));
    expect(body.params.name).toBe("get_meeting_recorder_operations_readiness");
    expect(JSON.stringify(result)).not.toContain("support-token");
    expect(JSON.stringify(result)).not.toContain("teams.microsoft.com");
  });

  it("returns explicit control-plane recorder readiness blockers when support connector readiness fails", async () => {
    const { getControlPlaneMeetingOperationsReadiness } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Acme",
        customerAccountId: "cust-1",
        managedWorkspaceId: null,
        supportCredentialEnc: "encrypted:support-token",
        managedWorkspace: null,
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Acme",
        url: "https://remote.example",
        customerSlug: "remote-acme",
        customerAccountId: "cust-1",
        deploymentKind: "RAILWAY",
        deploymentStatus: "ACTIVE",
        supportMcpUrl: "https://remote.example/api/mcp",
        supportCredentialEnc: "encrypted:support-token",
        supportConnectorStatus: "ACTIVE",
      });
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-readiness", action: "meeting_recorders.readiness" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-readiness",
      status: "FAILED",
      error: "Support connector unavailable.",
    });
    global.fetch = vi.fn(async () => {
      throw new Error("Connector 401 from https://teams.microsoft.com/l/meetup-join/private");
    }) as any;

    const result = await getControlPlaneMeetingOperationsReadiness(operatorActor, "inst-1");

    expect(result).toMatchObject({
      deploymentId: "inst-1",
      managedWorkspaceId: null,
      accessMode: "support_connector",
      recorder: {
        ready: false,
        status: "blocked",
        gates: {
          controlPlane: {
            status: "blocked",
            checks: [{
              key: "support_connector",
              status: "blocked",
            }],
          },
          vendor: { status: "unknown" },
          liveVendorProof: { status: "unknown" },
        },
      },
    });
    expect(result.recorder.gates.controlPlane.detail).not.toContain("teams.microsoft.com");
    expect(JSON.stringify(result)).not.toContain("support-token");
  });

  it("queues agenda preparation for managed workspaces and audits the reason", async () => {
    const { enqueueControlPlaneAgendaPreparation } = await import("./control-plane");
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
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "agenda-job-1" });

    await expect(enqueueControlPlaneAgendaPreparation(operatorActor, {
      deploymentId: "inst-1",
      targetDateISO: "2026-07-02",
      reason: "Verify regular-call agenda.",
    })).resolves.toMatchObject({
      deploymentId: "inst-1",
      managedWorkspaceId: "ws-1",
      workflowJobId: "agenda-job-1",
      targetDateISO: "2026-07-02",
    });

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "ws-1",
        type: "meeting.agenda.prepare",
        payload: { targetDateISO: "2026-07-02" },
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "inst-1",
        action: "control_plane.integration.meeting_agenda_prepare_requested",
      }),
    }));
  });

  it("requires completed smoke before active meeting recorder auto-recording can be configured", async () => {
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
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValueOnce(null);

    await expect(configureControlPlaneMeetingRecorderIntegration(operatorActor, {
      deploymentId: "inst-1",
      entitlementEnabled: true,
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: "MEETING_BAAS",
      autoRecordEnabled: true,
      monthlyMinuteCap: 1200,
      reason: "Enable recorder rollout.",
    })).rejects.toMatchObject({
      status: 400,
      code: "RECORDER_SMOKE_REQUIRED",
    });

    expect(prismaMock.workspaceMeetingRecorderConfig.upsert).not.toHaveBeenCalled();
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

  it("routes recorder calendar OAuth connect through the support connector for remote deployments", async () => {
    const { saveControlPlaneRecorderCalendarSource } = await import("./control-plane");
    const integrationAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        customerAccountId: "cust-1",
        managedWorkspaceId: null,
        supportCredentialEnc: "encrypted-support-token",
        managedWorkspace: null,
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        url: "https://remote.example",
        supportMcpUrl: "https://remote.example/api/mcp",
        supportCredentialEnc: "encrypted-support-token",
        supportConnectorStatus: "connected",
      });
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-connect",
      action: "meeting_recorders.connect_calendar",
    });
    prismaMock.supportOperation.update.mockImplementationOnce(async (args: any) => ({
      id: "op-connect",
      action: "meeting_recorders.connect_calendar",
      status: args.data.status,
      error: args.data.error ?? null,
      resultSummary: args.data.resultSummary ?? null,
    }));
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.params?.name === "connect_meeting_recorder_calendar") {
        return mcpToolResult({
          workspaceId: "remote-workspace",
          source: {
            id: "source-remote",
            provider: "MICROSOFT",
            providerAccountEmail: "recorder@remote.test",
            status: "ACTIVE",
          },
          accessToken: "returned-access-token",
          refreshToken: "returned-refresh-token",
          workflowJobId: "job-remote",
        });
      }
      return mcpToolResult({ audited: true });
    }) as any;

    const result = await saveControlPlaneRecorderCalendarSource(integrationAgent, {
      deploymentId: "inst-1",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@remote.test",
      displayName: "Remote Recorder",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresIn: 3600,
      scopes: ["offline_access", "Calendars.Read"],
      reason: "Customer authorized recorder calendar.",
    });

    const toolCall = vi.mocked(global.fetch).mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.params?.name === "connect_meeting_recorder_calendar");
    expect(toolCall?.params.arguments).toMatchObject({
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@remote.test",
      displayName: "Remote Recorder",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresIn: 3600,
      scopes: ["offline_access", "Calendars.Read"],
    });
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "meeting_recorders.connect_calendar",
        inputSummary: expect.objectContaining({
          accessToken: "[redacted]",
          refreshToken: "[redacted]",
        }),
      }),
    }));
    expect(result).toMatchObject({
      deploymentId: "inst-1",
      managedWorkspaceId: null,
      accessMode: "support_connector",
      supportOperation: {
        id: "op-connect",
        status: "COMPLETED",
      },
    });
    expect(JSON.stringify(result)).not.toContain("access-token-secret");
    expect(JSON.stringify(result)).not.toContain("refresh-token-secret");
    expect(JSON.stringify(result)).not.toContain("returned-access-token");
    expect(JSON.stringify(result)).not.toContain("returned-refresh-token");
    expect(JSON.stringify(prismaMock.customerDeploymentEvent.create.mock.calls)).not.toContain("access-token-secret");
    expect(JSON.stringify(prismaMock.customerDeploymentEvent.create.mock.calls)).not.toContain("returned-access-token");
  });

  it("omits absent optional recorder calendar OAuth fields for remote support tools", async () => {
    const { saveControlPlaneRecorderCalendarSource } = await import("./control-plane");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "control-plane-client-id");
    const integrationAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        customerAccountId: "cust-1",
        managedWorkspaceId: null,
        supportCredentialEnc: "encrypted-support-token",
        managedWorkspace: null,
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        url: "https://remote.example",
        supportMcpUrl: "https://remote.example/api/mcp",
        supportCredentialEnc: "encrypted-support-token",
        supportConnectorStatus: "connected",
      });
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-connect",
      action: "meeting_recorders.connect_calendar",
    });
    prismaMock.supportOperation.update.mockImplementationOnce(async (args: any) => ({
      id: "op-connect",
      action: "meeting_recorders.connect_calendar",
      status: args.data.status,
      error: args.data.error ?? null,
      resultSummary: args.data.resultSummary ?? null,
    }));
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.params?.name === "connect_meeting_recorder_calendar") {
        return mcpToolResult({
          workspaceId: "remote-workspace",
          source: {
            id: "source-remote",
            provider: "MICROSOFT",
            status: "ACTIVE",
          },
          workflowJobId: "job-remote",
        });
      }
      return mcpToolResult({ audited: true });
    }) as any;

    await saveControlPlaneRecorderCalendarSource(integrationAgent, {
      deploymentId: "inst-1",
      providerAccountId: "ms-user-1",
      accessToken: "access-token-secret",
      reason: "Customer authorized recorder calendar.",
    });

    const toolCall = vi.mocked(global.fetch).mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.params?.name === "connect_meeting_recorder_calendar");
    expect(toolCall?.params.arguments).toEqual({
      providerAccountId: "ms-user-1",
      accessToken: "access-token-secret",
      scopes: [],
      oauthClientId: "control-plane-client-id",
    });
    expect(Object.values(toolCall?.params.arguments ?? {})).not.toContain(null);
  });

  it("rejects remote recorder calendar connect before creating a support operation when connector credentials are missing", async () => {
    const { saveControlPlaneRecorderCalendarSource } = await import("./control-plane");
    const integrationAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        customerAccountId: "cust-1",
        managedWorkspaceId: null,
        supportCredentialEnc: null,
        managedWorkspace: null,
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        label: "Remote Customer",
        supportCredentialEnc: null,
      });

    await expect(saveControlPlaneRecorderCalendarSource(integrationAgent, {
      deploymentId: "inst-1",
      providerAccountId: "ms-user-1",
      providerAccountEmail: "recorder@remote.test",
      accessToken: "access-token-secret",
      reason: "Customer authorized recorder calendar.",
    })).rejects.toMatchObject({
      status: 400,
      code: "SUPPORT_CONNECTOR_MISSING",
    });
    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
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
      update: { enabled: true, autoRecordEnabled: true },
      create: {
        workspaceId: "ws-1",
        enabled: true,
        autoRecordEnabled: true,
      },
    });
  });

  it("routes support-connector recorder operations through audited remote MCP tools", async () => {
    const { runControlPlaneMeetingRecorderOperation } = await import("./control-plane");
    const integrationAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    };
    let operationIndex = 0;
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Remote Customer",
      customerAccountId: "cust-1",
      deploymentKind: "RAILWAY",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      url: "https://remote.example",
      supportMcpUrl: "https://remote.example/api/mcp",
      supportCredentialEnc: "encrypted-support-token",
      supportConnectorStatus: "connected",
    });
    prismaMock.supportOperation.create.mockImplementation(async (args: any) => ({
      id: `op-${++operationIndex}`,
      action: args.data.action,
    }));
    prismaMock.supportOperation.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      action: "remote",
      status: args.data.status,
      error: args.data.error ?? null,
      resultSummary: args.data.resultSummary ?? null,
    }));
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const toolName = body.params?.name;
      if (toolName === "run_meeting_recorder_live_smoke") {
        return mcpToolResult({
          smokeRun: {
            id: "smoke-remote",
            status: "SCHEDULED",
            meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
            externalBotId: "bot-remote",
            provider: "RECALL_AI",
          },
        });
      }
      if (toolName === "set_meeting_recorder_auto_recording") {
        return mcpToolResult({ autoRecordEnabled: true, readiness: { ready: true } });
      }
      if (toolName === "dry_run_meeting_recorder_calendar_scan") {
        return mcpToolResult({ upcomingEventCount: 3, schedulableEventCount: 2 });
      }
      if (toolName === "enqueue_meeting_recorder_calendar_sync") {
        return mcpToolResult({ workflowJobId: "job-remote" });
      }
      return mcpToolResult({ audited: true });
    }) as any;

    const results = [];
    results.push(await runControlPlaneMeetingRecorderOperation(integrationAgent, {
      deploymentId: "inst-1",
      operation: "enqueue_calendar_sync",
      reason: "Queue remote recorder sync.",
    }));
    results.push(await runControlPlaneMeetingRecorderOperation(integrationAgent, {
      deploymentId: "inst-1",
      operation: "dry_run_scan",
      reason: "Preview remote recorder calendar.",
    }));
    results.push(await runControlPlaneMeetingRecorderOperation(integrationAgent, {
      deploymentId: "inst-1",
      operation: "live_smoke",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: new Date("2099-07-20T06:30:00.000Z"),
      provider: "RECALL_AI",
      reason: "Run live remote recorder smoke.",
    }));
    results.push(await runControlPlaneMeetingRecorderOperation(integrationAgent, {
      deploymentId: "inst-1",
      operation: "enable_auto_recording_after_smoke",
      reason: "Enable remote auto-recording after smoke.",
    }));

    const toolCalls = vi.mocked(global.fetch).mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .filter((body) => body.params?.name !== "record_support_audit");
    expect(toolCalls.map((body) => body.params.name)).toEqual([
      "enqueue_meeting_recorder_calendar_sync",
      "dry_run_meeting_recorder_calendar_scan",
      "run_meeting_recorder_live_smoke",
      "set_meeting_recorder_auto_recording",
    ]);
    expect(toolCalls[2]?.params.arguments).toEqual({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      joinAt: "2099-07-20T06:30:00.000Z",
      provider: "RECALL_AI",
    });
    expect(toolCalls[3]?.params.arguments).toEqual({ enabled: true });
    expect(results.map((result: any) => result.accessMode)).toEqual([
      "support_connector",
      "support_connector",
      "support_connector",
      "support_connector",
    ]);
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.meeting_recorder_calendar_sync_requested",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.meeting_recorder_calendar_dry_run",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.meeting_recorder_live_smoke",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.meeting_recorder_auto_recording_enabled",
      }),
    }));
    expect(JSON.stringify(results)).not.toContain("teams.microsoft.com");
    expect(JSON.stringify(results)).not.toContain("bot-remote");
    expect(JSON.stringify(prismaMock.customerDeploymentEvent.create.mock.calls)).not.toContain("teams.microsoft.com");
    expect(JSON.stringify(prismaMock.customerDeploymentEvent.create.mock.calls)).not.toContain("bot-remote");
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

  it("normalizes top-level remote member identity from support connectors", async () => {
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
            userId: "user-r",
            email: "admin@remote.test",
            displayName: "Remote Admin",
            role: "ADMIN",
            isActive: true,
          },
        ],
      },
    });

    const result = await listControlPlaneCustomerMembers(readAgent, "inst-1");

    expect(result).toMatchObject({
      source: "support_connector",
      members: [
        {
          id: "member-r",
          userId: "user-r",
          email: "admin@remote.test",
          displayName: "Remote Admin",
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
    const { financeConfigIdentity } = await import("./finance");
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
    const contextMapAi = flags.flags.find((flag) => flag.flag === "CONTEXT_MAP_AI");

    expect(finance).toMatchObject({
      enabled: false,
      source: "workspace_override",
      lastChangedBy: "operator-1",
      configIdentity: financeConfigIdentity(false, null),
    });
    expect(contextMapAi).toMatchObject({
      enabled: false,
      source: "default",
    });
    expect(contextMapAi).not.toHaveProperty("configIdentity");

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

  it("sets managed workspace feature flag config when provided", async () => {
    const { setControlPlaneFeatureFlag } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme",
      deploymentKind: "HOSTED",
      managedWorkspaceId: "ws-1",
      supportCredentialEnc: null,
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
    };
    const config = {
      channelId: "C123",
      meetingSeriesExternalId: "ops:weekly-progress-review",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment);
    prismaMock.workspaceFeatureFlag.upsert.mockResolvedValueOnce({
      workspaceId: "ws-1",
      flag: "SLACK_MEETING_ACTION_REVIEW",
      enabled: true,
      config,
    });

    await setControlPlaneFeatureFlag(operatorActor, {
      deploymentId: "inst-1",
      flag: "SLACK_MEETING_ACTION_REVIEW",
      enabled: true,
      config,
      reason: "Enable customer Slack meeting action review.",
    });

    expect(prismaMock.workspaceFeatureFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ enabled: true, config }),
      create: expect.objectContaining({ enabled: true, config }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        meta: expect.objectContaining({
          flag: "SLACK_MEETING_ACTION_REVIEW",
          enabled: true,
          configProvided: true,
        }),
      }),
    }));
  });

  it("guards managed Finance report-import updates and audits stale attempts as rejected", async () => {
    const { setControlPlaneFeatureFlag } = await import("./control-plane");
    const { financeConfigIdentity } = await import("./finance");
    const deployment = {
      id: "inst-1", label: "Acme", deploymentKind: "HOSTED", managedWorkspaceId: "ws-1",
      supportCredentialEnc: null, managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
    };
    const current = {
      id: "flag-1", workspaceId: "ws-1", flag: "FINANCE", enabled: true,
      config: { financeAllMemberWrite: true, financeCapabilities: { reports: true } },
      updatedAt: new Date("2026-08-08T01:00:00.000Z"),
    };
    const afterReportImport = {
      ...current, config: { financeAllMemberWrite: true, financeCapabilities: { reports: true, reportImports: true } },
      updatedAt: new Date("2026-08-08T01:00:01.000Z"),
    };
    const expectedConfigIdentity = financeConfigIdentity(current.enabled, current.config);
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment).mockResolvedValueOnce(deployment).mockResolvedValueOnce(deployment);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(afterReportImport).mockResolvedValueOnce(afterReportImport);
    prismaMock.workspaceFeatureFlag.update.mockResolvedValueOnce(afterReportImport).mockResolvedValueOnce({ ...afterReportImport, enabled: false, config: { financeCapabilities: { reports: true, reportImports: true } } });

    const updated = await setControlPlaneFeatureFlag(operatorActor, {
      deploymentId: "inst-1", flag: "FINANCE", reportImportsEnabled: true,
      expectedConfigIdentity, reason: "Enable the approved report-import pilot.",
    });

    expect(updated).toMatchObject({ status: "updated", reportImportsEnabled: true, configIdentity: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(prismaMock.workspaceFeatureFlag.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { config: { financeAllMemberWrite: true, financeCapabilities: { reports: true, reportImports: true } } },
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "control_plane.feature_flag.updated", meta: expect.objectContaining({ expectedConfigIdentity, reportImportsEnabled: true }) }),
    }));

    await expect(setControlPlaneFeatureFlag(operatorActor, {
      deploymentId: "inst-1", flag: "FINANCE", enabled: false,
      config: { financeCapabilities: { reports: true, reportImports: true } },
      expectedConfigIdentity: financeConfigIdentity(afterReportImport.enabled, afterReportImport.config), reason: "Apply a guarded full Finance config.",
    })).resolves.toMatchObject({ status: "updated", enabled: false });

    await expect(setControlPlaneFeatureFlag(operatorActor, {
      deploymentId: "inst-1", flag: "FINANCE", reportImportsEnabled: false,
      expectedConfigIdentity: "b".repeat(64), reason: "Retry from a stale view.",
    })).rejects.toMatchObject({ status: 409, code: "FEATURE_CONFIG_CONFLICT" });
    expect(prismaMock.workspaceFeatureFlag.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "control_plane.feature_flag.update_rejected" }),
    }));
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
            config: { channelId: "C123" },
            configIdentity: "a".repeat(64),
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
          config: { channelId: "C123" },
          configIdentity: "a".repeat(64),
          source: "remote_override",
        },
      ],
    });
    for (const [configIdentity, source] of [[null, "default"], ["malformed", "workspace_override"]] as const) {
      prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment).mockResolvedValueOnce(deployment);
      prismaMock.supportOperation.create.mockResolvedValueOnce({ id: `op-${source}`, action: "feature_flags.list" });
      prismaMock.supportOperation.update.mockResolvedValueOnce({ id: `op-${source}`, status: "COMPLETED", resultSummary: { flags: [{ flag: "FINANCE", enabled: false, source, configIdentity }] } });
      const read = listControlPlaneFeatureFlags(readAgent, "inst-1");
      if (source === "default") await expect(read).resolves.toMatchObject({ flags: [expect.objectContaining({ configIdentity: null })] });
      else await expect(read).rejects.toMatchObject({ status: 502, code: "REMOTE_SUPPORT_ERROR" });
    }
  });

  it("forwards and sanitizes guarded remote Finance report-import updates", async () => {
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
    prismaMock.supportOperation.update.mockImplementationOnce(async ({ data }: any) => ({ id: "op-flag-set", ...data }));
    global.fetch = vi.fn(async (_input, init) => {
      const call = JSON.parse(String(init?.body));
      return mcpToolResult(call.params.name === "set_feature_flag" ? {
        status: "updated", flag: "FINANCE", enabled: true, reportImportsEnabled: true,
        config: { privateSentinel: "must-not-persist" }, updatedAt: "2026-08-08T01:00:01.000Z", configIdentity: "b".repeat(64),
      } : { ok: true });
    }) as any;

    const result = await setControlPlaneFeatureFlag(featureAgent, {
      deploymentId: "inst-1",
      flag: "FINANCE",
      reportImportsEnabled: true,
      expectedConfigIdentity: "a".repeat(64),
      reason: "Enable finance for pilot.",
    });

    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inputSummary: expect.objectContaining({
          flag: "FINANCE",
          reportImportsEnabled: true,
          expectedConfigIdentity: "a".repeat(64),
        }),
      }),
    }));
    const featureCall = vi.mocked(global.fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .find((call) => call.params.name === "set_feature_flag");
    expect(featureCall.params.arguments).toEqual({ flag: "FINANCE", reportImportsEnabled: true, expectedConfigIdentity: "a".repeat(64) });
    expect(prismaMock.supportOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ resultSummary: expect.not.objectContaining({ config: expect.anything() }) }),
    }));
    expect(result).toMatchObject({
      source: "support_connector",
      flag: "FINANCE",
      enabled: true,
      status: "updated",
      reportImportsEnabled: true,
      configIdentity: "b".repeat(64),
    });
  });

  it("surfaces remote Finance config conflicts without a false updated audit", async () => {
    const { setControlPlaneFeatureFlag } = await import("./control-plane");
    const featureAgent: AppActor = { kind: "agent", authProvider: "control-plane", label: "control-plane-agent", scopes: ["control-plane:read", "control-plane:features:write"] };
    const deployment = {
      id: "inst-1", label: "Acme", deploymentKind: "REMOTE_MANAGED", managedWorkspaceId: null, managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1", supportMcpUrl: "https://customer.test/api/mcp", supportCredentialEnc: "encrypted-token",
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment).mockResolvedValueOnce(deployment);
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-conflict", action: "feature_flags.set" });
    prismaMock.supportOperation.update.mockImplementationOnce(async ({ data }: any) => ({ id: "op-conflict", ...data }));
    global.fetch = vi.fn(async (_input, init) => {
      const call = JSON.parse(String(init?.body));
      return mcpToolResult(call.params.name === "set_feature_flag"
        ? { status: "conflict", code: "FEATURE_CONFIG_CONFLICT", currentConfigIdentity: "c".repeat(64) }
        : { ok: true });
    }) as any;

    await expect(setControlPlaneFeatureFlag(featureAgent, {
      deploymentId: "inst-1", flag: "FINANCE", reportImportsEnabled: true,
      expectedConfigIdentity: "a".repeat(64), reason: "Guard against stale state.",
    })).rejects.toMatchObject({ status: 409, code: "FEATURE_CONFIG_CONFLICT", message: expect.stringContaining("c".repeat(64)) });
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "control_plane.feature_flag.update_rejected", meta: expect.objectContaining({ currentConfigIdentity: "c".repeat(64) }) }),
    }));
    for (const payload of [{ status: "updated", flag: "FINANCE", enabled: true, reportImportsEnabled: false, updatedAt: "2026-08-08T01:00:01.000Z", configIdentity: "d".repeat(64) }, { status: "conflict", code: "FEATURE_CONFIG_CONFLICT", currentConfigIdentity: "malformed" }]) {
      prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(deployment).mockResolvedValueOnce(deployment);
      prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-malformed", action: "feature_flags.set" });
      prismaMock.supportOperation.update.mockImplementationOnce(async ({ data }: any) => ({ id: "op-malformed", ...data }));
      global.fetch = vi.fn(async (_input, init) => mcpToolResult(JSON.parse(String(init?.body)).params.name === "set_feature_flag" ? payload : { ok: true })) as any;
      await expect(setControlPlaneFeatureFlag(featureAgent, { deploymentId: "inst-1", flag: "FINANCE", reportImportsEnabled: true, expectedConfigIdentity: "a".repeat(64), reason: "Reject malformed results." })).rejects.toMatchObject({ status: 502, code: "REMOTE_SUPPORT_ERROR" });
    }
  });

  it("keeps audit identifiers while redacting credential material", async () => {
    const { redactObject } = await import("./control-plane");

    expect(redactObject({
      credentialId: "cred-1",
      credentialLabel: "Production Claude",
      hasCredential: true,
      supportCredential: "raw-support-token",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      tokenHash: "sha256-secret",
      bearerToken: "bearer-secret",
      connectionString: "postgresql://secret",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      externalBotId: "bot-1",
    })).toEqual({
      credentialId: "cred-1",
      credentialLabel: "Production Claude",
      hasCredential: true,
      supportCredential: "[redacted]",
      accessToken: "[redacted]",
      refreshToken: "[redacted]",
      tokenHash: "[redacted]",
      bearerToken: "[redacted]",
      connectionString: "[redacted]",
      meetingUrl: "[redacted]",
      externalBotId: "[redacted]",
    });
  });

  it("keeps default-disabled agents off through managed policy updates", async () => {
    const { updateControlPlaneAgentPolicy } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1", label: "Synthetic", customerAccountId: "cust-1", managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "synthetic", name: "Synthetic", _count: {} },
      supportCredentialEnc: null, supportConnectorStatus: "not_configured", supportLastSyncAt: null, remoteWorkspaceId: null,
    });
    prismaMock.workspaceAgentConfig.upsert.mockResolvedValueOnce({ id: "config-1", agentKey: "finance-report-import",
      enabled: false, modelOverride: "quality-test", governancePolicy: null, updatedAt: new Date("2026-06-01T00:00:00.000Z") });

    await updateControlPlaneAgentPolicy(operatorActor, { deploymentId: "inst-1", agentKey: "finance-report-import",
      modelOverride: "quality-test", reason: "Use the approved quality route." });

    expect(prismaMock.workspaceAgentConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ agentKey: "finance-report-import", enabled: false, modelOverride: "quality-test" }),
      update: { modelOverride: "quality-test" },
    }));
  });

  it("returns expanded managed AI governance status with registry defaults, deterministic risks, and redacted policies", async () => {
    const { getControlPlaneAiGovernanceStatus } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
      supportCredentialEnc: null,
      supportConnectorStatus: "not_configured",
      supportLastSyncAt: null,
      remoteWorkspaceId: null,
    });
    prismaMock.supportOperation.findMany.mockResolvedValueOnce([
      {
        id: "op-1",
        action: "agent_credentials.update_scopes",
        reason: "Reduce access.",
        status: "COMPLETED",
        error: null,
        startedAt: new Date("2026-05-01T10:00:00.000Z"),
        completedAt: new Date("2026-05-01T10:00:05.000Z"),
        createdAt: new Date("2026-05-01T10:00:00.000Z"),
      },
    ]);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValueOnce({
      flag: "AGENT_GOVERNANCE",
      enabled: false,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    prismaMock.agentRun.groupBy.mockResolvedValueOnce([
      { status: "COMPLETED", _count: { _all: 2 } },
      { status: "WAITING_APPROVAL", _count: { _all: 1 } },
    ]);
    prismaMock.agentRun.count.mockResolvedValueOnce(1);
    prismaMock.workflowJob.count.mockResolvedValueOnce(1);
    prismaMock.modelUsage.aggregate.mockResolvedValueOnce({
      _sum: {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: { toString: () => "0.250000" },
      },
    });
    prismaMock.agentRun.findMany.mockResolvedValueOnce([
      {
        id: "run-1",
        agentKey: "meeting-summary",
        triggerType: "MANUAL",
        status: "WAITING_APPROVAL",
        goal: "Summarize meeting",
        approvalRequired: true,
        createdAt: new Date("2026-05-01T09:00:00.000Z"),
        startedAt: null,
        completedAt: null,
        failedAt: null,
      },
    ]);
    prismaMock.workflowJob.findMany.mockResolvedValueOnce([
      {
        id: "job-1",
        type: "agent.run",
        attempts: 3,
        error: "Tool call failed.",
        createdAt: new Date("2026-05-01T08:00:00.000Z"),
        updatedAt: new Date("2026-05-01T08:05:00.000Z"),
      },
    ]);
    prismaMock.agentToolCall.findMany.mockResolvedValueOnce([
      {
        id: "call-1",
        name: "update_member",
        status: "COMPLETED",
        error: null,
        createdAt: new Date("2026-05-01T08:02:00.000Z"),
        agentRun: { id: "run-1", agentKey: "meeting-summary", status: "COMPLETED" },
      },
    ]);
    prismaMock.agentIdentity.findMany.mockResolvedValueOnce([
      {
        id: "identity-1",
        agentKey: "meeting-summary",
        memberType: "SYSTEM",
        displayName: "Meeting Summary",
        isActive: true,
        linkedCredentialId: "cred-1",
        maxSpendPerRunCents: null,
        maxRunsPerDay: null,
        maxRunsPerHour: null,
        archivedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        linkedCredential: {
          id: "cred-1",
          label: "Production MCP",
          scopes: ["workspace:read", "members:write"],
          isActive: true,
          lastUsedAt: null,
        },
        circleAssignments: [],
      },
    ]);
    prismaMock.workspaceAgentConfig.findMany.mockResolvedValueOnce([
      {
        id: "config-1",
        agentKey: "meeting-summary",
        enabled: true,
        modelOverride: "openai/gpt-test",
        governancePolicy: "Do not leak this policy body.",
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.agentCredential.findMany.mockResolvedValueOnce([
      {
        id: "cred-1",
        label: "Production MCP",
        scopes: ["workspace:read", "members:write", "finance:write", "runtime:write", "support:write"],
        catalogItemId: "catalog-1",
        catalogItem: { id: "catalog-1", title: "Claude Desktop", slug: "claude", type: "MCP", status: "APPROVED" },
        monthlyBudgetCents: null,
        dailyCallLimit: null,
        isActive: true,
        lastUsedAt: new Date("2025-01-01T00:00:00.000Z"),
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.modelUsageBudget.findUnique.mockResolvedValueOnce(null);
    prismaMock.modelUsage.findMany.mockResolvedValueOnce([
      {
        id: "usage-1",
        provider: "openai",
        model: "gpt-test",
        taskType: "AGENT_RUN",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 1200,
        estimatedCostUsd: { toString: () => "0.250000" },
        createdAt: new Date("2026-05-01T09:01:00.000Z"),
        agentRun: { id: "run-1", agentKey: "meeting-summary", status: "COMPLETED" },
        agentCredential: { id: "cred-1", label: "Production MCP", isActive: true },
        catalogItem: { id: "catalog-1", title: "Claude Desktop" },
      },
    ]);

    const status = await getControlPlaneAiGovernanceStatus(operatorActor, "inst-1");

    expect(status.featureFlag).toMatchObject({ flag: "AGENT_GOVERNANCE", enabled: false });
    expect(status.summary?.agentRuns).toEqual({ COMPLETED: 2, WAITING_APPROVAL: 1 });
    expect(status.summary?.modelUsage).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: "0.250000" });
    expect(status.access.credentials[0]).toMatchObject({
      id: "cred-1",
      risk: {
        highRisk: expect.arrayContaining(["members:write", "finance:write", "runtime:write", "support:write"]),
        isOverbroad: true,
      },
    });
    expect(status.agents.configs.find((config) => config.agentKey === "meeting-summary")).toMatchObject({
      modelOverride: "openai/gpt-test",
      hasGovernancePolicy: true,
    });
    expect(status.agents.configs.find((config) => config.agentKey === "finance-report-import")?.enabled).toBe(false);
    expect(status.riskFindings.map((finding) => finding.key)).toEqual(expect.arrayContaining([
      "agent-governance-disabled",
      "model-budget-missing",
      "pending-agent-approvals",
      "failed-agent-jobs",
      "risky-tool-calls",
      "stale-credential-cred-1",
      "overbroad-credential-cred-1",
    ]));
    expect(JSON.stringify(status)).not.toContain("Do not leak this policy body");
    expect(JSON.stringify(status)).not.toContain("tokenHash");
  });

  it("summarizes cached remote AI governance without creating support operations", async () => {
    const { getControlPlaneAiGovernanceStatus } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-remote",
      label: "Acme Production",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncAt: new Date("2026-05-24T00:00:00.000Z"),
      remoteWorkspaceId: "remote-ws-1",
    });
    prismaMock.supportOperation.findMany.mockResolvedValueOnce([]);
    prismaMock.fleetHealthSnapshot.findFirst.mockResolvedValueOnce({
      status: "ok",
      error: null,
      observedAt: new Date("2026-05-24T00:00:00.000Z"),
      createdAt: new Date("2026-05-24T00:00:00.000Z"),
      summary: {
        agentRuns: {
          items: [
            {
              id: "run-1",
              agentKey: "inbox-triage",
              status: "FAILED",
              goal: "Triage inbox.",
              createdAt: "2026-05-24T00:00:00.000Z",
              resultJson: { privateContent: "must not surface" },
            },
          ],
        },
        failedJobs: {
          items: [
            {
              id: "job-1",
              type: "communication.slack.proactive-scan",
              attempts: 3,
              error: "An API error occurred: invalid_auth",
              payload: { token: "must not surface" },
            },
          ],
        },
      },
    });

    const status = await getControlPlaneAiGovernanceStatus(operatorActor, "inst-remote");

    expect(status.summary).toMatchObject({
      source: "cached_support_snapshot",
      agentRuns: { FAILED: 1 },
      failedJobs: 1,
    });
    expect(status.activity.recentRuns[0]).toMatchObject({
      id: "run-1",
      agentKey: "inbox-triage",
      status: "FAILED",
    });
    expect(status.activity.recentFailedJobs[0]).toMatchObject({
      id: "job-1",
      type: "communication.slack.proactive-scan",
      error: "An API error occurred: invalid_auth",
    });
    expect(status.riskFindings.map((finding) => finding.key)).toEqual(expect.arrayContaining([
      "remote-agent-run-failures",
      "remote-failed-workflow-jobs",
    ]));
    expect(status.cachedSupportSnapshot).toMatchObject({
      available: true,
      status: "ok",
    });
    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("must not surface");
  });

  it("requires governance write scope and explicit reasons for agent governance mutations", async () => {
    const { updateControlPlaneAgentCredentialScopes } = await import("./control-plane");
    const readAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read"],
    };

    await expect(updateControlPlaneAgentCredentialScopes(readAgent, {
      deploymentId: "inst-1",
      credentialId: "cred-1",
      scopes: ["workspace:read"],
      reason: "Reduce credential scope.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_SCOPE_REQUIRED",
    });

    await expect(updateControlPlaneAgentCredentialScopes(operatorActor, {
      deploymentId: "inst-1",
      credentialId: "cred-1",
      scopes: ["workspace:read"],
      reason: "",
    })).rejects.toMatchObject({
      status: 400,
      code: "CONTROL_PLANE_REASON_REQUIRED",
    });
  });

  it("updates managed agent credential scopes and audits the credential id without token material", async () => {
    const { updateControlPlaneAgentCredentialScopes } = await import("./control-plane");
    const writeAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:ai-governance:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: {} },
      supportCredentialEnc: null,
    });
    prismaMock.agentCredential.findUnique.mockResolvedValueOnce({
      id: "cred-1",
      workspaceId: "ws-1",
      isActive: true,
    });
    prismaMock.agentCredential.update.mockResolvedValueOnce({
      id: "cred-1",
      label: "Production MCP",
      scopes: ["workspace:read", "agents:read"],
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    const result = await updateControlPlaneAgentCredentialScopes(writeAgent, {
      deploymentId: "inst-1",
      credentialId: "cred-1",
      scopes: ["workspace:read", "agents:read"],
      reason: "Reduce to diagnostic access.",
    });

    expect(prismaMock.agentCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cred-1" },
      data: { scopes: ["workspace:read", "agents:read"] },
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.ai_governance.credential_scopes_updated",
        meta: expect.objectContaining({
          reason: "Reduce to diagnostic access.",
          credentialId: "cred-1",
          scopes: ["workspace:read", "agents:read"],
        }),
      }),
    }));
    expect(result).toMatchObject({
      source: "managed_workspace",
      credential: {
        id: "cred-1",
        scopes: ["workspace:read", "agents:read"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("routes remote model budget updates through the audited support connector", async () => {
    const { updateControlPlaneModelBudget } = await import("./control-plane");
    const writeAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:ai-governance:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Remote Acme",
      url: "https://customer.test",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
    });
    prismaMock.supportOperation.create.mockResolvedValueOnce({ id: "op-budget", action: "model_budget.update" });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-budget",
      status: "COMPLETED",
      resultSummary: { budget: { id: "budget-1", monthlyCostCapUsd: "250.00" } },
    });

    const result = await updateControlPlaneModelBudget(writeAgent, {
      deploymentId: "inst-1",
      monthlyCostCapUsd: 250,
      alertThresholdPct: 75,
      reason: "Customer approved model cap.",
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    const toolCall = vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(toolCall.body))).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        name: "update_model_budget",
        arguments: {
          monthlyCostCapUsd: 250,
          alertThresholdPct: 75,
          periodStartDay: 1,
        },
      }),
    }));
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "model_budget.update",
        inputSummary: {
          monthlyCostCapUsd: 250,
          alertThresholdPct: 75,
          periodStartDay: 1,
        },
      }),
    }));
    expect(result).toMatchObject({
      source: "support_connector",
      operation: { id: "op-budget", status: "COMPLETED" },
    });
  });

  it("does not fall back to manual repair for unsupported remote governance mutations", async () => {
    const { updateControlPlaneModelBudget } = await import("./control-plane");
    const writeAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:ai-governance:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Remote Acme",
      managedWorkspaceId: null,
      managedWorkspace: null,
      remoteWorkspaceId: "remote-ws-1",
      supportMcpUrl: null,
      supportCredentialEnc: null,
      supportConnectorStatus: "not_configured",
    });

    await expect(updateControlPlaneModelBudget(writeAgent, {
      deploymentId: "inst-1",
      monthlyCostCapUsd: 250,
      reason: "Customer approved model cap.",
    })).rejects.toMatchObject({
      status: 400,
      code: "SUPPORT_CONNECTOR_REQUIRED",
    });
    expect(fetch).not.toHaveBeenCalled();
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

  it("blocks deploy-latest preflight when the configured target already matches the current release", async () => {
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:sha-1c105e0");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:sha-1c105e0");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_IMAGE_TAG", "sha-1c105e0c7961a2f24d4d8af1eeeaeb8ee8d18699");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_VERSION", "main-1c105e0c7961");
    const { getControlPlaneDeployLatestPreflight } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "enterprise-alpha-1",
      label: "Enterprise Alpha Production",
      customerAccountId: "cust-alpha",
      customerSlug: "enterprise-alpha",
      cloudProvider: "RAILWAY",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "sha-1c105e0c7961a2f24d4d8af1eeeaeb8ee8d18699",
      releaseVersion: "main-1c105e0c7961",
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-06-29T18:00:00.000Z"),
      lastHealthError: null,
      railwayProjectId: "project-alpha",
      railwayEnvironmentId: "env-alpha",
      railwayWebServiceId: "web-alpha",
      railwayWorkerServiceId: "worker-alpha",
    });

    const preflight = await getControlPlaneDeployLatestPreflight(operatorActor, "enterprise-alpha-1");

    expect(preflight.eligible).toBe(false);
    expect(preflight.checks).toContainEqual(expect.objectContaining({
      key: "target_differs",
      ok: false,
      detail: "Target already matches current release.",
    }));
    expect(preflight.blockers).toContain("Target already matches current release.");
  });

  it("does not queue aligned Railway enterprise deploy-latest jobs", async () => {
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:sha-1c105e0");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:sha-1c105e0");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_IMAGE_TAG", "sha-1c105e0c7961a2f24d4d8af1eeeaeb8ee8d18699");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    const baseDeployment = {
      customerAccountId: "cust-1",
      cloudProvider: "RAILWAY",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      provisioningStatus: "active",
      releaseImageTag: "sha-1c105e0c7961a2f24d4d8af1eeeaeb8ee8d18699",
      releaseVersion: null,
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-06-29T18:00:00.000Z"),
      lastHealthError: null,
      railwayEnvironmentId: "env-1",
      railwayWebServiceId: "web-1",
      railwayWorkerServiceId: "worker-1",
    };
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      { ...baseDeployment, id: "enterprise-alpha-1", label: "Enterprise Alpha Production", customerSlug: "enterprise-alpha", railwayProjectId: "project-alpha" },
      { ...baseDeployment, id: "enterprise-beta-1", label: "Enterprise Beta Production", customerSlug: "enterprise-beta", railwayProjectId: "project-beta" },
      { ...baseDeployment, id: "enterprise-gamma-1", label: "Enterprise Gamma Production", customerSlug: "enterprise-gamma", railwayProjectId: "project-gamma" },
    ]);

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      allEligible: true,
      reason: "Do not redeploy already aligned customers.",
    });

    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      requested: 3,
      queuedJobs: 0,
      results: [
        { deploymentId: "enterprise-alpha-1", status: "skipped", blockers: ["Target already matches current release."] },
        { deploymentId: "enterprise-beta-1", status: "skipped", blockers: ["Target already matches current release."] },
        { deploymentId: "enterprise-gamma-1", status: "skipped", blockers: ["Target already matches current release."] },
      ],
    });
  });

  it("blocks deploy-latest preflight when Railway release execution is not configured", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("RAILWAY_API_TOKEN", "");
    const { getControlPlaneDeployLatestPreflight } = await import("./control-plane");
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

    const preflight = await getControlPlaneDeployLatestPreflight(operatorActor, "inst-1");

    expect(preflight.eligible).toBe(false);
    expect(preflight.checks).toContainEqual(expect.objectContaining({
      key: "railway_api_token_configured",
      ok: false,
      detail: "Railway API token is not configured for control-plane release execution.",
    }));
  });

  it("validates Railway executor read access for a deployment target", async () => {
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { validateControlPlaneRailwayReleaseExecutor } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      customerSlug: "acme",
      cloudProvider: "RAILWAY",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
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
    });
    const railwayClient = {
      graphql: vi.fn().mockResolvedValueOnce({
        project: { id: "project-1", name: "Acme" },
        environments: { edges: [{ node: { id: "env-1", name: "production" } }] },
        webService: { id: "web-1", name: "web" },
        workerService: { id: "worker-1", name: "worker" },
      }),
    };

    const result = await validateControlPlaneRailwayReleaseExecutor(operatorActor, "inst-1", railwayClient);

    expect(railwayClient.graphql).toHaveBeenCalledWith(expect.stringContaining("ValidateRailwayReleaseExecutor"), {
      projectId: "project-1",
      webServiceId: "web-1",
      workerServiceId: "worker-1",
    });
    expect(result).toMatchObject({
      deploymentId: "inst-1",
      provider: "RAILWAY",
      status: "ok",
      access: {
        projectId: "project-1",
        environmentId: "env-1",
        webServiceId: "web-1",
        workerServiceId: "worker-1",
      },
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      key: "railway_executor_access",
      ok: true,
    }));
  });

  it("reports unreadable Railway executor access as a clear blocker", async () => {
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_IMAGE_TAG", "release-new");
    const { validateControlPlaneRailwayReleaseExecutor } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      customerAccountId: "cust-1",
      customerSlug: "acme",
      cloudProvider: "RAILWAY",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
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
    });
    const railwayClient = {
      graphql: vi.fn().mockRejectedValueOnce(new Error("Not Authorized")),
    };

    const result = await validateControlPlaneRailwayReleaseExecutor(operatorActor, "inst-1", railwayClient);

    expect(result).toMatchObject({
      deploymentId: "inst-1",
      provider: "RAILWAY",
      status: "blocked",
      blockers: ["Railway executor access validation failed: Not Authorized"],
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      key: "railway_executor_access",
      ok: false,
      detail: "Railway executor access validation failed: Not Authorized",
    }));
  });

  it("blocks deploy-latest preflight for shared managed workspace rows", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("RAILWAY_API_TOKEN", "configured");
    const { getControlPlaneDeployLatestPreflight } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "shared-1",
      label: "Managed Workspace",
      url: "https://workspace.test",
      customerAccountId: "cust-1",
      customerSlug: "managed-workspace",
      deploymentKind: "SHARED_WORKSPACE",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "workspace", name: "Workspace" },
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

    const preflight = await getControlPlaneDeployLatestPreflight(operatorActor, "shared-1");

    expect(preflight.eligible).toBe(false);
    expect(preflight.checks).toContainEqual(expect.objectContaining({
      key: "not_shared_workspace",
      ok: false,
      detail: "Shared managed workspace rows are managed through the shared-cloud release workflow and are not deploy-latest targets.",
    }));
  });

  it("preflights Azure self-serve without requiring Railway project or service IDs", async () => {
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_ACR_WEB_IMAGE", "corgtexacr.azurecr.io/corgtex/web:sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_ACR_WORKER_IMAGE", "corgtexacr.azurecr.io/corgtex/worker:sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_RELEASE_GIT_SHA", "sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_RELEASE_VERSION", "2026.06.10");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_HEALTH_STATUS", "ok");
    const { getControlPlaneDeployLatestPreflight } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "selfserve-1",
      label: "Corgtex Self-Serve",
      url: "https://selfserve.corgtex.com",
      customerAccountId: "cust-selfserve",
      customerSlug: "selfserve",
      cloudProvider: "AZURE",
      deploymentKind: "HOSTED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      provisioningStatus: "active",
      releaseImageTag: "sha-old",
      releaseVersion: "2026.06.01",
      lastHealthStatus: "ok",
      lastHealthCheck: new Date("2026-06-10T00:00:00.000Z"),
      lastHealthError: null,
      railwayProjectId: null,
      railwayEnvironmentId: null,
      railwayWebServiceId: null,
      railwayWorkerServiceId: null,
      providerResourceGroup: "rg-corgtex-selfserve-prod",
      providerEnvironmentId: "cae-corgtex-selfserve",
      providerWebServiceId: "ca-corgtex-selfserve-web",
      providerWorkerServiceId: "ca-corgtex-selfserve-worker",
    });

    const preflight = await getControlPlaneDeployLatestPreflight(operatorActor, "selfserve-1");

    expect(preflight.target).toMatchObject({
      cloudProvider: "AZURE",
      releaseImageTag: "sha-new",
      releaseGitSha: "sha-new",
      webImage: "corgtexacr.azurecr.io/corgtex/web:sha-new",
      workerImage: "corgtexacr.azurecr.io/corgtex/worker:sha-new",
    });
    expect(preflight.eligible).toBe(false);
    expect(preflight.checks).toContainEqual(expect.objectContaining({
      key: "azure_target",
      ok: true,
    }));
    expect(preflight.checks).toContainEqual(expect.objectContaining({
      key: "azure_workflow_reconciliation",
      ok: false,
    }));
    expect(preflight.checks.map((check) => check.key)).not.toContain("railway_target");
    expect(preflight.blockers.join(" ")).not.toContain("Railway");
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

  it("skips Azure self-serve, backup app, and shared workspace rows during fleet-wide deploy-latest", async () => {
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_RAILWAY_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_ACR_WEB_IMAGE", "corgtexacr.azurecr.io/corgtex/web:sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_ACR_WORKER_IMAGE", "corgtexacr.azurecr.io/corgtex/worker:sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_RELEASE_GIT_SHA", "sha-new");
    vi.stubEnv("CONTROL_PLANE_AZURE_LATEST_HEALTH_STATUS", "ok");
    const { enqueueControlPlaneDeployLatestRollout } = await import("./control-plane");
    prismaMock.customerDeployment.findMany.mockResolvedValueOnce([
      {
        id: "enterprise-1",
        label: "Enterprise Alpha",
        url: "https://enterprise-alpha.example.com",
        customerSlug: "enterprise-alpha",
        customerAccountId: "cust-1",
        cloudProvider: "RAILWAY",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-06-10T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-1",
        railwayEnvironmentId: "env-1",
        railwayWebServiceId: "web-1",
        railwayWorkerServiceId: "worker-1",
      },
      {
        id: "selfserve-1",
        label: "Corgtex Self-Serve",
        url: "https://selfserve.corgtex.com",
        customerSlug: "selfserve",
        customerAccountId: "cust-2",
        cloudProvider: "AZURE",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "sha-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-06-10T00:00:00.000Z"),
        lastHealthError: null,
        providerResourceGroup: "rg-corgtex-selfserve-prod",
        providerEnvironmentId: "cae-corgtex-selfserve",
        providerWebServiceId: "ca-corgtex-selfserve-web",
        providerWorkerServiceId: "ca-corgtex-selfserve-worker",
      },
      {
        id: "backup-1",
        label: "Corgtex Internal",
        url: "https://app.corgtex.com",
        customerSlug: "corgtex-internal",
        customerAccountId: "cust-3",
        cloudProvider: "RAILWAY",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-06-10T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-3",
        railwayEnvironmentId: "env-3",
        railwayWebServiceId: "web-3",
        railwayWorkerServiceId: "worker-3",
      },
      {
        id: "shared-1",
        label: "Managed Workspace",
        url: "https://workspace.test",
        customerSlug: "managed-workspace",
        customerAccountId: "cust-4",
        cloudProvider: "RAILWAY",
        deploymentKind: "SHARED_WORKSPACE",
        managedWorkspaceId: "ws-managed",
        deploymentStatus: "ACTIVE",
        provisioningStatus: "active",
        releaseImageTag: "release-old",
        releaseVersion: null,
        lastHealthStatus: "ok",
        lastHealthCheck: new Date("2026-06-10T00:00:00.000Z"),
        lastHealthError: null,
        railwayProjectId: "project-4",
        railwayEnvironmentId: "env-4",
        railwayWebServiceId: "web-4",
        railwayWorkerServiceId: "worker-4",
      },
    ]);

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      allEligible: true,
      reason: "Deploy latest to Railway enterprise customers.",
    });

    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.workflowJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          deploymentId: "enterprise-1",
        }),
      }),
    }));
    expect(result).toMatchObject({
      requested: 4,
      queuedJobs: 1,
      results: [
        { deploymentId: "enterprise-1", status: "queued" },
        { deploymentId: "selfserve-1", status: "skipped" },
        { deploymentId: "backup-1", status: "skipped" },
        { deploymentId: "shared-1", status: "skipped" },
      ],
    });
  });

  it("skips bulk deploy-latest jobs when Railway release execution is not configured", async () => {
    vi.stubEnv("CONTROL_PLANE_LATEST_WEB_IMAGE", "ghcr.io/corgtex/web:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_WORKER_IMAGE", "ghcr.io/corgtex/worker:new");
    vi.stubEnv("CONTROL_PLANE_LATEST_RELEASE_IMAGE_TAG", "release-new");
    vi.stubEnv("RAILWAY_API_TOKEN", "");
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

    const result = await enqueueControlPlaneDeployLatestRollout(operatorActor, {
      allEligible: true,
      reason: "Deploy latest to healthy customers.",
    });

    expect(prismaMock.workflowJob.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      requested: 1,
      queuedJobs: 0,
      results: [
        {
          deploymentId: "inst-1",
          status: "skipped",
          blockers: ["Railway API token is not configured for control-plane release execution."],
        },
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
        release: { imageTag: "ghcr.io/corgtex/web:stale", gitSha: "sha-new" },
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

  it("does not call workspace URLs when probing shared managed workspace rows", async () => {
    const { probeControlPlaneDeploymentHealth } = await import("./control-plane");
    const scopedAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:releases:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "shared-1",
      label: "Corporate Rebels",
      customerAccountId: "cust-1",
      customerSlug: "corporate-rebels",
      deploymentKind: "SHARED_WORKSPACE",
      url: "https://workspace.example.com",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "corporate-rebels", name: "Corporate Rebels" },
      supportCredentialEnc: null,
      releaseImageTag: null,
      releaseVersion: null,
      lastHealthStatus: null,
      lastHealthError: null,
      lastHealthCheck: null,
      lastWorkerHealthStatus: null,
      lastWorkerHealthCheck: null,
      lastReleaseCheck: null,
      provisioningStatus: "active",
      bootstrapStatus: "completed",
      lastProvisioningError: null,
    });
    prismaMock.customerDeployment.update.mockResolvedValueOnce({ id: "shared-1" });
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValueOnce([]);
    global.fetch = vi.fn() as any;

    const result = await probeControlPlaneDeploymentHealth(scopedAgent, {
      deploymentId: "shared-1",
      reason: "Refresh managed workspace health.",
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "shared-1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
        deploymentStatus: "ACTIVE",
      }),
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "HEALTH",
        status: "ok",
        summary: expect.objectContaining({
          probeSkippedReason: "Managed workspace rows use local control-plane state and are not probed as standalone deployment URLs.",
        }),
      }),
    }));
    expect(result.status).toBe("ok");
  });

  it("skips release-drift comparison when probing the backup app", async () => {
    const { probeControlPlaneDeploymentHealth } = await import("./control-plane");
    const scopedAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:releases:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "backup-1",
      label: "Corgtex Internal",
      customerAccountId: "cust-1",
      customerSlug: "corgtex-internal",
      deploymentKind: "INTERNAL",
      url: "https://app.corgtex.com",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      releaseImageTag: "sha-expected",
      releaseVersion: "main-expected",
      lastHealthStatus: null,
      lastHealthError: null,
      lastHealthCheck: null,
      lastWorkerHealthStatus: null,
      lastWorkerHealthCheck: null,
      lastReleaseCheck: null,
      provisioningStatus: "active",
      bootstrapStatus: "completed",
      lastProvisioningError: null,
    });
    prismaMock.customerDeployment.update.mockResolvedValueOnce({ id: "backup-1" });
    prismaMock.customerDeploymentEvent.findMany.mockResolvedValueOnce([]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        database: "up",
        schema: "ready",
        runtime: { redis: "configured", storage: "configured" },
        release: { gitSha: "sha-live-backup" },
      }),
    })) as any;

    const result = await probeControlPlaneDeploymentHealth(scopedAgent, {
      deploymentId: "backup-1",
      reason: "Refresh backup app health.",
    });

    expect(global.fetch).toHaveBeenCalledWith("https://app.corgtex.com/api/health", expect.objectContaining({ method: "GET" }));
    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "backup-1" },
      data: expect.objectContaining({
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
      }),
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "RELEASE",
        status: "ok",
        error: null,
      }),
    }));
    expect(result.status).toBe("ok");
  });

  it("records a verified live release and clears release drift metadata", async () => {
    const { recordVerifiedControlPlaneRelease } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme Production",
      customerAccountId: "cust-1",
      url: "https://customer.test",
      managedWorkspaceId: null,
      managedWorkspace: null,
      supportCredentialEnc: null,
      releaseImageTag: "sha-old",
      releaseVersion: "main-2026-05-15",
      lastHealthStatus: "degraded",
      lastHealthError: "Release drift: expected sha-old, got sha-new",
      lastHealthCheck: new Date("2026-05-20T00:00:00.000Z"),
      lastWorkerHealthStatus: "ok",
      lastWorkerHealthCheck: new Date("2026-05-20T00:00:00.000Z"),
      lastReleaseCheck: new Date("2026-05-20T00:00:00.000Z"),
      provisioningStatus: "degraded",
      bootstrapStatus: "completed",
      lastProvisioningError: null,
    };
    prismaMock.customerDeployment.findUnique
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({
        ...deployment,
        releaseImageTag: "sha-new",
        releaseVersion: "main-2026-05-20",
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
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

    const result = await recordVerifiedControlPlaneRelease(operatorActor, {
      deploymentId: "inst-1",
      releaseImageTag: "sha-new",
      releaseVersion: "main-2026-05-20",
      reason: "Verified live health after recovery deploy.",
    });

    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inst-1" },
      data: expect.objectContaining({
        releaseImageTag: "sha-new",
        releaseVersion: "main-2026-05-20",
        lastHealthStatus: "ok",
        lastHealthError: null,
        provisioningStatus: "active",
        deploymentStatus: "ACTIVE",
      }),
    }));
    expect(prismaMock.customerReleaseTarget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deploymentId_targetReleaseImageTag: {
          deploymentId: "inst-1",
          targetReleaseImageTag: "sha-new",
        },
      },
      update: expect.objectContaining({
        status: "APPLIED",
        targetReleaseVersion: "main-2026-05-20",
      }),
    }));
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.release.verified_recorded",
      }),
    }));
    expect(result).toMatchObject({
      recorded: true,
      releaseImageTag: "sha-new",
      releaseVersion: "main-2026-05-20",
      observedRelease: { gitSha: "sha-new" },
    });
  });

  it("records sanitized post-deploy probe evidence for customer-read surfaces", async () => {
    const { runControlPlanePostDeployProbe } = await import("./control-plane");
    const recentProofAt = new Date(Date.now() - 5 * 60 * 1000);
    const deployment = {
      id: "inst-1",
      label: "Acme Production",
      url: "https://customer.test",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        plan: "ENTERPRISE_MANAGED",
        trialEndsAt: null,
        billingProfile: null,
        _count: { members: 2 },
      },
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncAt: null,
      supportLastSyncError: null,
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue(deployment);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      autoRecordEnabled: false,
      botName: "Corgtex Recorder",
      entryMessage: "Recording for the workspace.",
      monthlyMinuteCap: 6000,
    });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      status: "ACTIVE",
      providerAccountEmail: "calendar@example.com",
      providerAccountId: "calendar-1",
      lastSyncAt: recentRecorderProofDate(),
      lastSyncError: null,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: recentRecorderProofDate(5 * 60 * 1000),
      completedAt: recentRecorderProofDate(6 * 60 * 1000),
    });
    prismaMock.meetingRecording.count.mockResolvedValue(0);
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockResolvedValue([]);
    (prismaMock as any).oAuthConnection = prismaMock.oauthConnection;
    prismaMock.oauthConnection.findMany.mockResolvedValue([]);
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      const toolName = body.params?.name;
      const payload = toolName === "record_support_audit"
        ? { ok: true }
        : toolName === "get_current_connection"
          ? { authKind: "agent", scopes: POST_DEPLOY_REQUIRED_READ_SCOPES }
        : {
            items: [{ id: "private-1", title: "Private customer title", status: "open" }],
            counts: { open: 1 },
          };
      return mcpToolResult(payload);
    }) as any;

    const result = await runControlPlanePostDeployProbe(operatorActor, {
      deploymentId: "inst-1",
      releaseImageTag: "sha-new",
      releaseVersion: "main-sha-new",
      reason: "Post-deploy customer-read probe.",
      requireRemoteSupportAudit: true,
    });

    expect(result.status).toBe("ok");
    expect(result.reads).toHaveLength(6);
    expect(result.reads[0]).toEqual(expect.objectContaining({
      key: "daily_overview",
      status: "ok",
      count: 1,
      counts: { open: 1 },
      statuses: { open: 1 },
    }));
    expect(result.recorder).toEqual(expect.objectContaining({
      status: "ok",
      provider: "RECALL_AI",
      failureCode: null,
    }));
    expect(result.supportConnectorReadiness).toEqual(expect.objectContaining({
      status: "ready",
      requiredScopes: expect.arrayContaining(["execution:read", "brain:read", "meetings:read"]),
      missingScopes: [],
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerAccountId: "cust-1",
        deploymentId: "inst-1",
        snapshotKind: "SUPPORT_READY",
        status: "ok",
        error: null,
      }),
    }));
    const snapshotCall = prismaMock.fleetHealthSnapshot.create.mock.calls.at(-1)?.[0] as any;
    expect(JSON.stringify(snapshotCall.data.summary)).not.toContain("Private customer title");
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.post_deploy_probe_completed",
      }),
    }));
  });

  it("marks post-deploy probes failed when recorder readiness exposes a credit failure", async () => {
    const { runControlPlanePostDeployProbe } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme Production",
      url: "https://customer.test",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        plan: "ENTERPRISE_MANAGED",
        trialEndsAt: null,
        billingProfile: null,
        _count: { members: 2 },
      },
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncAt: null,
      supportLastSyncError: null,
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue(deployment);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      autoRecordEnabled: false,
      botName: "Corgtex Recorder",
      entryMessage: "Recording for the workspace.",
      monthlyMinuteCap: 6000,
    });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      status: "ACTIVE",
      providerAccountEmail: "calendar@example.com",
      providerAccountId: "calendar-1",
      lastSyncAt: recentRecorderProofDate(),
      lastSyncError: null,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      status: "FAILED",
      failureCode: "insufficient_credit_balance",
      createdAt: recentRecorderProofDate(5 * 60 * 1000),
    });
    prismaMock.meetingRecording.count.mockResolvedValue(1);
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockResolvedValue([]);
    (prismaMock as any).oAuthConnection = prismaMock.oauthConnection;
    prismaMock.oauthConnection.findMany.mockResolvedValue([]);
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      const toolName = body.params?.name;
      return mcpToolResult(toolName === "get_current_connection"
        ? { authKind: "agent", scopes: POST_DEPLOY_REQUIRED_READ_SCOPES }
        : { items: [] });
    }) as any;

    const result = await runControlPlanePostDeployProbe(operatorActor, {
      deploymentId: "inst-1",
      releaseImageTag: "sha-new",
      releaseVersion: "main-sha-new",
      reason: "Post-deploy customer-read probe.",
    });

    expect(result.status).toBe("failed");
    expect(result.recorder).toEqual(expect.objectContaining({
      status: "failed",
      failureCode: "insufficient_credit_balance",
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "SUPPORT_READY",
        status: "failed",
        error: "recorder:insufficient_credit_balance",
      }),
    }));
  });

  it("derives customer-read probe scopes from MCP tool capabilities", async () => {
    const {
      getRequiredScopesForPostDeployReadProbe,
      getRequiredScopesForPostDeployReadProbes,
      POST_DEPLOY_CUSTOMER_READ_PROBES,
    } = await import("./post-deploy-probe-contract");

    expect(POST_DEPLOY_CUSTOMER_READ_PROBES.map((probe) => probe.key)).toEqual([
      "daily_overview",
      "brain_context",
      "actions",
      "tensions",
      "meetings",
      "proposals",
    ]);
    for (const probe of POST_DEPLOY_CUSTOMER_READ_PROBES) {
      expect(getRequiredScopesForPostDeployReadProbe(probe).length).toBeGreaterThan(0);
    }
    expect(getRequiredScopesForPostDeployReadProbes()).toEqual(expect.arrayContaining([
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
      "execution:read",
      "brain:read",
    ]));
  });

  it("reports exact missing support connector scopes before marking post-deploy probes green", async () => {
    const { runControlPlanePostDeployProbe } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme Production",
      url: "https://customer.test",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        plan: "ENTERPRISE_MANAGED",
        trialEndsAt: null,
        billingProfile: null,
        _count: { members: 2 },
      },
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncAt: null,
      supportLastSyncError: null,
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue(deployment);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      autoRecordEnabled: false,
      botName: "Corgtex Recorder",
      entryMessage: "Recording for the workspace.",
      monthlyMinuteCap: 6000,
    });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      status: "ACTIVE",
      providerAccountEmail: "calendar@example.com",
      providerAccountId: "calendar-1",
      lastSyncAt: recentRecorderProofDate(),
      lastSyncError: null,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: recentRecorderProofDate(5 * 60 * 1000),
      completedAt: recentRecorderProofDate(6 * 60 * 1000),
    });
    prismaMock.meetingRecording.count.mockResolvedValue(0);
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockResolvedValue([]);
    (prismaMock as any).oAuthConnection = prismaMock.oauthConnection;
    prismaMock.oauthConnection.findMany.mockResolvedValue([]);
    const scopesWithoutExecution = POST_DEPLOY_REQUIRED_READ_SCOPES.filter((scope) => scope !== "execution:read");
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      const toolName = body.params?.name;
      const payload = toolName === "get_current_connection"
        ? { authKind: "agent", scopes: scopesWithoutExecution }
        : toolName === "get_company_context"
          ? { text: "MCP credential is missing the required scope: execution:read (Read execution packets)." }
          : { items: [] };
      return mcpToolResult(payload);
    }) as any;

    const result = await runControlPlanePostDeployProbe(operatorActor, {
      deploymentId: "inst-1",
      releaseImageTag: "sha-new",
      releaseVersion: "main-sha-new",
      reason: "Post-deploy customer-read probe.",
    });

    expect(result.status).toBe("failed");
    expect(result.supportConnectorReadiness).toEqual(expect.objectContaining({
      status: "missing_scope",
      missingScopes: ["execution:read"],
    }));
    expect(result.reads.find((probe) => probe.key === "brain_context")).toEqual(expect.objectContaining({
      status: "failed",
      errorClass: "MISSING_SUPPORT_SCOPE",
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "SUPPORT_READY",
        status: "failed",
        error: "support_connector:MISSING_SUPPORT_SCOPE",
      }),
    }));
  });

  it("classifies unknown post-deploy remote support scope failures as auth or scope errors", async () => {
    const { runControlPlanePostDeployProbe } = await import("./control-plane");
    const deployment = {
      id: "inst-1",
      label: "Acme Production",
      url: "https://customer.test",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      managedWorkspaceId: "ws-1",
      managedWorkspace: {
        id: "ws-1",
        slug: "acme",
        name: "Acme",
        plan: "ENTERPRISE_MANAGED",
        trialEndsAt: null,
        billingProfile: null,
        _count: { members: 2 },
      },
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
      supportLastSyncAt: null,
      supportLastSyncError: null,
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue(deployment);
    prismaMock.workspaceFeatureFlag.findUnique.mockResolvedValue({ enabled: true });
    prismaMock.workspaceMeetingRecorderConfig.findUnique.mockResolvedValue({
      enabled: true,
      defaultProvider: "RECALL_AI",
      fallbackProvider: null,
      autoRecordEnabled: false,
      botName: "Corgtex Recorder",
      entryMessage: "Recording for the workspace.",
      monthlyMinuteCap: 6000,
    });
    prismaMock.workspaceRecorderCalendarSource.findUnique.mockResolvedValue({
      status: "ACTIVE",
      providerAccountEmail: "calendar@example.com",
      providerAccountId: "calendar-1",
      lastSyncAt: recentRecorderProofDate(),
      lastSyncError: null,
    });
    prismaMock.workflowJob.count.mockResolvedValue(0);
    prismaMock.meetingRecorderSmokeRun.findFirst.mockResolvedValue({
      id: "smoke-1",
      status: "COMPLETED",
      provider: "RECALL_AI",
      createdAt: recentRecorderProofDate(5 * 60 * 1000),
      completedAt: recentRecorderProofDate(6 * 60 * 1000),
    });
    prismaMock.meetingRecording.count.mockResolvedValue(0);
    prismaMock.communicationInstallation.findMany.mockResolvedValue([]);
    prismaMock.externalDataSource.findMany.mockResolvedValue([]);
    (prismaMock as any).oAuthConnection = prismaMock.oauthConnection;
    prismaMock.oauthConnection.findMany.mockResolvedValue([]);
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      const toolName = body.params?.name;
      const payload = toolName === "record_support_audit"
        ? { ok: true }
        : toolName === "get_current_connection"
          ? { authKind: "agent", scopes: POST_DEPLOY_REQUIRED_READ_SCOPES }
        : toolName === "get_company_context"
          ? { text: "Missing required permission: support:write." }
          : { items: [] };
      return mcpToolResult(payload);
    }) as any;

    const result = await runControlPlanePostDeployProbe(operatorActor, {
      deploymentId: "inst-1",
      releaseImageTag: "sha-new",
      releaseVersion: "main-sha-new",
      reason: "Post-deploy customer-read probe.",
    });

    expect(result.status).toBe("failed");
    expect(result.reads.find((probe) => probe.key === "brain_context")).toEqual(expect.objectContaining({
      status: "failed",
      errorClass: "REMOTE_AUTH_OR_SCOPE",
    }));
    expect(result.supportConnectorReadiness).toEqual(expect.objectContaining({
      status: "ready",
      missingScopes: [],
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "SUPPORT_READY",
        status: "failed",
        error: "brain_context:REMOTE_AUTH_OR_SCOPE",
      }),
    }));
  });

  it("requires control-plane support write scope for standalone customer support audits", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    const readOnlyAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read"],
    };

    await expect(recordCustomerSupportAudit(readOnlyAgent, {
      deploymentId: "inst-1",
      action: "finance_v2.closeout",
      reason: "Record sanitized closeout.",
      summary: "Finance closeout verified.",
    })).rejects.toMatchObject({
      status: 403,
      code: "CONTROL_PLANE_SCOPE_REQUIRED",
    });
    prismaMock.customerDeploymentAccess.findUnique.mockResolvedValueOnce({ role: "SUPPORT_VIEWER", isActive: true });
    await expect(recordCustomerSupportAudit(userActor, { deploymentId: "inst-1", ...SUPPORT_AUDIT_PARAMS })).rejects.toMatchObject({ status: 403, code: "CONTROL_PLANE_WRITE_ACCESS_REQUIRED" });
    expect(prismaMock.customerDeployment.findUnique).not.toHaveBeenCalled();
  });

  it("validates standalone support audit action and sanitized evidence schema", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      action: "Finance V2 Closeout",
      reason: "Record sanitized closeout.",
      summary: "Finance closeout verified.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      evidence: { rawLogs: "Do not accept raw logs in support audit evidence." },
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      evidence: { raw_log: "Do not accept raw logs in support audit evidence." },
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      evidence: { transcriptText: "Do not accept transcript evidence." },
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    await expect(recordCustomerSupportAudit(operatorActor, { deploymentId: "inst-1", ...SUPPORT_AUDIT_PARAMS, evidence: { detail: "Authorization: Bearer fixture-token-value" } })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(recordCustomerSupportAudit(operatorActor, { deploymentId: "inst-1", ...SUPPORT_AUDIT_PARAMS, summary: "Authorization: Bearer fixture-token-value" })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    await expect(recordCustomerSupportAudit(operatorActor, { deploymentId: "inst-1", ...SUPPORT_AUDIT_PARAMS, reason: "token=fixture-token-value" })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      action: "record_support_audit",
      reason: "Record sanitized closeout.",
      summary: "Finance closeout verified.",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      idempotencyKey: "x".repeat(201),
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      idempotencyKey: "Authorization: Bearer fixture-token-value",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    await expect(recordCustomerSupportAudit(operatorActor, { deploymentId: "inst-1", ...SUPPORT_AUDIT_PARAMS, reason: "x".repeat(1001) })).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      evidence: {
        aggregate: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => ["summarized"])),
      },
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce(supportAuditDeployment({ remoteWorkspaceId: "remote-ws-1" }));
    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      remoteWorkspaceId: "stale-remote-ws",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
  });

  it("keeps direct record_support_audit out of the generic support runner", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");

    await expect(runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "record_support_audit" as never,
      reason: "Attempt passthrough.",
      arguments: {},
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("records a standalone customer support audit and redacts central evidence", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    const supportWriteOnlyAgent: AppActor = {
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:support:write"],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue(supportAuditDeployment({
      managedWorkspaceId: "ws-1",
      remoteWorkspaceId: "remote-ws-1",
    }));
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-audit",
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      status: "RUNNING",
      idempotencyKey: "closeout-key",
    });
    prismaMock.supportOperation.update.mockImplementationOnce(async (args: any) => ({
      id: args.where.id,
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      status: args.data.status,
      resultSummary: args.data.resultSummary,
    }));
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.params).toEqual({
        name: "record_support_audit",
        arguments: {
          action: "support.audit.finance_v2.closeout",
          reason: SUPPORT_AUDIT_PARAMS.reason,
          operationId: "op-audit",
          phase: "completed",
          result: {
            schemaVersion: 1,
            action: SUPPORT_AUDIT_PARAMS.action,
            outcome: "completed",
            summary: SUPPORT_AUDIT_PARAMS.summary,
            evidence: {
              releaseSha: "f17a07b1c11e27f56abaedd48ded860309084063", apiKey: "[redacted]",
              credentials: "[redacted]", awsCredentials: "[redacted]",
              nested: [{ private_key: "[redacted]" }],
              nestedArray: [["completed", "sanitized"]], supportCredential: "[redacted]",
            },
          },
        },
      });
      return mcpToolResult({ id: "remote-audit", operationId: "op-audit", bearerToken: "fixture-value" });
    }) as any;

    const result = await recordCustomerSupportAudit(supportWriteOnlyAgent, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      outcome: "completed",
      evidence: {
        releaseSha: "f17a07b1c11e27f56abaedd48ded860309084063", apiKey: "fixture-value",
        credentials: "fixture-value", awsCredentials: "fixture-value",
        nested: [{ private_key: "fixture-value" }],
        nestedArray: [["completed", "sanitized"]], supportCredential: "fixture-value",
      },
      remoteWorkspaceId: "remote-ws-1",
      idempotencyKey: "closeout-key",
    });

    expect(decryptSecretMock).toHaveBeenCalledWith("encrypted-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "support.audit.finance_v2.closeout",
        reason: SUPPORT_AUDIT_PARAMS.reason,
        status: "RUNNING",
        workspaceId: "ws-1",
        idempotencyKey: "closeout-key",
        inputSummary: expect.objectContaining({
          remoteWorkspaceId: "remote-ws-1",
          evidence: {
            releaseSha: "f17a07b1c11e27f56abaedd48ded860309084063", apiKey: "[redacted]",
            credentials: "[redacted]", awsCredentials: "[redacted]",
            nested: [{ private_key: "[redacted]" }],
            nestedArray: [["completed", "sanitized"]], supportCredential: "[redacted]",
          },
        }),
      }),
    }));
    expect(prismaMock.supportOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "op-audit" },
      data: expect.objectContaining({
        status: "COMPLETED",
        resultSummary: expect.objectContaining({
          remoteAudit: {
            id: "remote-audit",
            operationId: "op-audit",
          },
        }),
      }),
    }));
    expect(result).toMatchObject({ id: "op-audit", status: "COMPLETED" });
  });

  it("returns existing standalone support audit operations by idempotency key", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValue(supportAuditDeployment({ supportCredential: null, supportConnectorStatus: "disconnected" }));
    prismaMock.supportOperation.findUnique.mockResolvedValueOnce({
      id: "op-existing",
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      reason: SUPPORT_AUDIT_PARAMS.reason,
      status: "COMPLETED",
      inputSummary: supportAuditInputSummary(),
      idempotencyKey: "closeout-key",
    });

    const result = await recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      idempotencyKey: "closeout-key",
    });

    expect(result).toMatchObject({
      id: "op-existing",
      idempotentReplay: true,
    });
    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
    expect(decryptSecretMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects idempotency replays with changed standalone support audit payloads", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValue(supportAuditDeployment());
    prismaMock.supportOperation.findUnique.mockResolvedValueOnce({
      id: "op-existing",
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      reason: SUPPORT_AUDIT_PARAMS.reason,
      status: "COMPLETED",
      inputSummary: supportAuditInputSummary({
        summary: "Earlier closeout evidence.",
      }),
      idempotencyKey: "closeout-key",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      idempotencyKey: "closeout-key",
    })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not replay failed standalone support audits by idempotency key", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    const inputSummary = supportAuditInputSummary();
    prismaMock.customerDeployment.findUnique.mockResolvedValue(supportAuditDeployment());
    prismaMock.supportOperation.findUnique.mockResolvedValueOnce({
      id: "op-audit",
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      reason: SUPPORT_AUDIT_PARAMS.reason,
      status: "FAILED",
      inputSummary,
      idempotencyKey: "closeout-key",
    });

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
      idempotencyKey: "closeout-key",
    })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_NOT_REPLAYABLE",
    });

    expect(prismaMock.supportOperation.create).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stores failed central evidence when remote support audit recording fails", async () => {
    const { recordCustomerSupportAudit } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValue(supportAuditDeployment());
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-audit",
      deploymentId: "inst-1",
      action: "support.audit.finance_v2.closeout",
      status: "RUNNING",
    });
    prismaMock.supportOperation.update.mockResolvedValueOnce({
      id: "op-audit",
      status: "FAILED",
    });
    global.fetch = vi.fn(async () => mcpToolResult("Customer audit write failed. Authorization: Bearer fixture-token-value", true)) as any;

    await expect(recordCustomerSupportAudit(operatorActor, {
      deploymentId: "inst-1",
      ...SUPPORT_AUDIT_PARAMS,
    })).rejects.toMatchObject({
      status: 502,
      code: "REMOTE_SUPPORT_OPERATION_FAILED",
    });

    expect(prismaMock.supportOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "op-audit" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "Remote support audit failed with redacted detail.",
      }),
    }));
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

  it("routes remote meeting, recorder, and Finance support operations through audited MCP tools", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValue({
      id: "op-recorder",
      action: "meeting_recorders.schedule_meeting",
    });
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      url: "https://customer.test",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
    });
    prismaMock.supportOperation.update.mockResolvedValue({
      id: "op-recorder",
      status: "COMPLETED",
    });

    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meetings.schedule",
      reason: "Production validation temporary Corgtex meeting.",
      arguments: {
        title: "PROD-VERIFY 2026-07-20 PR-753",
        startsAt: "2099-07-20T06:30:00.000Z",
        scheduledEndAt: "2099-07-20T07:00:00.000Z",
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/private",
      },
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meeting_recorders.schedule_meeting",
      reason: "Schedule recorder for validation meeting.",
      arguments: { meetingId: "meeting-1", provider: "RECALL_AI" },
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meeting_recorders.cancel",
      reason: "Cleanup validation recorder.",
      arguments: { meetingId: "meeting-1" },
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meetings.archive",
      reason: "Cleanup validation meeting.",
      arguments: { meetingId: "meeting-1" },
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meeting_recorders.set_auto_recording",
      reason: "Customer approved recorder coverage policy.",
      arguments: { enabled: true },
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "meeting_recorders.ensure_coverage",
      reason: "Ensure recurring recorder coverage after policy update.",
      arguments: {},
    });
    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "finance.readiness",
      arguments: {},
    });
    const toolNames = vi.mocked(fetch).mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)).params?.name)
      .filter((name) => name !== "record_support_audit");
    expect(toolNames).toEqual([
      "create_scheduled_meeting",
      "schedule_meeting_recording",
      "cancel_meeting_recording",
      "delete_meeting",
      "set_meeting_recorder_auto_recording",
      "ensure_meeting_recorder_coverage",
      "get_finance_readiness",
    ]);
  });

  it("fails support operations when the remote MCP returns a scope error as text", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-scope",
      action: "feature_flags.set",
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
      id: "op-scope",
      status: "FAILED",
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify({ audited: true }) }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            content: [{
              type: "text",
              text: "MCP credential is missing the required scope: workspace:write.",
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify({ audited: true }) }] } }),
      }) as any;

    await expect(runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "feature_flags.set",
      reason: "Enable feature flag.",
      arguments: {
        flag: "AGENT_GOVERNANCE",
        enabled: true,
      },
    })).rejects.toMatchObject({
      status: 502,
      code: "REMOTE_SUPPORT_OPERATION_FAILED",
    });

    expect(prismaMock.supportOperation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "op-scope" },
      data: expect.objectContaining({
        status: "FAILED",
        error: expect.stringContaining("workspace:write"),
      }),
    }));
  });

  it("runs the support proposal reopen repair through the audited connector", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-proposals",
      action: "proposals.reopen_resolved",
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
      id: "op-proposals",
      status: "COMPLETED",
    });

    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "proposals.reopen_resolved",
      reason: "Undo accidental system auto-resolution.",
      arguments: {
        proposalIds: ["proposal-1", "proposal-2"],
      },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    const toolCall = vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(toolCall.body))).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        name: "support_reopen_resolved_proposals",
        arguments: {
          proposalIds: ["proposal-1", "proposal-2"],
          reason: "Undo accidental system auto-resolution.",
        },
      }),
    }));
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "proposals.reopen_resolved",
        inputSummary: expect.objectContaining({
          proposalIds: ["proposal-1", "proposal-2"],
          reason: "Undo accidental system auto-resolution.",
        }),
      }),
    }));
  });

  it("routes newspaper diagnostics through the audited support connector as a read-only operation", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-newspaper",
      action: "newspaper.diagnostics",
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
      id: "op-newspaper",
      status: "COMPLETED",
    });

    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "newspaper.diagnostics",
      reason: "Inspect newsletter schedule and source counts after release.",
      arguments: { take: 5 },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const toolCall = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(toolCall.body))).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        name: "get_newspaper_diagnostics",
        arguments: { take: 5 },
      }),
    }));
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "newspaper.diagnostics",
        inputSummary: { take: 5 },
      }),
    }));
  });

  it("includes newspaper diagnostics in support-ready snapshots without degrading attention alerts", async () => {
    const { fetchCustomerSupportSnapshot } = await import("./control-plane");
    const deliveryAlert = {
      state: "attention",
      reason: "failed-delivery",
      latestRunKey: "daily:2026-07-10",
      latestRunAt: "2026-07-10T12:00:00.000Z",
      failedCount: 1,
      skippedAttentionCount: 0,
      providerFailureCount: 0,
      affectedRecipients: [
        {
          id: "delivery-1",
          runKey: "daily:2026-07-10",
          status: "FAILED",
          createdAt: "2026-07-10T12:00:00.000Z",
          recipientEmail: "member@example.com",
          error: "Resend API key is not configured.",
        },
      ],
    };
    prismaMock.customerDeployment.findUnique.mockResolvedValue({
      id: "inst-1",
      label: "Acme",
      url: "https://customer.test",
      customerSlug: "acme",
      customerAccountId: "cust-1",
      deploymentKind: "REMOTE_MANAGED",
      deploymentStatus: "ACTIVE",
      supportMcpUrl: "https://customer.test/api/mcp",
      supportCredentialEnc: "encrypted-token",
      supportConnectorStatus: "connected",
    });
    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const toolName = body?.params?.name;
      if (toolName === "get_newspaper_diagnostics") {
        return mcpToolResult({ diagnostics: { deliveryAlert } });
      }
      return mcpToolResult({ items: [] });
    }) as any;

    const result = await fetchCustomerSupportSnapshot(operatorActor, "inst-1") as any;

    expect(result.newspaperDiagnostics).toEqual({ diagnostics: { deliveryAlert } });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).params.name)).toContain("get_newspaper_diagnostics");
    expect(prismaMock.customerDeployment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inst-1" },
      data: expect.objectContaining({
        supportConnectorStatus: "connected",
        supportLastSyncError: null,
      }),
    }));
    expect(prismaMock.fleetHealthSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        snapshotKind: "SUPPORT_READY",
        status: "ok",
        error: null,
        summary: expect.objectContaining({
          newspaperDiagnostics: { diagnostics: { deliveryAlert } },
        }),
      }),
    }));
  });

  it("routes context map imports through the audited support connector", async () => {
    const { runCustomerSupportOperation } = await import("./control-plane");
    prismaMock.supportOperation.create.mockResolvedValueOnce({
      id: "op-context-map",
      action: "context_graph.import_map",
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
      id: "op-context-map",
      status: "COMPLETED",
    });

    await runCustomerSupportOperation(operatorActor, {
      deploymentId: "inst-1",
      action: "context_graph.import_map",
      reason: "Import approved critical-path map from support scorecard.",
      arguments: {
        name: "CRNA Critical Path",
        objects: [{ ref: "process", objectType: "Process", title: "CR North America critical path" }],
      },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    const toolCall = vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(toolCall.body))).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        name: "import_context_graph_map",
        arguments: expect.objectContaining({
          name: "CRNA Critical Path",
          objects: [{ ref: "process", objectType: "Process", title: "CR North America critical path" }],
        }),
      }),
    }));
    expect(prismaMock.supportOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "context_graph.import_map",
        inputSummary: expect.objectContaining({
          name: "CRNA Critical Path",
        }),
      }),
    }));
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

  it("saves Control Plane Slack OAuth into the managed workspace and records audit", async () => {
    const { saveControlPlaneSlackInstallation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 1 } },
      supportCredentialEnc: null,
    });

    const result = await saveControlPlaneSlackInstallation(operatorActor, {
      deploymentId: "inst-1",
      oauthResponse: { ok: true, team: { id: "T1", name: "Acme Slack" }, access_token: "xoxb-token" } as never,
      reason: "Customer approved Slack connection.",
    });

    expect(communicationMocks.saveSlackInstallationForWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      oauthResponse: { ok: true, team: { id: "T1", name: "Acme Slack" }, access_token: "xoxb-token" },
      installedByUserId: "operator-1",
      expectedTeamId: undefined,
    });
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deploymentId: "inst-1",
        action: "control_plane.integration.slack_connected",
        meta: expect.objectContaining({
          reason: "Customer approved Slack connection.",
          managedWorkspaceId: "ws-1",
          installationId: "slack-1",
        }),
      }),
    }));
    expect(result).toMatchObject({ deploymentId: "inst-1", managedWorkspaceId: "ws-1" });
  });

  it("updates Control Plane Slack agenda settings after channel validation and records audit", async () => {
    const { updateControlPlaneSlackAgendaSettings } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 1 } },
      supportCredentialEnc: null,
    });
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "slack-1",
      workspaceId: "ws-1",
      provider: "SLACK",
      status: "ACTIVE",
      settings: { rawRetentionDays: 30 },
    });
    prismaMock.communicationInstallation.update.mockResolvedValueOnce({ id: "slack-1", settings: { defaultAgendaChannelId: "C123" } });

    await updateControlPlaneSlackAgendaSettings(operatorActor, {
      deploymentId: "inst-1",
      installationId: "slack-1",
      defaultAgendaChannelId: "C123",
      agendaTimezone: "America/Los_Angeles",
      reason: "Customer approved agenda posting.",
    });

    expect(communicationMocks.validateSlackPostTarget).toHaveBeenCalledWith("slack-1", "C123");
    expect(prismaMock.communicationInstallation.update).toHaveBeenCalledWith({
      where: { id: "slack-1" },
      data: {
        settings: expect.objectContaining({
          rawRetentionDays: 30,
          defaultAgendaChannelId: "C123",
          defaultAgendaChannelName: "ops",
          agendaTimezone: "America/Los_Angeles",
        }),
      },
    });
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.slack_settings_updated",
        meta: expect.objectContaining({
          reason: "Customer approved agenda posting.",
          defaultAgendaChannelId: "C123",
          defaultAgendaChannelName: "ops",
        }),
      }),
    }));
  });

  it("disconnects managed Slack installations through Control Plane and records audit", async () => {
    const { disconnectControlPlaneSlackInstallation } = await import("./control-plane");
    prismaMock.customerDeployment.findUnique.mockResolvedValueOnce({
      id: "inst-1",
      label: "Acme",
      managedWorkspaceId: "ws-1",
      managedWorkspace: { id: "ws-1", slug: "acme", name: "Acme", _count: { members: 1 } },
      supportCredentialEnc: null,
    });
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "slack-1",
      workspaceId: "ws-1",
      provider: "SLACK",
      status: "ACTIVE",
      externalWorkspaceId: "T1",
      externalTeamName: "Acme Slack",
    });
    prismaMock.communicationInstallation.update.mockResolvedValueOnce({ id: "slack-1", status: "DISCONNECTED" });

    await disconnectControlPlaneSlackInstallation(operatorActor, {
      deploymentId: "inst-1",
      installationId: "slack-1",
      reason: "Customer requested disconnect.",
    });

    expect(prismaMock.communicationInstallation.update).toHaveBeenCalledWith({
      where: { id: "slack-1" },
      data: expect.objectContaining({
        status: "DISCONNECTED",
        botTokenEnc: null,
        disconnectedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.customerDeploymentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "control_plane.integration.slack_disconnected",
        meta: expect.objectContaining({
          reason: "Customer requested disconnect.",
          externalWorkspaceId: "T1",
          team: "Acme Slack",
        }),
      }),
    }));
  });
});
