import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listControlPlaneSupportOperations,
  recordBreakGlassSupportNote,
  requireControlPlaneDeploymentMode,
  resolveControlPlaneRequestActor,
  runCustomerSupportOperation,
} = vi.hoisted(() => ({
  listControlPlaneSupportOperations: vi.fn(),
  recordBreakGlassSupportNote: vi.fn(),
  requireControlPlaneDeploymentMode: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
  runCustomerSupportOperation: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  listControlPlaneSupportOperations,
  recordBreakGlassSupportNote,
  runCustomerSupportOperation,
}));

vi.mock("@/lib/auth", () => ({
  resolveControlPlaneRequestActor,
}));

vi.mock("@/lib/control-plane-guard", () => ({
  requireControlPlaneDeploymentMode,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: any) => Response.json({
    error: {
      code: error?.code ?? "INVALID_INPUT",
      message: error instanceof Error ? error.message : "Invalid input.",
    },
  }, { status: typeof error?.status === "number" ? error.status : 400 }),
}));

function request(body: unknown) {
  return new Request("http://localhost/api/control-plane/deployments/inst-1/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("control-plane deployment operations API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    requireControlPlaneDeploymentMode.mockReturnValue(null);
    resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
  });

  it("accepts read-only newspaper diagnostics support operations", async () => {
    runCustomerSupportOperation.mockResolvedValueOnce({
      id: "op-newspaper",
      action: "newspaper.diagnostics",
      status: "COMPLETED",
    });
    const { POST } = await import("./route");

    const response = await POST(request({
      action: "newspaper.diagnostics",
      reason: "Inspect delivery health before the next scheduled newspaper.",
      arguments: { take: 5 },
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      operation: {
        id: "op-newspaper",
        action: "newspaper.diagnostics",
      },
    });
    expect(runCustomerSupportOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user" }),
      {
        deploymentId: "inst-1",
        action: "newspaper.diagnostics",
        reason: "Inspect delivery health before the next scheduled newspaper.",
        arguments: { take: 5 },
      },
    );
  });

  it("rejects retry-style newspaper operations", async () => {
    const { POST } = await import("./route");

    const response = await POST(request({
      action: "newspaper.retry_failed_deliveries",
      reason: "Do not allow resend from the Ops plane.",
      arguments: {},
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(400);
    expect(runCustomerSupportOperation).not.toHaveBeenCalled();
  });

  it.each(["brain.source_recovery", "brain.reconcile_source"])("exposes %s through the existing Ops route", async (action) => {
    const { POST } = await import("./route");
    runCustomerSupportOperation.mockResolvedValue({ id: "op", status: "COMPLETED" });
    const response = await POST(request({ action, reason: "Approved recovery", arguments: { sourceId: "source", expectedSourceIdentity: "a".repeat(64) } }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });
    expect(response.status).toBe(201);
    expect(runCustomerSupportOperation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action, deploymentId: "inst-1", reason: "Approved recovery" }));
  });
});
