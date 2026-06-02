import { describe, expect, it } from "vitest";

import {
  buildAiWorkspaceSetupCards,
  capabilityLabel,
  groupAiWorkspaceProviders,
  normalizeSelectedProvider,
  normalizeSelectedService,
  providerGroup,
  type AiWorkspaceProviderView,
  type EnterpriseServiceView,
} from "./ai-workspace-ui";

const PROVIDERS: AiWorkspaceProviderView[] = [
  provider({
    key: "cursor",
    label: "Cursor",
    category: "ADVANCED",
    recommendedDefault: false,
  }),
  provider({
    key: "openwork",
    label: "OpenWork Free",
    category: "DEFAULT",
    recommendedDefault: true,
    freeDefault: true,
    setupPath: "guided",
    capabilities: ["remote_mcp", "write_back"],
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED", "CORGTEX_MANAGED"],
  }),
  provider({
    key: "chatgpt",
    label: "ChatGPT",
    category: "BYO",
    recommendedDefault: false,
  }),
];

const SERVICES: EnterpriseServiceView[] = [
  {
    key: "ai_workspace",
    label: "Managed AI workspace",
    outcome: "Operate shared setup.",
    description: "Managed service",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  },
];

function provider(overrides: Partial<AiWorkspaceProviderView>): AiWorkspaceProviderView {
  return {
    key: overrides.key ?? "generic_mcp",
    label: overrides.label ?? "Generic MCP client",
    shortLabel: overrides.shortLabel ?? overrides.label ?? "MCP",
    outcome: overrides.outcome ?? "Connect Corgtex context.",
    description: overrides.description ?? "Setup path",
    category: overrides.category ?? "ADVANCED",
    recommendedDefault: overrides.recommendedDefault ?? false,
    freeDefault: overrides.freeDefault ?? false,
    setupPath: overrides.setupPath ?? "recipe",
    capabilities: overrides.capabilities ?? ["remote_mcp"],
    supportedOwnershipModes: overrides.supportedOwnershipModes ?? ["USER_MANAGED", "WORKSPACE_MANAGED"],
  };
}

describe("AI workspace UI helpers", () => {
  it("groups OpenWork as the default and keeps BYO separate from advanced clients", () => {
    expect(providerGroup(PROVIDERS[1])).toBe("default");

    const groups = groupAiWorkspaceProviders(PROVIDERS);

    expect(groups.default.map((entry) => entry.key)).toEqual(["openwork"]);
    expect(groups.byo.map((entry) => entry.key)).toEqual(["chatgpt"]);
    expect(groups.advanced.map((entry) => entry.key)).toEqual(["cursor"]);
  });

  it("normalizes selected provider and service values from URL params", () => {
    expect(normalizeSelectedProvider("chatgpt", PROVIDERS)).toBe("chatgpt");
    expect(normalizeSelectedProvider(["cursor", "chatgpt"], PROVIDERS)).toBe("cursor");
    expect(normalizeSelectedProvider("unknown", PROVIDERS)).toBe("openwork");
    expect(normalizeSelectedService("ai_workspace", SERVICES)).toBe("ai_workspace");
    expect(normalizeSelectedService("unknown", SERVICES)).toBeNull();
  });

  it("builds OpenWork setup before BYO providers with the Corgtex MCP URL", () => {
    const cards = buildAiWorkspaceSetupCards(PROVIDERS, "https://app.corgtex.com/mcp", "https://app.corgtex.com");

    expect(cards.map((card) => card.provider.key)).toEqual(["openwork", "chatgpt", "cursor"]);
    expect(cards[0]).toMatchObject({
      group: "default",
      statusLabel: "Recommended default",
      connectorUrl: "https://app.corgtex.com/mcp",
    });
    expect(cards[0].actions.map((action) => action.label)).toEqual([
      "Copy MCP URL",
      "Copy instructions",
      "Copy test prompt",
      "Open OpenWork",
      "View source",
    ]);
    expect(cards[0].resources.map((resource) => resource.label)).toEqual(["Instructions package", "Test prompt"]);
    expect(cards[0].resources[0].value).toContain("Corgtex MCP server: https://app.corgtex.com/mcp");
    expect(cards[0].resources[0].value).toContain("get_execution_packet");
    expect(cards[0].resources[0].value).toContain("submit_execution_result");
    expect(cards[0].resources[1].value).toContain("Do not submit a result or create a write-back");
    expect(cards[0].verificationChecks).toContain("Execution packet tools are visible for governed work requests.");
  });

  it("builds provider-specific computed install actions outside the React component", () => {
    const providers = [
      provider({ key: "claude", label: "Claude", category: "BYO" }),
      provider({ key: "cursor", label: "Cursor", category: "ADVANCED" }),
      provider({ key: "claude_code", label: "Claude Code", category: "ADVANCED" }),
    ];

    const cards = buildAiWorkspaceSetupCards(providers, "https://app.corgtex.com/mcp");

    expect(cards.find((card) => card.provider.key === "claude")?.actions.map((action) => action.kind)).toEqual([
      "open",
      "copyAndOpen",
      "copy",
    ]);
    expect(cards.find((card) => card.provider.key === "cursor")?.actions[0]).toMatchObject({
      kind: "cursorInstall",
      label: "Add to Cursor",
    });
    expect(cards.find((card) => card.provider.key === "claude_code")?.command).toBe(
      "claude mcp add --transport http corgtex --scope user https://app.corgtex.com/mcp",
    );
  });

  it("formats known and unknown capability labels", () => {
    expect(capabilityLabel("remote_mcp")).toBe("Remote MCP");
    expect(capabilityLabel("custom_mode")).toBe("custom mode");
  });
});
