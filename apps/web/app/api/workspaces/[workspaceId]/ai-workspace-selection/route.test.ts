import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAiWorkspaceSelectionState = vi.fn();
const makeDefaultAiWorkspaceProvider = vi.fn();
const setActiveAiWorkspaceProvider = vi.fn();
const startAiWorkspaceProviderSetup = vi.fn();

const userActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

let routeActor = userActor;

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
  getAiWorkspaceSelectionState,
  makeDefaultAiWorkspaceProvider,
  setActiveAiWorkspaceProvider,
  startAiWorkspaceProviderSetup,
}));

vi.mock("@/lib/http", async () => {
  return {
    validateBody: async (request: NextRequest, schema: any) => {
      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw { status: 400, code: "VALIDATION_ERROR", message: "Request body failed validation." };
      }
      return parsed.data;
    },
  };
});

vi.mock("@/lib/route-handler", () => ({
  withWorkspaceRoute: (handler: any) => async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    try {
      const params = await context.params;
      return await handler(request, {
        actor: routeActor,
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

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

describe("AI workspace selection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeActor = userActor;
    getAiWorkspaceSelectionState.mockResolvedValue({
      activeProviderKey: null,
      connections: [],
      providers: [{ key: "openwork", label: "OpenWork Free" }],
    });
    setActiveAiWorkspaceProvider.mockResolvedValue({
      activeProviderKey: "copilot",
      connections: [{ providerKey: "copilot", healthStatus: "NEEDS_SETUP" }],
      providers: [{ key: "copilot", label: "GitHub Copilot" }],
    });
    startAiWorkspaceProviderSetup.mockResolvedValue({
      activeProviderKey: null,
      connections: [{ providerKey: "claude", healthStatus: "NEEDS_SETUP" }],
      providers: [{ key: "claude", label: "Claude" }],
    });
    makeDefaultAiWorkspaceProvider.mockResolvedValue({
      activeProviderKey: "chatgpt",
      connections: [{ providerKey: "chatgpt", healthStatus: "CONNECTED", isDefault: true }],
      providers: [{ key: "copilot", label: "GitHub Copilot" }],
    });
  });

  it("returns no-store active selection state", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getAiWorkspaceSelectionState).toHaveBeenCalledWith(userActor, "workspace-1");
    await expect(response.json()).resolves.toEqual({
      activeProviderKey: null,
      connections: [],
      providers: [{ key: "openwork", label: "OpenWork Free" }],
    });
  });

  it("keeps legacy selected-provider POST behavior", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerKey: "copilot" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(setActiveAiWorkspaceProvider).toHaveBeenCalledWith(userActor, {
      workspaceId: "workspace-1",
      providerKey: "copilot",
    });
    await expect(response.json()).resolves.toEqual({
      activeProviderKey: "copilot",
      connections: [{ providerKey: "copilot", healthStatus: "NEEDS_SETUP" }],
      providers: [{ key: "copilot", label: "GitHub Copilot" }],
    });
  });

  it("starts setup without making the provider default", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_setup", providerKey: "claude" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(startAiWorkspaceProviderSetup).toHaveBeenCalledWith(userActor, {
      workspaceId: "workspace-1",
      providerKey: "claude",
    });
    expect(setActiveAiWorkspaceProvider).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      activeProviderKey: null,
      connections: [{ providerKey: "claude", healthStatus: "NEEDS_SETUP" }],
      providers: [{ key: "claude", label: "Claude" }],
    });
  });

  it("makes a connected provider the default explicitly", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "make_default", providerKey: "chatgpt" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(makeDefaultAiWorkspaceProvider).toHaveBeenCalledWith(userActor, {
      workspaceId: "workspace-1",
      providerKey: "chatgpt",
    });
  });

  it("rejects missing provider keys before calling the domain", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(setActiveAiWorkspaceProvider).not.toHaveBeenCalled();
    expect(startAiWorkspaceProviderSetup).not.toHaveBeenCalled();
  });

  it("passes non-user actors through so domain selection can reject mutation", async () => {
    routeActor = {
      kind: "agent",
      credentialId: "credential-1",
      authProvider: "agent",
      workspaceId: "workspace-1",
      scopes: ["workspace:read"],
    } as any;
    setActiveAiWorkspaceProvider.mockRejectedValueOnce({
      status: 403,
      code: "FORBIDDEN",
      message: "AI workspace selection requires a user account.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/ai-workspace-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerKey: "openwork" }),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(setActiveAiWorkspaceProvider).toHaveBeenCalledWith(routeActor, {
      workspaceId: "workspace-1",
      providerKey: "openwork",
    });
  });
});
