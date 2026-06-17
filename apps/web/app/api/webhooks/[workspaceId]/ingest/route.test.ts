import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  MockAppError,
  handleRouteErrorMock,
  prismaMock,
  processInboundWebhookMock,
  rateLimitWebhookIngestMock,
  requireAgentScopeMock,
  requireWorkspaceMembershipMock,
  resolveAgentActorFromBearerMock,
} = vi.hoisted(() => {
  class MockAppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    MockAppError,
    handleRouteErrorMock: vi.fn((error: Error & { status?: number; code?: string }) => Response.json({
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message,
      },
    }, { status: error.status ?? 500 })),
    prismaMock: {
      workspace: {
        findUnique: vi.fn(),
      },
    },
    processInboundWebhookMock: vi.fn(),
    rateLimitWebhookIngestMock: vi.fn(),
    requireAgentScopeMock: vi.fn(),
    requireWorkspaceMembershipMock: vi.fn(),
    resolveAgentActorFromBearerMock: vi.fn(),
  };
});

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  processInboundWebhook: processInboundWebhookMock,
  requireAgentScope: requireAgentScopeMock,
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
  resolveAgentActorFromBearer: resolveAgentActorFromBearerMock,
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: handleRouteErrorMock,
}));

vi.mock("@/lib/rate-limit-middleware", () => ({
  rateLimitWebhookIngest: rateLimitWebhookIngestMock,
}));

const agentActor = {
  kind: "agent" as const,
  authProvider: "credential" as const,
  credentialId: "credential-1",
  label: "Webhook client",
  workspaceIds: ["ws-1"],
  scopes: ["webhooks:write"],
};

function routeContext(workspaceId = "ws-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function ingestRequest(options: {
  auth?: string | null;
  body?: BodyInit | null;
  source?: string;
} = {}) {
  return new NextRequest(`http://localhost/api/webhooks/ws-1/ingest?source=${options.source ?? "slack"}`, {
    method: "POST",
    headers: options.auth === null ? undefined : {
      authorization: options.auth ?? "Bearer agentc-secret",
    },
    body: options.body ?? JSON.stringify({ id: "external-1", text: "payload" }),
  });
}

describe("inbound webhook ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: "ws-1" });
    processInboundWebhookMock.mockResolvedValue({ inboundId: "inbound-1", eventCreated: true });
    rateLimitWebhookIngestMock.mockResolvedValue(null);
    requireAgentScopeMock.mockReturnValue(undefined);
    requireWorkspaceMembershipMock.mockResolvedValue(null);
    resolveAgentActorFromBearerMock.mockResolvedValue(agentActor);
  });

  it("authenticates with the canonical bearer resolver and processes scoped webhook payloads", async () => {
    const { POST } = await import("./route");

    const response = await POST(ingestRequest(), routeContext());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ inboundId: "inbound-1", eventCreated: true });
    expect(resolveAgentActorFromBearerMock).toHaveBeenCalledWith("agentc-secret");
    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor: agentActor, workspaceId: "ws-1" });
    expect(requireAgentScopeMock).toHaveBeenCalledWith(agentActor, "webhooks:write");
    expect(processInboundWebhookMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: "slack",
      externalId: "external-1",
      payload: { id: "external-1", text: "payload" },
    });
  });

  it("rejects missing bearer credentials", async () => {
    const { POST } = await import("./route");

    const response = await POST(ingestRequest({ auth: null }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Missing authorization." },
    });
    expect(resolveAgentActorFromBearerMock).not.toHaveBeenCalled();
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects empty bearer credentials", async () => {
    const { POST } = await import("./route");

    const response = await POST(ingestRequest({ auth: "Bearer " }), routeContext());

    expect(response.status).toBe(401);
    expect(resolveAgentActorFromBearerMock).not.toHaveBeenCalled();
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer credentials", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValueOnce(null);
    const { POST } = await import("./route");

    const response = await POST(ingestRequest(), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Invalid or expired credential." },
    });
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects bootstrap agent bearers without using them as scoped webhook credentials", async () => {
    resolveAgentActorFromBearerMock.mockResolvedValueOnce({
      kind: "agent" as const,
      authProvider: "bootstrap" as const,
      label: "bootstrap-agent",
      workspaceIds: ["ws-1"],
    });
    const { POST } = await import("./route");

    const response = await POST(ingestRequest({ auth: "Bearer agent-bootstrap-secret" }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Invalid or expired credential." },
    });
    expect(requireWorkspaceMembershipMock).not.toHaveBeenCalled();
    expect(requireAgentScopeMock).not.toHaveBeenCalled();
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects credentials resolved outside the requested workspace", async () => {
    requireWorkspaceMembershipMock.mockRejectedValueOnce(new MockAppError(403, "FORBIDDEN", "Agent is not allowed for this workspace."));
    const { POST } = await import("./route");

    const response = await POST(ingestRequest(), routeContext("ws-other"));

    expect(response.status).toBe(403);
    expect(requireAgentScopeMock).not.toHaveBeenCalled();
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects credentials missing the inbound webhook scope", async () => {
    requireAgentScopeMock.mockImplementationOnce(() => {
      throw new MockAppError(403, "FORBIDDEN", "Agent credential is missing the required scope.");
    });
    const { POST } = await import("./route");

    const response = await POST(ingestRequest(), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Agent credential is missing the required scope." },
    });
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON after authentication", async () => {
    const { POST } = await import("./route");

    const response = await POST(ingestRequest({ body: "{" }), routeContext());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(requireAgentScopeMock).toHaveBeenCalledWith(agentActor, "webhooks:write");
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });

  it("returns not found when the workspace does not exist", async () => {
    prismaMock.workspace.findUnique.mockResolvedValueOnce(null);
    const { POST } = await import("./route");

    const response = await POST(ingestRequest(), routeContext("missing-ws"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" });
    expect(resolveAgentActorFromBearerMock).not.toHaveBeenCalled();
    expect(processInboundWebhookMock).not.toHaveBeenCalled();
  });
});
