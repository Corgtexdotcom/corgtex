import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resolveRequestActor: vi.fn(),
  provision: vi.fn(),
  status: vi.fn(),
  proof: vi.fn(),
  terminalize: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor: mocks.resolveRequestActor,
}));

vi.mock("@corgtex/domain", async () => {
  const actual = await vi.importActual<typeof import("@corgtex/domain")>("@corgtex/domain");
  return {
    ...actual,
    provisionPr976ActionGoalValidation: mocks.provision,
    getPr976ActionGoalValidationStatus: mocks.status,
    recordPr976ActionGoalFeatureProof: mocks.proof,
    terminalizePr976ActionGoalValidation: mocks.terminalize,
  };
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/internal/smoke/pr976-action-goal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/smoke/pr976-action-goal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1", email: "admin@example.com" } });
  });

  it("dispatches provision through the fixed application authority", async () => {
    mocks.provision.mockResolvedValue({ receipt: { operationKey: "pr976-action-goal-production-validation" }, credentialToken: "agentc-redacted" });
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "provision",
      operationKey: "pr976-action-goal-production-validation",
      deployedSha: "1".repeat(40),
      ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
      workflowRunId: "123",
      workflowRunAttempt: 1,
    }));
    expect(response.status).toBe(200);
    expect(mocks.provision).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      operationKey: "pr976-action-goal-production-validation",
      ancestorSha: "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771",
    }));
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("rejects arbitrary operation keys before mutation", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "status",
      operationKey: "other-operation",
    }));
    expect(response.status).toBe(400);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("rejects arbitrary destructive target ids in terminalize requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "terminalize",
      operationKey: "pr976-action-goal-production-validation",
      mode: "all",
      actionId: "client-supplied-id",
    }));
    expect(response.status).toBe(400);
    expect(mocks.terminalize).not.toHaveBeenCalled();
  });

  it("routes feature proof without exposing a generic cleanup API", async () => {
    mocks.proof.mockResolvedValue({ receipt: { actionState: "FEATURE_PROVEN", goalState: "FEATURE_PROVEN" } });
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "feature_proof",
      operationKey: "pr976-action-goal-production-validation",
      actionObservedBodyMd: "corgtex:production-validation:pr976:action-goal:action:proven",
      actionObservedVersion: 2,
      goalObservedProgress: 37,
      goalObservedVersion: 2,
    }));
    expect(response.status).toBe(200);
    expect(mocks.proof).toHaveBeenCalledOnce();
  });
});
