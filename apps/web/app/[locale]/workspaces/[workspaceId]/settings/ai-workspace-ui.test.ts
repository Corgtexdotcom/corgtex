import { describe, expect, it } from "vitest";

import {
  buildAiWorkspaceSetupCards,
  capabilityLabel,
  enterpriseServiceHealthLabel,
  enterpriseServiceHealthTone,
  enterpriseServiceOwnershipLabel,
  enterpriseServiceProviderLabel,
  formatServiceTimestamp,
  groupAiWorkspaceProviders,
  normalizeSelectedProvider,
  normalizeSelectedService,
  providerGroup,
  primaryAiWorkspaceProviders,
  splitAiWorkspaceProviders,
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
  provider({
    key: "copilot",
    label: "GitHub Copilot",
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
    ownershipMode: "CORGTEX_MANAGED",
    healthStatus: "ACTIVE",
    providerKey: "RECALL_AI",
    usageLabel: "25 min this month",
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
    setupVariants: overrides.setupVariants ?? [
      {
        variantKey: `${overrides.key ?? "generic_mcp"}_default`,
        label: "Default setup",
        audience: "Users",
        primaryAction: "copy",
        manualSteps: ["Add the MCP URL."],
        limitations: [],
        verificationPrompt: "Test the connection.",
      },
    ],
  };
}

describe("AI workspace UI helpers", () => {
  it("groups OpenWork as the default and keeps BYO separate from advanced clients", () => {
    expect(providerGroup(PROVIDERS[1])).toBe("default");

    const groups = groupAiWorkspaceProviders(PROVIDERS);
    const split = splitAiWorkspaceProviders([
      ...PROVIDERS,
      provider({ key: "claude", label: "Claude", category: "BYO" }),
    ]);

    expect(groups.default.map((entry) => entry.key)).toEqual(["openwork"]);
    expect(groups.byo.map((entry) => entry.key)).toEqual(["chatgpt", "copilot"]);
    expect(groups.advanced.map((entry) => entry.key)).toEqual(["cursor"]);
    expect(split.primary.map((entry) => entry.key)).toEqual(["openwork", "claude", "chatgpt", "cursor"]);
    expect(split.advanced.map((entry) => entry.key)).toEqual(["copilot"]);
  });

  it("keeps onboarding setup limited to primary AI apps", () => {
    const primary = primaryAiWorkspaceProviders([
      provider({ key: "gemini", label: "Gemini CLI", category: "ADVANCED" }),
      provider({ key: "chatgpt", label: "ChatGPT", category: "BYO" }),
      provider({ key: "generic_mcp", label: "Generic MCP client", category: "ADVANCED" }),
      provider({ key: "cursor", label: "Cursor", category: "ADVANCED" }),
      provider({ key: "copilot", label: "GitHub Copilot", category: "BYO" }),
      provider({ key: "openwork", label: "OpenWork Free", category: "DEFAULT", recommendedDefault: true }),
      provider({ key: "claude", label: "Claude", category: "BYO" }),
    ]);

    expect(primary.map((entry) => entry.key)).toEqual(["openwork", "claude", "chatgpt", "cursor"]);
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

    expect(cards.map((card) => card.provider.key)).toEqual(["openwork", "chatgpt", "cursor", "copilot"]);
    expect(cards[0]).toMatchObject({
      group: "default",
      statusLabel: "Recommended",
      connectorUrl: "https://app.corgtex.com/mcp",
    });
    expect(cards[0].actions.map((action) => action.label)).toEqual(["Connect OpenWork", "Copy installer link"]);
    expect(cards[0].actions[0]).toMatchObject({
      kind: "open",
      href: "/install/openwork",
    });
    expect(cards[0].steps).toEqual([
      "Open the guided installer.",
      "Copy the Corgtex MCP URL and open OpenWork from the installer.",
      "When OpenWork opens Corgtex, authorize as your current Corgtex user for this workspace.",
      "Return here and verify the connection.",
    ]);
    expect(cards[0].notes).toContain("OpenWork must support dynamic client registration for the OAuth connection.");
    expect("resources" in cards[0]).toBe(false);
  });

  it("points ChatGPT setup at the guided installer instead of raw connector settings", () => {
    const cards = buildAiWorkspaceSetupCards(
      [provider({ key: "chatgpt", label: "ChatGPT", category: "BYO" })],
      "https://app.corgtex.com/mcp",
    );
    const chatgptCard = cards[0];

    expect(chatgptCard.actions[0]).toMatchObject({
      kind: "open",
      label: "Connect ChatGPT",
      href: "/install/chatgpt",
    });
    expect(JSON.stringify(chatgptCard.actions)).not.toContain("https://chatgpt.com/#settings/Connectors");
    expect(chatgptCard.steps.join(" ")).toContain("Open the guided installer");
    expect(chatgptCard.steps.join(" ")).toContain("scan tools");
    expect(chatgptCard.steps.join(" ")).toContain("Authorize as your current Corgtex user");
    expect(chatgptCard.steps.join(" ")).toContain("choose Corgtex");
  });

  it("routes provider setup actions to guided installers outside the React component", () => {
    const providers = [
      provider({ key: "claude", label: "Claude", category: "BYO" }),
      provider({ key: "cursor", label: "Cursor", category: "ADVANCED" }),
      provider({ key: "gemini", label: "Gemini CLI", category: "ADVANCED" }),
    ];

    const cards = buildAiWorkspaceSetupCards(providers, "https://app.corgtex.com/mcp");
    const cursorCard = cards.find((card) => card.provider.key === "cursor");
    const geminiCard = cards.find((card) => card.provider.key === "gemini");
    const claudeCard = cards.find((card) => card.provider.key === "claude");

    expect(claudeCard?.actions.map((action) => action.kind)).toEqual([
      "open",
      "copy",
    ]);
    expect(claudeCard?.advancedSection?.actions.find((action) => action.label === "Open Claude Code installer")).toMatchObject({
      kind: "open",
      href: "/install/claude-code",
    });
    expect(claudeCard?.advancedSection?.steps).toContain("Open Claude Code and run /mcp.");
    expect(cursorCard?.actions[0]).toMatchObject({
      kind: "open",
      label: "Connect Cursor",
      href: "/install/cursor",
    });
    expect(geminiCard?.actions.find((action) => action.label === "Connect Gemini")).toMatchObject({
      kind: "open",
      href: "/install/gemini",
    });
  });

  it("adds workspace context to the Claude installer link when available", () => {
    const cards = buildAiWorkspaceSetupCards(
      [provider({ key: "claude", label: "Claude", category: "BYO" })],
      "https://app.corgtex.com/mcp",
      "https://app.corgtex.com",
      "workspace-1",
    );
    const claudeCard = cards[0];

    expect(claudeCard.actions[0]).toMatchObject({
      kind: "open",
      href: "/install/claude?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%2Fsettings%3Ftab%3Dai-workspaces%26provider%3Dclaude",
    });
    expect(claudeCard.actions.find((action) => action.label === "Copy installer link")).toMatchObject({
      value: "https://app.corgtex.com/install/claude?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%2Fsettings%3Ftab%3Dai-workspaces%26provider%3Dclaude",
    });
  });

  it("can point Claude setup back to onboarding without exposing Settings links", () => {
    const cards = buildAiWorkspaceSetupCards(
      [
        provider({ key: "openwork", label: "OpenWork Free", category: "DEFAULT", recommendedDefault: true }),
        provider({ key: "claude", label: "Claude", category: "BYO" }),
        provider({ key: "chatgpt", label: "ChatGPT", category: "BYO" }),
        provider({ key: "cursor", label: "Cursor", category: "ADVANCED" }),
      ],
      "https://app.corgtex.com/mcp",
      "https://app.corgtex.com",
      "workspace-1",
      {
        returnTo: "/workspaces/workspace-1?onboarding=setup",
        includeClaudeAdvanced: false,
      },
    );
    const claudeCard = cards.find((card) => card.provider.key === "claude");
    const serializedCards = JSON.stringify(cards);

    expect(claudeCard?.actions[0]).toMatchObject({
      kind: "open",
      href: "/install/claude?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%3Fonboarding%3Dsetup",
    });
    expect(claudeCard?.actions.find((action) => action.label === "Copy installer link")).toMatchObject({
      value: "https://app.corgtex.com/install/claude?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%3Fonboarding%3Dsetup",
    });
    expect(claudeCard?.advancedSection).toBeUndefined();
    expect(serializedCards).not.toContain("/settings?tab=ai-workspaces");
  });

  it("keeps provider guidance compact and avoids offering Copilot cloud-agent OAuth setup", () => {
    const providers = [
      provider({ key: "chatgpt", label: "ChatGPT", category: "BYO" }),
      provider({ key: "claude", label: "Claude", category: "BYO" }),
      provider({ key: "copilot", label: "GitHub Copilot", category: "BYO" }),
      provider({ key: "gemini", label: "Gemini CLI", category: "ADVANCED" }),
      provider({ key: "cursor", label: "Cursor", category: "ADVANCED" }),
      provider({ key: "generic_mcp", label: "Generic MCP client", category: "ADVANCED" }),
    ];

    const cards = buildAiWorkspaceSetupCards(providers, "https://app.corgtex.com/mcp", "https://app.corgtex.com");

    for (const providerKey of ["chatgpt", "claude", "copilot", "gemini", "cursor", "generic_mcp"]) {
      const card = cards.find((entry) => entry.provider.key === providerKey);

      expect(card?.steps.length).toBeGreaterThan(0);
      expect(card?.steps.length).toBeLessThanOrEqual(4);
      expect("resources" in (card ?? {})).toBe(false);
      expect("verificationChecks" in (card ?? {})).toBe(false);
    }

    const copilotCard = cards.find((entry) => entry.provider.key === "copilot");
    expect(Object.fromEntries(cards.map((card) => [card.provider.key, card.actions[0]]))).toMatchObject({
      chatgpt: { kind: "open", href: "/install/chatgpt" },
      claude: { kind: "open", href: "/install/claude" },
      copilot: { kind: "open", href: "/install/copilot" },
      gemini: { kind: "open", href: "/install/gemini" },
      cursor: { kind: "open", href: "/install/cursor" },
      generic_mcp: { kind: "open", href: "/install/generic-mcp" },
    });
    expect(copilotCard?.actions.map((action) => action.label)).toEqual([
      "Connect Copilot",
      "Copy installer link",
    ]);
    expect(copilotCard?.actions[0]).toMatchObject({
      kind: "open",
      href: "/install/copilot",
    });
    expect(copilotCard?.notes.join(" ")).toContain("OAuth-backed remote MCP is not supported");
    expect(copilotCard?.steps.join(" ")).not.toContain("repository");
  });

  it("formats known and unknown capability labels", () => {
    expect(capabilityLabel("remote_mcp")).toBe("Remote MCP");
    expect(capabilityLabel("custom_mode")).toBe("custom mode");
  });

  it("formats enterprise service ownership, health, provider, and timestamps", () => {
    expect(enterpriseServiceOwnershipLabel("CORGTEX_MANAGED")).toBe("CORGTEX-managed");
    expect(enterpriseServiceOwnershipLabel("CUSTOMER_MANAGED")).toBe("Customer-managed");
    expect(enterpriseServiceHealthLabel("DISCONNECTED")).toBe("Disconnected");
    expect(enterpriseServiceHealthTone("ACTIVE")).toBe("success");
    expect(enterpriseServiceHealthTone("UNHEALTHY")).toBe("danger");
    expect(enterpriseServiceProviderLabel("RECALL_AI")).toBe("recall ai");
    expect(formatServiceTimestamp(null)).toBe("Not recorded");
    expect(formatServiceTimestamp("not-a-date")).toBe("Not recorded");
  });
});
