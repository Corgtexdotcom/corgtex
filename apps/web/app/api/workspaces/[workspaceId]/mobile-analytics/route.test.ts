import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  productAnalyticsEventCreate,
  handleRouteError,
  requireWorkspaceMembership,
  resolveRequestActor,
} = vi.hoisted(() => ({
  productAnalyticsEventCreate: vi.fn(),
  handleRouteError: vi.fn((error: unknown) => NextResponse.json({ error: String(error) }, { status: 500 })),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
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

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  requireWorkspaceMembership,
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    productAnalyticsEvent: {
      create: productAnalyticsEventCreate,
    },
  },
  toInputJson: (value: unknown) => value,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http")>("@/lib/http");
  return {
    ...actual,
    handleRouteError,
  };
});

function context(workspaceId = "workspace-1") {
  return { params: Promise.resolve({ workspaceId }) };
}

describe("POST /api/workspaces/[workspaceId]/mobile-analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue({
      kind: "user",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
        globalRole: "USER",
      },
    });
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    productAnalyticsEventCreate.mockResolvedValue({ id: "analytics-1" });
  });

  it("records a validated mobile mode analytics event after workspace authorization", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/mobile-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventName: "mode_changed",
          mode: "ai",
          previousMode: "workspace",
          source: "bottom_nav",
          route: "/workspaces/workspace-1/actions",
          viewportWidth: 390,
          coarsePointer: true,
        }),
      }),
      context(),
    );

    expect(response.status).toBe(202);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor: expect.objectContaining({ kind: "user" }),
      workspaceId: "workspace-1",
    });
    expect(productAnalyticsEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        actorUserId: "user-1",
        eventName: "mode_changed",
        surface: "mobile_mode",
        mode: "ai",
        previousMode: "workspace",
        source: "bottom_nav",
        route: "/workspaces/workspace-1/actions",
        viewportWidth: 390,
        coarsePointer: true,
      }),
    });
  });

  it("rejects unchanged mode_changed events", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/workspaces/workspace-1/mobile-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventName: "mode_changed",
          mode: "workspace",
          previousMode: "workspace",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(500);
    expect(handleRouteError).toHaveBeenCalledWith(expect.any(MockAppError));
    expect(productAnalyticsEventCreate).not.toHaveBeenCalled();
  });
});
