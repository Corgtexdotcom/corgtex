import { describe, expect, it } from "vitest";

import {
  activeAiWorkspaceConnection,
  activeAiWorkspaceProvider,
  aiWorkspaceConnectionForProvider,
  connectedAiWorkspaceConnections,
  aiWorkspaceLaunchUrl,
  isAiWorkspaceConnected,
  pendingAiWorkspaceConnections,
  aiWorkspaceSettingsHref,
  buildExecutionRequestHandoffPrompt,
  buildExecutionRequestPayload,
  writebackOptionLabel,
} from "./ai-workspace-launch";

describe("ai workspace launch helpers", () => {
  it("resolves OpenWork launch and settings links without modeling provider state in UI", () => {
    expect(aiWorkspaceLaunchUrl("openwork")).toBe("https://openworklabs.com/download");
    expect(aiWorkspaceLaunchUrl("chatgpt")).toBe("https://chatgpt.com/");
    expect(aiWorkspaceLaunchUrl("copilot")).toBe("https://code.visualstudio.com/docs/copilot/chat/mcp-servers");
    expect(aiWorkspaceLaunchUrl("generic_mcp")).toBeNull();
    expect(aiWorkspaceSettingsHref("workspace-1", "openwork")).toBe(
      "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=openwork",
    );
  });

  it("resolves the active provider only after a tool is chosen", () => {
    const providers = [
      {
        key: "openwork",
        label: "OpenWork Free",
        shortLabel: "OpenWork",
        outcome: "Default",
        description: "Default",
        recommendedDefault: true,
        freeDefault: true,
        setupVariants: [],
      },
      {
        key: "copilot",
        label: "GitHub Copilot",
        shortLabel: "Copilot",
        outcome: "BYO",
        description: "BYO",
        recommendedDefault: false,
        freeDefault: false,
        setupVariants: [],
      },
    ];

    expect(activeAiWorkspaceProvider({ activeProviderKey: null, providers, connections: [] })).toBeNull();
    expect(activeAiWorkspaceProvider({ activeProviderKey: "copilot", providers, connections: [] })?.shortLabel).toBe("Copilot");
    expect(activeAiWorkspaceProvider({ activeProviderKey: "missing", providers, connections: [] })).toBeNull();
  });

  it("separates connected and pending app rows", () => {
    const state = {
      activeProviderKey: "claude",
      providers: [],
      connections: [
        {
          providerKey: "claude",
          healthStatus: "CONNECTED",
          isDefault: true,
          connectedAt: "2026-06-12T12:00:00.000Z",
          lastCheckedAt: "2026-06-12T12:00:00.000Z",
          verificationSource: "mcp_oauth:claude",
        },
        {
          providerKey: "chatgpt",
          healthStatus: "NEEDS_SETUP",
          isDefault: false,
          connectedAt: null,
          lastCheckedAt: null,
          verificationSource: null,
        },
      ],
    };

    expect(activeAiWorkspaceConnection(state)?.providerKey).toBe("claude");
    expect(aiWorkspaceConnectionForProvider(state, "chatgpt")?.healthStatus).toBe("NEEDS_SETUP");
    expect(connectedAiWorkspaceConnections(state).map((connection) => connection.providerKey)).toEqual(["claude"]);
    expect(pendingAiWorkspaceConnections(state).map((connection) => connection.providerKey)).toEqual(["chatgpt"]);
    expect(isAiWorkspaceConnected(state.connections[0])).toBe(true);
    expect(isAiWorkspaceConnected(state.connections[1])).toBe(false);
  });

  it("builds governed execution request payloads for the existing API", () => {
    expect(buildExecutionRequestPayload({
      goal: "  Draft the follow-up plan  ",
      providerKey: "openwork",
      surface: "mobile_work",
      currentPath: "/workspaces/workspace-1/actions",
      writebackTargetType: "ACTION",
      idempotencyKey: "ui-key",
    })).toMatchObject({
      goal: "Draft the follow-up plan",
      provider: "openwork",
      context: {
        source: "corgtex-ui",
        surface: "mobile_work",
        currentPath: "/workspaces/workspace-1/actions",
      },
      writebackTargetType: "ACTION",
      writebackTargetLabel: "New action",
      idempotencyKey: "ui-key",
    });
  });

  it("builds handoff prompts that keep execution and write-back governed", () => {
    const prompt = buildExecutionRequestHandoffPrompt({
      requestId: "request-1",
      providerLabel: "OpenWork Free",
      goal: "Draft launch checklist",
      writebackTargetLabel: "New action",
    });

    expect(prompt).toContain("request-1");
    expect(prompt).toContain("get_execution_packet");
    expect(prompt).toContain("list_writeback_targets");
    expect(prompt).toContain("submit_execution_result");
    expect(prompt).toContain("Do not write directly to unsupported destinations");
  });

  it("labels known and unknown write-back options", () => {
    expect(writebackOptionLabel("BRAIN_ARTICLE")).toBe("Brain article");
    expect(writebackOptionLabel("UNKNOWN")).toBe("Execution result");
  });
});
