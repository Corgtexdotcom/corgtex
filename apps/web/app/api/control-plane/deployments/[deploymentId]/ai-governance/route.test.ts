import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getControlPlaneAiGovernanceStatus,
  isDatabaseUnavailableError,
  resolveControlPlaneRequestActor,
  revokeControlPlaneAgentCredential,
  updateControlPlaneAgentCredentialScopes,
  updateControlPlaneAgentPolicy,
  updateControlPlaneModelBudget,
} = vi.hoisted(() => ({
  getControlPlaneAiGovernanceStatus: vi.fn(),
  isDatabaseUnavailableError: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
  revokeControlPlaneAgentCredential: vi.fn(),
  updateControlPlaneAgentCredentialScopes: vi.fn(),
  updateControlPlaneAgentPolicy: vi.fn(),
  updateControlPlaneModelBudget: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@/lib/auth", () => ({
  resolveControlPlaneRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  getControlPlaneAiGovernanceStatus,
  revokeControlPlaneAgentCredential,
  updateControlPlaneAgentCredentialScopes,
  updateControlPlaneAgentPolicy,
  updateControlPlaneModelBudget,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    get CONTROL_PLANE_MODE() {
      return process.env.CONTROL_PLANE_MODE === "true" || process.env.CONTROL_PLANE_MODE === "1";
    },
  },
  isDatabaseUnavailableError,
}));

function request(body: unknown, method = "PATCH") {
  return new Request("http://localhost/api/control-plane/deployments/inst-1/ai-governance", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("control-plane deployment AI governance API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.clearAllMocks();
    resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
    isDatabaseUnavailableError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the expanded governance status payload", async () => {
    getControlPlaneAiGovernanceStatus.mockResolvedValueOnce({
      deploymentId: "inst-1",
      featureFlag: { flag: "AGENT_GOVERNANCE", enabled: true, source: "default" },
      agents: { identities: [], configs: [] },
      access: { credentials: [] },
      spend: { budget: null, recentModelUsage: [] },
      activity: { recentRuns: [], recentFailedJobs: [], riskyToolCalls: [] },
      audit: { recentSupportOperations: [] },
      riskFindings: [],
    });
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/control-plane/deployments/inst-1/ai-governance") as never, {
      params: Promise.resolve({ deploymentId: "inst-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      aiGovernance: {
        deploymentId: "inst-1",
        featureFlag: { flag: "AGENT_GOVERNANCE", enabled: true },
      },
    });
    expect(getControlPlaneAiGovernanceStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), "inst-1");
  });

  it("requires a reason before mutating governance state", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(request({
      operation: "revoke_credential",
      credentialId: "cred-1",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "reason is required.",
      },
    });
    expect(revokeControlPlaneAgentCredential).not.toHaveBeenCalled();
  });

  it("rejects credential scope updates without an explicit string-array scope set", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(request({
      operation: "update_credential_scopes",
      credentialId: "cred-1",
      scopes: "workspace:read",
      reason: "Reduce scope.",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "scopes must be an array of strings.",
      },
    });
    expect(updateControlPlaneAgentCredentialScopes).not.toHaveBeenCalled();
  });

  it("dispatches approved model budget mutations", async () => {
    updateControlPlaneModelBudget.mockResolvedValueOnce({
      deploymentId: "inst-1",
      source: "managed_workspace",
      budget: { id: "budget-1", monthlyCostCapUsd: "250.00" },
    });
    const { PATCH } = await import("./route");

    const response = await PATCH(request({
      operation: "update_model_budget",
      monthlyCostCapUsd: 250,
      alertThresholdPct: 75,
      reason: "Customer approved model cap.",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        deploymentId: "inst-1",
        source: "managed_workspace",
      },
    });
    expect(updateControlPlaneModelBudget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user" }),
      {
        deploymentId: "inst-1",
        monthlyCostCapUsd: 250,
        alertThresholdPct: 75,
        periodStartDay: null,
        reason: "Customer approved model cap.",
      },
    );
  });

  it("dispatches approved agent policy mutations without requiring raw policy readback", async () => {
    updateControlPlaneAgentPolicy.mockResolvedValueOnce({
      deploymentId: "inst-1",
      source: "managed_workspace",
      config: { id: "config-1", agentKey: "meeting-summary", hasGovernancePolicy: true },
    });
    const { PATCH } = await import("./route");

    const response = await PATCH(request({
      operation: "update_agent_policy",
      agentKey: "meeting-summary",
      governancePolicy: "Allow summaries only after transcript consent.",
      reason: "Customer approved policy change.",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("Allow summaries only after transcript consent.");
    expect(updateControlPlaneAgentPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user" }),
      expect.objectContaining({
        deploymentId: "inst-1",
        agentKey: "meeting-summary",
        governancePolicy: "Allow summaries only after transcript consent.",
        reason: "Customer approved policy change.",
      }),
    );
  });
});
