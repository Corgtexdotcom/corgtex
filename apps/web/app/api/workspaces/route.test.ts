import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createWorkspace,
  listActorWorkspaces,
  resolveRequestActor,
} = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  listActorWorkspaces: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  createWorkspace,
  listActorWorkspaces,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http")>();
  return {
    ...actual,
    handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({
      error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
    }, { status: error.status ?? 500 }),
  };
});

function createWorkspaceRequest(slug: string) {
  return new NextRequest("https://customer-alpha.corgtex.test/api/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Requested Workspace",
      slug,
      description: null,
    }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("APP_URL", "https://customer-alpha.corgtex.test");
  vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");
  resolveRequestActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/workspaces", () => {
  it("rejects nonconfigured workspace creation on dedicated customer deployments", async () => {
    const { POST } = await import("./route");
    const response = await POST(createWorkspaceRequest("orphan-workspace"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WORKSPACE_SCOPE_MISMATCH",
        message: "Workspace creation is restricted to this deployment's configured workspace.",
      },
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("allows the configured workspace slug on dedicated customer deployments", async () => {
    createWorkspace.mockResolvedValueOnce({
      id: "ws-customer-alpha",
      slug: "customer-alpha",
      name: "Customer Alpha",
    });

    const { POST } = await import("./route");
    const response = await POST(createWorkspaceRequest("customer-alpha"));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      workspace: {
        id: "ws-customer-alpha",
        slug: "customer-alpha",
        name: "Customer Alpha",
      },
    });
    expect(createWorkspace).toHaveBeenCalledWith({
      kind: "user",
      user: { id: "user-1" },
    }, {
      name: "Requested Workspace",
      slug: "customer-alpha",
      description: null,
    });
    expect(listActorWorkspaces).not.toHaveBeenCalled();
  });
});
