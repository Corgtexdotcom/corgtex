import { describe, expect, it } from "vitest";
import { buildProviderConfig } from "./GuidedProviderInstaller";

const connectorUrl = "https://app.example/mcp/workspaces/workspace-A";

describe("workspace-specific guided MCP installers", () => {
  it("keeps ChatGPT web app setup separate from Codex MCP setup", () => {
    const chatgpt = buildProviderConfig("chatgpt", connectorUrl);
    const codex = buildProviderConfig("codex", connectorUrl);

    expect(chatgpt.primaryAction).toMatchObject({ kind: "copyAndOpen", value: connectorUrl, href: "https://chatgpt.com/" });
    expect(chatgpt.steps.join(" ")).toContain("Settings → Apps");
    expect(chatgpt.steps.join(" ")).not.toContain("Connectors");
    expect(codex.primaryAction).toMatchObject({ kind: "copy", value: `codex mcp add corgtex-workspace-A --url ${connectorUrl}` });
    expect(codex.steps.join(" ")).toContain("codex mcp login corgtex-workspace-A");
    expect(codex.apiProviderKey).toBeNull();
  });

  it("uses the documented Cursor config path and workspace name for Gemini authentication", () => {
    const cursor = buildProviderConfig("cursor", connectorUrl);
    const gemini = buildProviderConfig("gemini", connectorUrl);

    expect(cursor.primaryAction).toMatchObject({ kind: "copy", label: "Copy Cursor mcp.json" });
    expect(cursor.steps.join(" ")).toContain("mcp.json");
    expect(gemini.steps.join(" ")).toContain("/mcp auth corgtex-workspace-A");
  });
});
