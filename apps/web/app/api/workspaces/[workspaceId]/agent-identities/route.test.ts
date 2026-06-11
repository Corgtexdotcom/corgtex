import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { resolveRequestActor, createAgentIdentity, listAgentIdentities } = vi.hoisted(() => ({
  resolveRequestActor: vi.fn(),
  createAgentIdentity: vi.fn(),
  listAgentIdentities: vi.fn(),
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
  createAgentIdentity,
  listAgentIdentities,
}));

beforeEach(() => {
  vi.resetModules();
  resolveRequestActor.mockResolvedValue({
    kind: "user",
    user: { id: "user-1" },
  });
  createAgentIdentity.mockResolvedValue({
    id: "agent-1",
    agentKey: "agent-key",
    displayName: "Agent",
    memberType: "INTERNAL",
  });
  listAgentIdentities.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/workspaces/[workspaceId]/agent-identities", () => {
  it("normalizes the legacy AI_AGENT member type for smoke clients", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/agent-identities", {
        method: "POST",
        body: JSON.stringify({
          agentKey: "agent-key",
          displayName: "Agent",
          memberType: "AI_AGENT",
          maxSpendPerRunCents: 100,
          maxRunsPerDay: 2,
          maxRunsPerHour: 1,
        }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(createAgentIdentity).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        agentKey: "agent-key",
        displayName: "Agent",
        memberType: "INTERNAL",
        maxSpendPerRunCents: 100,
        maxRunsPerDay: 2,
        maxRunsPerHour: 1,
      }),
    );
  });

  it("returns validation errors instead of passing invalid enum values to Prisma", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("https://app.corgtex.com/api/workspaces/ws-1/agent-identities", {
        method: "POST",
        body: JSON.stringify({
          agentKey: "agent-key",
          displayName: "Agent",
          memberType: "BOT",
        }),
      }),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "memberType must be INTERNAL or EXTERNAL.",
      },
    });
    expect(response.status).toBe(400);
    expect(createAgentIdentity).not.toHaveBeenCalled();
  });
});
