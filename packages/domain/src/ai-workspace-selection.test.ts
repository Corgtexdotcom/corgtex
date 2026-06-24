import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { getMcpOAuthConnectionStatusMock, prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  getMcpOAuthConnectionStatusMock: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
    aiWorkspaceConnection: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: requireWorkspaceMembershipMock }));
vi.mock("./mcp-connector", () => ({ getMcpOAuthConnectionStatus: getMcpOAuthConnectionStatusMock }));

const userActor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

const agentActor: AppActor = {
  kind: "agent",
  credentialId: "credential-1",
  label: "Agent",
  authProvider: "credential",
  workspaceIds: ["workspace-1"],
  scopes: ["workspace:read"],
};

describe("AI workspace selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValue(null);
    prismaMock.aiWorkspaceConnection.findMany.mockResolvedValue([]);
    prismaMock.aiWorkspaceConnection.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.aiWorkspaceConnection.update.mockResolvedValue({ id: "connection-1" });
    prismaMock.aiWorkspaceConnection.create.mockResolvedValue({ id: "connection-1" });
    getMcpOAuthConnectionStatusMock.mockResolvedValue({ providerKey: "claude", connected: false, connectedAt: null, source: null, clientName: null });
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "ADMIN", isActive: true });
  });

  it("returns no active provider for a new user while listing top-level tools", async () => {
    const { getAiWorkspaceSelectionState } = await import("./ai-workspace-selection");

    const state = await getAiWorkspaceSelectionState(userActor, "workspace-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor: userActor, workspaceId: "workspace-1" });
    expect(state.activeProviderKey).toBeNull();
    expect(state.connections).toEqual([]);
    expect(state.providers.map((provider) => provider.key)).toEqual([
      "openwork",
      "chatgpt",
      "claude",
      "copilot",
      "gemini",
      "cursor",
      "generic_mcp",
    ]);
    expect(state.providers.some((provider) => provider.key === "claude_code")).toBe(false);
  });

  it("maps legacy Claude Code active rows to the Claude top-level provider", async () => {
    const { getAiWorkspaceSelectionState } = await import("./ai-workspace-selection");
    prismaMock.aiWorkspaceConnection.findMany.mockResolvedValueOnce([
      {
        provider: "CLAUDE_CODE",
        healthStatus: "CONNECTED",
        isDefault: true,
        lastHealthCheckAt: new Date("2026-06-01T10:00:00.000Z"),
        lastSuccessfulHealthCheckAt: new Date("2026-06-01T10:00:00.000Z"),
        setupState: { verificationSource: "manual" },
        updatedAt: new Date("2026-06-01T10:00:00.000Z"),
      },
    ]);

    const state = await getAiWorkspaceSelectionState(userActor, "workspace-1");

    expect(state.activeProviderKey).toBe("claude");
    expect(state.connections).toEqual([
      expect.objectContaining({
        providerKey: "claude",
        healthStatus: "CONNECTED",
        isDefault: true,
        verificationSource: "manual",
      }),
    ]);
  });

  it("creates a user-scoped default provider row for legacy selection", async () => {
    const { setActiveAiWorkspaceProvider } = await import("./ai-workspace-selection");

    await setActiveAiWorkspaceProvider(userActor, {
      workspaceId: "workspace-1",
      providerKey: "copilot",
    });

    expect(prismaMock.aiWorkspaceConnection.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        ownerUserId: "user-1",
      },
      data: { isDefault: false },
    });
    expect(prismaMock.aiWorkspaceConnection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        createdByUserId: "user-1",
        ownerUserId: "user-1",
        provider: "COPILOT",
        ownershipMode: "USER_MANAGED",
        displayName: "GitHub Copilot",
        healthStatus: "NEEDS_SETUP",
        isDefault: true,
      }),
    });
  });

  it("updates an existing provider row when switching back to it", async () => {
    const { setActiveAiWorkspaceProvider } = await import("./ai-workspace-selection");
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValueOnce({ id: "connection-1", healthStatus: "CONNECTED" });

    await setActiveAiWorkspaceProvider(userActor, {
      workspaceId: "workspace-1",
      providerKey: "openwork",
    });

    expect(prismaMock.aiWorkspaceConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        displayName: "OpenWork Free",
        isDefault: true,
      },
    });
    expect(prismaMock.aiWorkspaceConnection.create).not.toHaveBeenCalled();
  });

  it("starts setup without clearing defaults or downgrading connected rows", async () => {
    const { startAiWorkspaceProviderSetup } = await import("./ai-workspace-selection");
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValueOnce({ id: "connection-1", healthStatus: "CONNECTED" });

    await startAiWorkspaceProviderSetup(userActor, {
      workspaceId: "workspace-1",
      providerKey: "claude",
    });

    expect(prismaMock.aiWorkspaceConnection.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.aiWorkspaceConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        displayName: "Claude",
        healthStatus: "CONNECTED",
      },
    });
  });

  it("verifies a non-Claude provider from an observed MCP OAuth connection", async () => {
    const { verifyAiWorkspaceProviderConnection } = await import("./ai-workspace-selection");
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValueOnce({
      id: "connection-1",
      setupState: {},
    });
    const connectedAt = new Date("2026-06-12T12:00:00.000Z");
    getMcpOAuthConnectionStatusMock.mockResolvedValueOnce({
      providerKey: "cursor",
      connected: true,
      connectedAt,
      source: "mcp_oauth",
      clientName: "Cursor",
    });

    const result = await verifyAiWorkspaceProviderConnection(userActor, {
      workspaceId: "workspace-1",
      providerKey: "cursor",
    });

    expect(getMcpOAuthConnectionStatusMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      providerKey: "cursor",
    });
    expect(result).toMatchObject({
      providerKey: "cursor",
      verified: true,
      connectedAt,
      message: "Cursor is connected through Corgtex OAuth.",
    });
    expect(prismaMock.aiWorkspaceConnection.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        ownerUserId: "user-1",
      },
      data: { isDefault: false },
    });
    expect(prismaMock.aiWorkspaceConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: expect.objectContaining({
        displayName: "Cursor",
        healthStatus: "CONNECTED",
        isDefault: true,
        lastSuccessfulHealthCheckAt: connectedAt,
        lastError: null,
        setupState: expect.objectContaining({
          verificationSource: "mcp_oauth:cursor",
          verifiedAt: connectedAt.toISOString(),
        }),
      }),
    });
  });

  it("failed verification leaves the provider in needs-setup instead of manual connected state", async () => {
    const { verifyAiWorkspaceProviderConnection } = await import("./ai-workspace-selection");
    prismaMock.aiWorkspaceConnection.findFirst
      .mockResolvedValueOnce({
        id: "connection-1",
        healthStatus: "CONNECTED",
        setupState: { verificationSource: "manual" },
      })
      .mockResolvedValueOnce({
        id: "connection-1",
        setupState: {},
      });

    const result = await verifyAiWorkspaceProviderConnection(userActor, {
      workspaceId: "workspace-1",
      providerKey: "chatgpt",
    });

    expect(getMcpOAuthConnectionStatusMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      providerKey: "chatgpt",
    });
    expect(result).toMatchObject({
      providerKey: "chatgpt",
      verified: false,
      connectedAt: null,
    });
    expect(prismaMock.aiWorkspaceConnection.update).toHaveBeenLastCalledWith({
      where: { id: "connection-1" },
      data: expect.objectContaining({
        healthStatus: "NEEDS_SETUP",
        lastSuccessfulHealthCheckAt: null,
        lastError: "No completed Corgtex MCP OAuth sign-in was visible for this provider yet.",
      }),
    });
  });

  it("rejects hidden, unknown, and non-user selections", async () => {
    const { setActiveAiWorkspaceProvider } = await import("./ai-workspace-selection");

    await expect(setActiveAiWorkspaceProvider(userActor, {
      workspaceId: "workspace-1",
      providerKey: "claude_code",
    })).rejects.toThrow("Unsupported AI workspace provider.");

    await expect(setActiveAiWorkspaceProvider(userActor, {
      workspaceId: "workspace-1",
      providerKey: "unknown",
    })).rejects.toThrow("Unsupported AI workspace provider.");

    await expect(setActiveAiWorkspaceProvider(agentActor, {
      workspaceId: "workspace-1",
      providerKey: "openwork",
    })).rejects.toThrow("AI workspace selection requires a user account.");
  });
});
