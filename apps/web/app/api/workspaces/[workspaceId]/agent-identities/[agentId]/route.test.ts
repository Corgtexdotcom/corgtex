import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { resolveRequestActor, getAgentIdentity, updateAgentIdentity, deactivateAgentIdentity } = vi.hoisted(() => ({
  resolveRequestActor: vi.fn(),
  getAgentIdentity: vi.fn(),
  updateAgentIdentity: vi.fn(),
  deactivateAgentIdentity: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError: (error: Error & { status?: number; code?: string }) => NextResponse.json(
    {
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message,
      },
    },
    { status: error.status ?? 500 },
  ),
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
  getAgentIdentity,
  updateAgentIdentity,
  deactivateAgentIdentity,
}));

beforeEach(() => {
  vi.resetModules();
  resolveRequestActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1" },
  });
  getAgentIdentity.mockResolvedValue({ id: "agent-1" });
  updateAgentIdentity.mockResolvedValue({
    id: "agent-1",
    memberType: "INTERNAL",
  });
  deactivateAgentIdentity.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/agent-identities/[agentId]", () => {
  it("normalizes the legacy AI_AGENT member type on updates", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/agent-identities/agent-1", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: "Agent",
          memberType: "AI_AGENT",
          maxSpendPerRunCents: 250,
        }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1", agentId: "agent-1" }) },
    );

    expect(response.status).toBe(200);
    expect(updateAgentIdentity).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        agentIdentityId: "agent-1",
        displayName: "Agent",
        memberType: "INTERNAL",
        maxSpendPerRunCents: 250,
      }),
    );
  });

  it("returns validation errors instead of passing invalid enum values to Prisma", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/agent-identities/agent-1", {
        method: "PATCH",
        body: JSON.stringify({
          memberType: "BOT",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1", agentId: "agent-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "memberType must be INTERNAL or EXTERNAL.",
      },
    });
    expect(response.status).toBe(400);
    expect(updateAgentIdentity).not.toHaveBeenCalled();
  });
});
