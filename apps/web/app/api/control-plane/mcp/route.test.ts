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
  configureControlPlaneMeetingRecorderIntegration: vi.fn(), enqueueControlPlaneFleetSnapshots: vi.fn(), fetchCustomerSupportSnapshot: vi.fn(),
  getControlPlaneAiGovernanceStatus: vi.fn(), getControlPlaneContextHealth: vi.fn(),
  getControlPlaneDeployment: vi.fn(), getControlPlaneIntegrationStatus: vi.fn(), getControlPlaneReleaseStatus: vi.fn(),
  listControlPlaneDeployments: mocks.listControlPlaneDeployments,
  probeControlPlaneDeploymentHealth: vi.fn(),
  requireControlPlaneAccess: mocks.requireControlPlaneAccess,
  requireControlPlaneScope: mocks.requireControlPlaneScope,
  refreshControlPlaneFleetSnapshots: vi.fn(),
  runControlPlaneContextOperation: vi.fn(), runControlPlaneReleaseOperation: vi.fn(), runCustomerSupportOperation: vi.fn(),
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
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_customers", "get_customer_deployment_status", "refresh_customer_deployment_snapshot", "list_customer_integrations", "get_context_health", "get_ai_governance_status", "get_release_status", "configure_customer_integration", "run_context_sync", "probe_customer_deployment_health", "refresh_fleet_snapshots", "enqueue_fleet_snapshot_jobs", "prepare_release_upgrade", "run_customer_support_operation"]);
  });
  it("denies mutating tools when the control-plane agent only has read scope", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_context_sync", arguments: { deploymentId: "inst-1", reason: "repair" } } }) as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "CONTROL_PLANE_SCOPE_REQUIRED", message: "Control Plane scope required: control-plane:context:write." } });
  });
});
