import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  buildClaudeCodeCommand,
  buildClaudeInstallerShareUrl,
  buildCopilotCliCommand,
  buildCopilotCliMcpConfig,
  buildCursorInstallLinks,
  buildCursorMcpConfig,
  buildCursorMcpJsonConfig,
  buildGeminiMcpCommand,
  buildGeminiMcpConfig,
  buildInstallerPath,
  buildInstallerShareUrl,
  buildVsCodeMcpConfig,
  CHATGPT_CHAT_URL,
  CHATGPT_CONNECTORS_ADVANCED_URL,
  CHATGPT_CONNECTORS_URL,
  CLAUDE_CHAT_URL,
  CLAUDE_CONNECTORS_URL,
  CLAUDE_INSTALLER_PATH,
  encodeBase64Utf8,
  installerProviderSlug,
} from "@/lib/install-helpers";

const CONNECTOR_URL = "https://mcp.corgtex.com/mcp";

function decodeCursorConfig(link: string): unknown {
  const url = new URL(link);
  const encodedConfig = url.searchParams.get("config");
  if (!encodedConfig) throw new Error("Missing config");

  return JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
}

describe("CorgtexConnectorManager setup helpers", () => {
  it("builds the Cursor MCP config expected by Cursor install links", () => {
    expect(buildCursorMcpConfig(CONNECTOR_URL)).toEqual({
      type: "http",
      url: CONNECTOR_URL,
    });
    expect(buildCursorMcpJsonConfig(CONNECTOR_URL)).toEqual({
      mcpServers: {
        corgtex: {
          type: "http",
          url: CONNECTOR_URL,
        },
      },
    });
  });

  it("encodes Cursor install links with the production connector URL", () => {
    const links = buildCursorInstallLinks(CONNECTOR_URL);

    expect(links.app).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/);
    expect(links.browser).toMatch(/^https:\/\/cursor\.com\/en\/install-mcp\?/);
    expect(new URL(links.app).searchParams.get("name")).toBe("Corgtex");
    expect(new URL(links.browser).searchParams.get("name")).toBe("Corgtex");
    expect(decodeCursorConfig(links.app)).toEqual({
      type: "http",
      url: CONNECTOR_URL,
    });
    expect(decodeCursorConfig(links.browser)).toEqual({
      type: "http",
      url: CONNECTOR_URL,
    });
  });

  it("uses deterministic UTF-8 base64 encoding", () => {
    expect(encodeBase64Utf8(JSON.stringify({ type: "http", url: CONNECTOR_URL }))).toBe(
      Buffer.from(JSON.stringify({ type: "http", url: CONNECTOR_URL }), "utf8").toString("base64"),
    );
  });

  it("builds the Claude Code user-scope command", () => {
    expect(buildClaudeCodeCommand(CONNECTOR_URL)).toBe(
      "claude mcp add --transport http corgtex --scope user https://mcp.corgtex.com/mcp",
    );
  });

  it("builds Copilot and VS Code MCP setup snippets", () => {
    expect(buildCopilotCliCommand(CONNECTOR_URL)).toBe(
      "copilot mcp add corgtex --type http --url https://mcp.corgtex.com/mcp --tools \"*\"",
    );
    expect(buildCopilotCliMcpConfig(CONNECTOR_URL)).toEqual({
      mcpServers: {
        corgtex: {
          type: "http",
          url: CONNECTOR_URL,
          tools: ["*"],
        },
      },
    });
    expect(buildVsCodeMcpConfig(CONNECTOR_URL)).toEqual({
      servers: {
        corgtex: {
          type: "http",
          url: CONNECTOR_URL,
        },
      },
    });
  });

  it("builds Gemini CLI Streamable HTTP MCP settings", () => {
    expect(buildGeminiMcpCommand(CONNECTOR_URL)).toBe(
      "gemini mcp add --transport http --scope user corgtex https://mcp.corgtex.com/mcp",
    );
    expect(buildGeminiMcpConfig(CONNECTOR_URL)).toEqual({
      mcpServers: {
        corgtex: {
          httpUrl: CONNECTOR_URL,
        },
      },
    });
  });

  it("opens Claude's current connector settings address", () => {
    expect(CLAUDE_CONNECTORS_URL).toBe("https://claude.ai/customize/connectors");
  });

  it("opens ChatGPT connector settings for developer-mode MCP apps", () => {
    expect(CHATGPT_CONNECTORS_URL).toBe("https://chatgpt.com/#settings/Connectors");
    expect(CHATGPT_CONNECTORS_ADVANCED_URL).toBe("https://chatgpt.com/#settings/Connectors/Advanced");
    expect(CHATGPT_CHAT_URL).toBe("https://chatgpt.com/");
  });

  it("opens a new Claude chat from connected rail state", () => {
    expect(CLAUDE_CHAT_URL).toBe("https://claude.ai/new");
  });

  it("builds a hydration-safe Claude installer share URL", () => {
    expect(buildClaudeInstallerShareUrl()).toBe(CLAUDE_INSTALLER_PATH);
    expect(buildClaudeInstallerShareUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com/install/claude");
  });

  it("builds guided installer paths and share URLs for visible AI tools", () => {
    expect(installerProviderSlug("claude_code")).toBe("claude-code");
    expect(installerProviderSlug("generic_mcp")).toBe("generic-mcp");
    expect(buildInstallerPath("chatgpt")).toBe("/install/chatgpt");
    expect(buildInstallerPath("generic_mcp", {
      workspaceId: "workspace-1",
      returnTo: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=generic_mcp",
    })).toBe(
      "/install/generic-mcp?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%2Fsettings%3Ftab%3Dai-workspaces%26provider%3Dgeneric_mcp",
    );
    expect(buildInstallerShareUrl("https://app.corgtex.com/", "cursor", {
      workspaceId: "workspace-1",
      returnTo: "/workspaces/workspace-1/settings?tab=ai-workspaces&provider=cursor",
    })).toBe(
      "https://app.corgtex.com/install/cursor?workspaceId=workspace-1&returnTo=%2Fworkspaces%2Fworkspace-1%2Fsettings%3Ftab%3Dai-workspaces%26provider%3Dcursor",
    );
  });
});
