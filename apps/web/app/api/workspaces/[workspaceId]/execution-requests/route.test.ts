import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listExecutionRequests = vi.fn();
const createExecutionRequest = vi.fn();
const getExecutionRequest = vi.fn();
const getExecutionPacket = vi.fn();
const submitExecutionResult = vi.fn();

const actor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

vi.mock("@corgtex/domain", () => ({
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  listExecutionRequests,
  createExecutionRequest,
  getExecutionRequest,
  getExecutionPacket,
  submitExecutionResult,
}));

vi.mock("@/lib/route-handler", () => ({
  withWorkspaceRoute: (handler: any) => async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    try {
      const params = await context.params;
      return await handler(request, {
        actor,
        membership: { id: "member-1", role: "ADMIN" },
        workspaceId: params.workspaceId,
        params,
      });
    } catch (error) {
      const routeError = error as Error & { status?: number; code?: string };
      return NextResponse.json(
        { error: { code: routeError.code ?? "INTERNAL_ERROR", message: routeError.message } },
        { status: routeError.status ?? 500 },
      );
    }
  },
}));

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

describe("execution request workspace API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listExecutionRequests.mockResolvedValue([{ id: "request-1" }]);
    createExecutionRequest.mockResolvedValue({ id: "request-1", goal: "Draft follow-up" });
    getExecutionRequest.mockResolvedValue({ id: "request-1", status: "PENDING" });
    getExecutionPacket.mockResolvedValue({ id: "request-1", goal: "Draft follow-up" });
    submitExecutionResult.mockResolvedValue({ id: "result-1", status: "ACCEPTED" });
  });

  it("lists and creates execution requests for the authenticated workspace", async () => {
    const { GET, POST } = await import("./route");
    const listResponse = await GET(
      request("http://localhost/api/workspaces/workspace-1/execution-requests?status=PENDING&take=5"),
      context({ workspaceId: "workspace-1" }),
    );

    await expect(listResponse.json()).resolves.toEqual({ items: [{ id: "request-1" }] });
    expect(listExecutionRequests).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      status: "PENDING",
      take: 5,
    });

    const createResponse = await POST(
      request("http://localhost/api/workspaces/workspace-1/execution-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "Draft follow-up",
          provider: "openwork",
          writebackTarget: { type: "ACTION", label: "New action" },
          idempotencyKey: "req-key",
        }),
      }),
      context({ workspaceId: "workspace-1" }),
    );

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({ executionRequest: { id: "request-1", goal: "Draft follow-up" } });
    expect(createExecutionRequest).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "workspace-1",
      provider: "openwork",
      writebackTargetType: "ACTION",
      writebackTargetLabel: "New action",
      idempotencyKey: "req-key",
    }));
  });

  it("returns execution request detail with an optional packet", async () => {
    const { GET } = await import("./[requestId]/route");
    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/execution-requests/request-1?packet=true"),
      context({ workspaceId: "workspace-1", requestId: "request-1" }),
    );

    await expect(response.json()).resolves.toEqual({
      executionRequest: { id: "request-1", status: "PENDING" },
      packet: { id: "request-1", goal: "Draft follow-up" },
    });
    expect(getExecutionRequest).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    });
    expect(getExecutionPacket).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
    });
  });

  it("returns safe route errors for unavailable execution packets", async () => {
    getExecutionPacket.mockRejectedValueOnce({
      status: 400,
      code: "INVALID_STATE",
      message: "Execution packet is not available for failed or cancelled requests.",
    });

    const { GET } = await import("./[requestId]/route");
    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/execution-requests/request-1?packet=true"),
      context({ workspaceId: "workspace-1", requestId: "request-1" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_STATE",
        message: "Execution packet is not available for failed or cancelled requests.",
      },
    });
  });

  it("submits idempotent execution results", async () => {
    const { POST } = await import("./[requestId]/submit-result/route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/execution-requests/request-1/submit-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "result-key",
          targetType: "ACTION",
          output: { title: "Follow up" },
        }),
      }),
      context({ workspaceId: "workspace-1", requestId: "request-1" }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ result: { id: "result-1", status: "ACCEPTED" } });
    expect(submitExecutionResult).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      requestId: "request-1",
      idempotencyKey: "result-key",
      targetType: "ACTION",
      targetId: undefined,
      output: { title: "Follow up" },
      artifacts: undefined,
      errorMessage: undefined,
    });
  });

  it("rejects result submissions without an idempotency key before calling the domain", async () => {
    const { POST } = await import("./[requestId]/submit-result/route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/execution-requests/request-1/submit-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output: { title: "Follow up" } }),
      }),
      context({ workspaceId: "workspace-1", requestId: "request-1" }),
    );

    expect(response.status).toBe(400);
    expect(submitExecutionResult).not.toHaveBeenCalled();
  });
});
