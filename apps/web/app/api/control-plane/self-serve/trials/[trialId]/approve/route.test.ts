import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveReviewGatedProcurementTrial: vi.fn(),
  rejectReviewGatedProcurementTrial: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
  requireControlPlaneDeploymentMode: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  approveReviewGatedProcurementTrial: mocks.approveReviewGatedProcurementTrial,
  rejectReviewGatedProcurementTrial: mocks.rejectReviewGatedProcurementTrial,
}));

vi.mock("@/lib/auth", () => ({
  resolveControlPlaneRequestActor: mocks.resolveControlPlaneRequestActor,
}));

vi.mock("@/lib/control-plane-guard", () => ({
  requireControlPlaneDeploymentMode: mocks.requireControlPlaneDeploymentMode,
}));

vi.mock("@/lib/http", () => ({
  validateBody: async (request: Request, schema: { parse: (value: unknown) => unknown }) => schema.parse(await request.json()),
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json(
    { error: { code: error.code ?? "INTERNAL_ERROR", message: error.message } },
    { status: error.status ?? 500 },
  ),
}));

function post(body: unknown) {
  return new Request("http://localhost/api/control-plane/self-serve/trials/trial-review/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("control-plane self-serve trial review routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireControlPlaneDeploymentMode.mockReturnValue(null);
    mocks.resolveControlPlaneRequestActor.mockResolvedValue({ kind: "agent", authProvider: "control-plane", scopes: ["control-plane:clients:write"] });
    mocks.approveReviewGatedProcurementTrial.mockResolvedValue({ statusCode: 201, body: { trialId: "trial-review", status: "ACTIVE" } });
    mocks.rejectReviewGatedProcurementTrial.mockResolvedValue({ id: "trial-review", status: "SUSPENDED" });
  });

  it("does not allow approval outside control-plane mode", async () => {
    mocks.requireControlPlaneDeploymentMode.mockReturnValueOnce(Response.json({ error: { code: "CONTROL_PLANE_NOT_AVAILABLE" } }, { status: 404 }));
    const { POST } = await import("./route");

    const response = await POST(post({ reason: "Approved." }) as never, { params: Promise.resolve({ trialId: "trial-review" }) });

    expect(response.status).toBe(404);
    expect(mocks.resolveControlPlaneRequestActor).not.toHaveBeenCalled();
    expect(mocks.approveReviewGatedProcurementTrial).not.toHaveBeenCalled();
  });

  it("approves a review-gated trial request through the domain operation", async () => {
    const { POST } = await import("./route");

    const response = await POST(post({ reason: "Verified customer request." }) as never, { params: Promise.resolve({ trialId: "trial-review" }) });

    expect(response.status).toBe(201);
    expect(mocks.approveReviewGatedProcurementTrial).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        trialId: "trial-review",
        reason: "Verified customer request.",
      },
    );
  });

  it("rejects a review-gated trial request through the domain operation", async () => {
    const { POST } = await import("../reject/route");

    const response = await POST(post({ reason: "Rejected after review." }) as never, { params: Promise.resolve({ trialId: "trial-review" }) });

    expect(response.status).toBe(200);
    expect(mocks.rejectReviewGatedProcurementTrial).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent" }),
      {
        trialId: "trial-review",
        reason: "Rejected after review.",
      },
    );
  });

  it("returns write-scope errors from the domain operation", async () => {
    const error = new Error("Control Plane scope required: control-plane:clients:write.") as Error & { status: number; code: string };
    error.status = 403;
    error.code = "CONTROL_PLANE_SCOPE_REQUIRED";
    mocks.approveReviewGatedProcurementTrial.mockRejectedValueOnce(error);
    const { POST } = await import("./route");

    const response = await POST(post({ reason: "Verified customer request." }) as never, { params: Promise.resolve({ trialId: "trial-review" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONTROL_PLANE_SCOPE_REQUIRED",
        message: "Control Plane scope required: control-plane:clients:write.",
      },
    });
  });
});
