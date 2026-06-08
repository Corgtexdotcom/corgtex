import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    aiWorkspaceConnection: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: requireWorkspaceMembershipMock }));

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
    prismaMock.aiWorkspaceConnection.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.aiWorkspaceConnection.update.mockResolvedValue({ id: "connection-1" });
    prismaMock.aiWorkspaceConnection.create.mockResolvedValue({ id: "connection-1" });
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", workspaceId: "workspace-1", userId: "user-1", role: "ADMIN", isActive: true });
  });

  it("returns no active provider for a new user while listing top-level tools", async () => {
    const { getAiWorkspaceSelectionState } = await import("./ai-workspace-selection");

    const state = await getAiWorkspaceSelectionState(userActor, "workspace-1");

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({ actor: userActor, workspaceId: "workspace-1" });
    expect(state.activeProviderKey).toBeNull();
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
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValueOnce({ provider: "CLAUDE_CODE" });

    const state = await getAiWorkspaceSelectionState(userActor, "workspace-1");

    expect(state.activeProviderKey).toBe("claude");
  });

  it("creates a user-scoped active provider row and clears prior active rows", async () => {
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
    prismaMock.aiWorkspaceConnection.findFirst.mockResolvedValueOnce({ id: "connection-1" });

    await setActiveAiWorkspaceProvider(userActor, {
      workspaceId: "workspace-1",
      providerKey: "openwork",
    });

    expect(prismaMock.aiWorkspaceConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        displayName: "OpenWork Free",
        isDefault: true,
        healthStatus: "NEEDS_SETUP",
      },
    });
    expect(prismaMock.aiWorkspaceConnection.create).not.toHaveBeenCalled();
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
