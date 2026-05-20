import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  listControlPlaneDeployments: vi.fn(),
  requireControlPlaneAccess: vi.fn(),
  requireControlPlaneScope: vi.fn((actor: { kind?: string; scopes?: string[] }, scope: string) => {
    if (actor.kind !== "agent") return;
    const scopes = new Set(actor.scopes ?? ["control-plane:read"]);
    if (scopes.has("control-plane:*") || scopes.has(scope)) return;
    const error = new Error(`Control Plane scope required: ${scope}.`) as Error & { status: number; code: string };
    error.status = 403;
    error.code = "CONTROL_PLANE_SCOPE_REQUIRED";
    throw error;
  }),
  resolveControlPlaneRequestActor: vi.fn(),
}));
vi.mock("@corgtex/domain", () => ({
  configureControlPlaneMeetingRecorderIntegration: vi.fn(), createControlPlaneCustomerMember: vi.fn(), deployLatestControlPlaneRelease: vi.fn(),
  enqueueControlPlaneDeployLatestRollout: vi.fn(), enqueueControlPlaneFleetSnapshots: vi.fn(), fetchCustomerSupportSnapshot: vi.fn(),
  getControlPlaneDeployLatestPreflight: vi.fn(),
  getControlPlaneAiGovernanceStatus: vi.fn(), getControlPlaneContextHealth: vi.fn(),
  getControlPlaneDeployment: vi.fn(), getControlPlaneIntegrationStatus: vi.fn(), getControlPlaneReleaseStatus: vi.fn(),
  listControlPlaneCustomerMembers: vi.fn(),
  listControlPlaneDeployments: mocks.listControlPlaneDeployments,
  listControlPlaneFeatureFlags: vi.fn(), listControlPlaneReleaseRolloutJobs: vi.fn(),
  probeControlPlaneDeploymentHealth: vi.fn(),
  requireControlPlaneAccess: mocks.requireControlPlaneAccess,
  requireControlPlaneScope: mocks.requireControlPlaneScope,
  refreshControlPlaneFleetSnapshots: vi.fn(),
  revokeControlPlaneAgentCredential: vi.fn(),
  resendControlPlaneCustomerMemberAccessLink: vi.fn(), runControlPlaneContextOperation: vi.fn(), runControlPlaneMeetingRecorderOperation: vi.fn(), runControlPlaneReleaseOperation: vi.fn(), runCustomerSupportOperation: vi.fn(),
  setControlPlaneFeatureFlag: vi.fn(), updateControlPlaneAgentCredentialScopes: vi.fn(), updateControlPlaneAgentPolicy: vi.fn(), updateControlPlaneCustomerMemberStatus: vi.fn(), updateControlPlaneModelBudget: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ resolveControlPlaneRequestActor: mocks.resolveControlPlaneRequestActor }));
vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({ error: { code: error.code ?? "INTERNAL_ERROR", message: error.message } }, { status: error.status ?? 500 }),
}));
function request(body: unknown) {
  return new Request("http://localhost/api/control-plane/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("/api/control-plane/mcp", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.clearAllMocks();
    mocks.resolveControlPlaneRequestActor.mockResolvedValue({ kind: "agent", authProvider: "control-plane", label: "control-plane-agent", scopes: ["control-plane:read"] });
    mocks.requireControlPlaneAccess.mockResolvedValue({ role: "OPERATOR" });
    mocks.listControlPlaneDeployments.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not expose MCP tools outside the dedicated control-plane deployment", async () => {
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    const { POST } = await import("./route");

    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as never);

    expect(response.status).toBe(404);
    expect(mocks.resolveControlPlaneRequestActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONTROL_PLANE_NOT_AVAILABLE",
        message: "Use the dedicated Ops control plane for control-plane operations.",
      },
    });
  });

  it("lists the governed control-plane tool surface", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as never);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_customers",
      "get_customer_deployment_status",
      "refresh_customer_deployment_snapshot",
      "list_customer_integrations",
      "get_context_health",
      "get_ai_governance_status",
      "update_customer_agent_credential_scopes",
      "revoke_customer_agent_credential",
      "update_customer_model_budget",
      "update_customer_agent_policy",
      "get_release_status",
      "get_deploy_latest_preflight",
      "list_customer_members",
      "create_customer_member",
      "resend_customer_member_access_link",
      "update_customer_member_status",
      "list_customer_feature_flags",
      "set_customer_feature_flag",
      "configure_customer_integration",
      "run_meeting_recorder_operation",
      "run_context_sync",
      "probe_customer_deployment_health",
      "refresh_fleet_snapshots",
      "enqueue_fleet_snapshot_jobs",
      "prepare_release_upgrade",
      "deploy_latest_release",
      "deploy_latest_release_bulk",
      "get_rollout_status",
      "run_customer_support_operation",
    ]);
  });
  it("denies mutating tools when the control-plane agent only has read scope", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_context_sync", arguments: { deploymentId: "inst-1", reason: "repair" } } }) as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "CONTROL_PLANE_SCOPE_REQUIRED", message: "Control Plane scope required: control-plane:context:write." } });
  });

  it("denies AI governance writes when the control-plane agent lacks the governance write scope", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "update_customer_model_budget",
        arguments: {
          deploymentId: "inst-1",
          monthlyCostCapUsd: 250,
          reason: "Customer approved model cap.",
        },
      },
    }) as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONTROL_PLANE_SCOPE_REQUIRED",
        message: "Control Plane scope required: control-plane:ai-governance:write.",
      },
    });
  });

  it("rejects AI governance credential updates unless scopes is an array of strings", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:ai-governance:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "update_customer_agent_credential_scopes",
        arguments: {
          deploymentId: "inst-1",
          credentialId: "cred-1",
          scopes: "workspace:read",
          reason: "Reduce scope.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 10,
      error: { code: -32602, message: "scopes must be an array of strings." },
    });
    expect(vi.mocked(domain.updateControlPlaneAgentCredentialScopes)).not.toHaveBeenCalled();
  });

  it("calls the AI governance model budget mutation with the write-scoped actor", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:ai-governance:write"],
    });
    const domain = await import("@corgtex/domain");
    vi.mocked(domain.updateControlPlaneModelBudget).mockResolvedValueOnce({
      deploymentId: "inst-1",
      source: "managed_workspace",
      budget: { id: "budget-1", monthlyCostCapUsd: "250.00" },
    } as never);
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "update_customer_model_budget",
        arguments: {
          deploymentId: "inst-1",
          monthlyCostCapUsd: 250,
          alertThresholdPct: 75,
          reason: "Customer approved model cap.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      deploymentId: "inst-1",
      source: "managed_workspace",
    });
    expect(vi.mocked(domain.updateControlPlaneModelBudget)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        deploymentId: "inst-1",
        monthlyCostCapUsd: 250,
        alertThresholdPct: 75,
        periodStartDay: null,
        reason: "Customer approved model cap.",
      },
    );
  });

  it("rejects member status updates without an explicit boolean isActive value", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:access:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "update_customer_member_status",
        arguments: { deploymentId: "inst-1", memberId: "member-1", reason: "Suspend stale access." },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "isActive must be a boolean." },
    });
    expect(vi.mocked(domain.updateControlPlaneCustomerMemberStatus)).not.toHaveBeenCalled();
  });

  it("rejects member creation without an explicit role value", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:access:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "create_customer_member",
        arguments: {
          deploymentId: "inst-1",
          email: "new@example.com",
          reason: "Customer approved onboarding.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32602, message: "role must be a non-empty string." },
    });
    expect(vi.mocked(domain.createControlPlaneCustomerMember)).not.toHaveBeenCalled();
  });

  it("rejects feature flag mutations without an explicit boolean enabled value", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:features:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "set_customer_feature_flag",
        arguments: { deploymentId: "inst-1", flag: "FINANCE", reason: "Enable finance." },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "enabled must be a boolean." },
    });
    expect(vi.mocked(domain.setControlPlaneFeatureFlag)).not.toHaveBeenCalled();
  });

  it("passes feature flag config through control-plane MCP mutations", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:features:write"],
    });
    const domain = await import("@corgtex/domain");
    vi.mocked(domain.setControlPlaneFeatureFlag).mockResolvedValueOnce({
      deploymentId: "inst-1",
      flag: "SLACK_MEETING_ACTION_REVIEW",
      enabled: true,
    } as never);
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "set_customer_feature_flag",
        arguments: {
          deploymentId: "inst-1",
          flag: "SLACK_MEETING_ACTION_REVIEW",
          enabled: true,
          config: {
            channelId: "C123",
            meetingSeriesExternalId: "ops:weekly-progress-review",
          },
          reason: "Enable customer Slack meeting action review.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    expect(vi.mocked(domain.setControlPlaneFeatureFlag)).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      deploymentId: "inst-1",
      flag: "SLACK_MEETING_ACTION_REVIEW",
      enabled: true,
      config: {
        channelId: "C123",
        meetingSeriesExternalId: "ops:weekly-progress-review",
      },
      reason: "Enable customer Slack meeting action review.",
    }));
  });

  it("rejects integration configuration without explicit boolean toggles", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "configure_customer_integration",
        arguments: {
          deploymentId: "inst-1",
          integrationKey: "meeting_recorders",
          reason: "Enable recorder entitlement.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32602, message: "entitlementEnabled must be a boolean." },
    });
    expect(vi.mocked(domain.configureControlPlaneMeetingRecorderIntegration)).not.toHaveBeenCalled();
  });

  it("rejects timezone-less meeting recorder smoke timestamps", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "run_meeting_recorder_operation",
        arguments: {
          deploymentId: "inst-1",
          operation: "live_smoke",
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/test",
          joinAt: "2026-05-12T15:30",
          reason: "Run live smoke.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "joinAt must include an explicit timezone offset or Z." },
    });
    expect(vi.mocked(domain.runControlPlaneMeetingRecorderOperation)).not.toHaveBeenCalled();
  });

  it("rejects overflowed meeting recorder smoke timestamps", async () => {
    mocks.resolveControlPlaneRequestActor.mockResolvedValueOnce({
      kind: "agent",
      authProvider: "control-plane",
      label: "control-plane-agent",
      scopes: ["control-plane:read", "control-plane:integrations:write"],
    });
    const domain = await import("@corgtex/domain");
    const { POST } = await import("./route");

    const response = await POST(request({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "run_meeting_recorder_operation",
        arguments: {
          deploymentId: "inst-1",
          operation: "live_smoke",
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/test",
          joinAt: "2026-02-31T10:00:00Z",
          reason: "Run live smoke.",
        },
      },
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32602, message: "joinAt must be a valid timestamp." },
    });
    expect(vi.mocked(domain.runControlPlaneMeetingRecorderOperation)).not.toHaveBeenCalled();
  });
});
