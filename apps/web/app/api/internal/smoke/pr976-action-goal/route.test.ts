import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resolveRequestActor: vi.fn(),
  provision: vi.fn(),
  status: vi.fn(),
  proof: vi.fn(),
  terminalize: vi.fn(),
  editActionAction: vi.fn(),
  updateGoalFormAction: vi.fn(),
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

vi.mock("@/app/[locale]/workspaces/[workspaceId]/actions/actions", () => ({
  editActionAction: mocks.editActionAction,
}));

vi.mock("@/app/[locale]/workspaces/[workspaceId]/goals/actions", () => ({
  updateGoalFormAction: mocks.updateGoalFormAction,
}));

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
      workflowRunId: "123",
      workflowRunAttempt: 1,
    }));
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("requires the immutable execution tuple for status reads", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "status",
      operationKey: "pr976-action-goal-production-validation",
    }));
    expect(response.status).toBe(400);
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
      workflowRunId: "123",
      workflowRunAttempt: 1,
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
      workflowRunId: "123",
      workflowRunAttempt: 1,
      actionObservedBodyMd: "corgtex:production-validation:pr976:action-goal:action:proven",
      actionObservedVersion: 2,
      goalObservedProgress: 37,
      goalObservedVersion: 2,
    }));
    expect(response.status).toBe(200);
    expect(mocks.proof).toHaveBeenCalledOnce();
  });

  it("executes Action proof through editActionAction with only receipt-owned values", async () => {
    mocks.status
      .mockResolvedValueOnce({
        receipt: {
          workspaceId: "workspace-from-receipt",
          actionId: "action-from-receipt",
          goalId: "goal-from-receipt",
          actionBaselineVersion: 7,
          goalBaselineVersion: 3,
        },
      })
      .mockResolvedValueOnce({
        action: {
          id: "action-from-receipt",
          bodyMd: "corgtex:production-validation:pr976:action-goal:action:proven",
          version: 8,
        },
      });
    mocks.editActionAction.mockResolvedValue({ status: "success" });
    const { POST } = await import("./route");

    const response = await POST(request({
      operation: "prove_action",
      operationKey: "pr976-action-goal-production-validation",
      workflowRunId: "123",
      workflowRunAttempt: 1,
    }));

    expect(response.status).toBe(200);
    expect(mocks.editActionAction).toHaveBeenCalledOnce();
    const formData = mocks.editActionAction.mock.calls[0]![1] as FormData;
    expect(formData.get("workspaceId")).toBe("workspace-from-receipt");
    expect(formData.get("actionId")).toBe("action-from-receipt");
    expect(formData.get("bodyMd")).toBe("corgtex:production-validation:pr976:action-goal:action:proven");
    expect(formData.get("expectedVersion")).toBe("7");
  });

  it("maps Action stale proof conflicts without mutating arbitrary target ids", async () => {
    mocks.status.mockResolvedValueOnce({
      receipt: {
        workspaceId: "workspace-from-receipt",
        actionId: "action-from-receipt",
        goalId: "goal-from-receipt",
        actionBaselineVersion: 7,
        goalBaselineVersion: 3,
      },
    });
    mocks.editActionAction.mockResolvedValue({ status: "conflict" });
    const { POST } = await import("./route");

    const response = await POST(request({
      operation: "prove_action_stale",
      operationKey: "pr976-action-goal-production-validation",
      workflowRunId: "123",
      workflowRunAttempt: 1,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "VERSION_CONFLICT" });
    const formData = mocks.editActionAction.mock.calls[0]![1] as FormData;
    expect(formData.get("actionId")).toBe("action-from-receipt");
    expect(formData.get("bodyMd")).toBe("corgtex:production-validation:pr976:action-goal:action:proven:forbidden-stale");
  });

  it("executes Goal proof through updateGoalFormAction with receipt-owned values", async () => {
    mocks.status
      .mockResolvedValueOnce({
        receipt: {
          workspaceId: "workspace-from-receipt",
          actionId: "action-from-receipt",
          goalId: "goal-from-receipt",
          actionBaselineVersion: 7,
          goalBaselineVersion: 3,
        },
      })
      .mockResolvedValueOnce({
        goal: {
          id: "goal-from-receipt",
          progressPercent: 37,
          version: 4,
        },
      });
    mocks.updateGoalFormAction.mockResolvedValue(undefined);
    const { POST } = await import("./route");

    const response = await POST(request({
      operation: "prove_goal",
      operationKey: "pr976-action-goal-production-validation",
      workflowRunId: "123",
      workflowRunAttempt: 1,
    }));

    expect(response.status).toBe(200);
    const formData = mocks.updateGoalFormAction.mock.calls[0]![0] as FormData;
    expect(formData.get("workspaceId")).toBe("workspace-from-receipt");
    expect(formData.get("goalId")).toBe("goal-from-receipt");
    expect(formData.get("progressPercent")).toBe("37");
    expect(formData.get("expectedVersion")).toBe("3");
  });

  it("rejects arbitrary client supplied ids or values for server-action proof operations", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      operation: "prove_goal",
      operationKey: "pr976-action-goal-production-validation",
      workflowRunId: "123",
      workflowRunAttempt: 1,
      goalId: "client-supplied-forbidden",
      progressPercent: 99,
    }));

    expect(response.status).toBe(400);
    expect(mocks.updateGoalFormAction).not.toHaveBeenCalled();
    expect(mocks.editActionAction).not.toHaveBeenCalled();
  });
});
