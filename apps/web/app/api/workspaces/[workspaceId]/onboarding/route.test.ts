import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { resolveRequestActor, getUserWorkspaceOnboardingState, completeUserWorkspaceOnboarding } = vi.hoisted(() => ({
  resolveRequestActor: vi.fn(),
  getUserWorkspaceOnboardingState: vi.fn(),
  completeUserWorkspaceOnboarding: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

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
  SELF_SERVE_WORKSPACE_TOUR_KEY: "self_serve_workspace",
  SELF_SERVE_WORKSPACE_TOUR_VERSION: "v2",
  getUserWorkspaceOnboardingState,
  completeUserWorkspaceOnboarding,
}));

beforeEach(() => {
  vi.resetModules();
  resolveRequestActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/onboarding", () => {
  it("returns a clean auth error when the request has no session", async () => {
    resolveRequestActor.mockRejectedValueOnce(Object.assign(new Error("Missing session."), {
      status: 401,
      code: "UNAUTHENTICATED",
    }));
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing session.",
      },
    });
    expect(response.status).toBe(401);
  });

  it("reads persisted onboarding completion for the current user", async () => {
    const completedAt = new Date("2026-05-25T10:00:00.000Z");
    getUserWorkspaceOnboardingState.mockResolvedValue({
      tourKey: "self_serve_workspace",
      tourVersion: "v2",
      completedAt,
      restartedAt: null,
      updatedAt: completedAt,
    });
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      tourKey: "self_serve_workspace",
      tourVersion: "v2",
      completedAt: "2026-05-25T10:00:00.000Z",
      restartedAt: null,
      updatedAt: "2026-05-25T10:00:00.000Z",
    });
  });

  it("marks onboarding complete for the current user and workspace", async () => {
    const completedAt = new Date("2026-05-25T10:00:00.000Z");
    completeUserWorkspaceOnboarding.mockResolvedValue({
      tourKey: "self_serve_workspace",
      tourVersion: "v1",
      completedAt,
      restartedAt: null,
      updatedAt: completedAt,
    });
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/onboarding", {
        method: "POST",
        body: JSON.stringify({ tourKey: "self_serve_workspace", tourVersion: "v2" }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(completeUserWorkspaceOnboarding).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      { workspaceId: "ws-1", tourKey: "self_serve_workspace", tourVersion: "v2" },
    );
    expect(response.status).toBe(200);
  });
});
