/**
 * Pure helpers for building MCP install links and commands.
 * Shared between server components (`/install/*` pages) and client components
 * (CorgtexConnectorManager) so neither pulls in the other's bundle.
 */

export type CursorMcpConfig = {
  type: "http";
  url: string;
};

export type CursorMcpJsonConfig = {
  mcpServers: {
    corgtex: CursorMcpConfig;
  };
};

export type VsCodeMcpConfig = {
  servers: {
    corgtex: {
      type: "http";
      url: string;
    };
  };
};

export type CopilotCliMcpConfig = {
  mcpServers: {
    corgtex: {
      type: "http";
      url: string;
      tools: string[];
    };
  };
};

export type GeminiMcpConfig = {
  mcpServers: {
    corgtex: {
      httpUrl: string;
    };
  };
};

export function buildCursorMcpConfig(connectorUrl: string): CursorMcpConfig {
  return {
    type: "http",
    url: connectorUrl,
  };
}

export function buildCursorMcpJsonConfig(connectorUrl: string): CursorMcpJsonConfig {
  return {
    mcpServers: {
      corgtex: buildCursorMcpConfig(connectorUrl),
    },
  };
}

export function buildVsCodeMcpConfig(connectorUrl: string): VsCodeMcpConfig {
  return {
    servers: {
      corgtex: {
        type: "http",
        url: connectorUrl,
      },
    },
  };
}

export function buildCopilotCliMcpConfig(connectorUrl: string): CopilotCliMcpConfig {
  return {
    mcpServers: {
      corgtex: {
        type: "http",
        url: connectorUrl,
        tools: ["*"],
      },
    },
  };
}

export function buildGeminiMcpConfig(connectorUrl: string): GeminiMcpConfig {
  return {
    mcpServers: {
      corgtex: {
        httpUrl: connectorUrl,
      },
    },
  };
}

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += alphabet[(chunk >> 18) & 63];
    output += alphabet[(chunk >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
  }

  return output;
}

export function buildCursorInstallLinks(connectorUrl: string): { app: string; browser: string } {
  const encodedConfig = encodeURIComponent(encodeBase64Utf8(JSON.stringify(buildCursorMcpConfig(connectorUrl))));
  const name = encodeURIComponent("Corgtex");

  return {
    app: `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${encodedConfig}`,
    browser: `https://cursor.com/en/install-mcp?name=${name}&config=${encodedConfig}`,
  };
}

export function buildClaudeCodeCommand(connectorUrl: string): string {
  return `claude mcp add --transport http corgtex --scope user ${connectorUrl}`;
}

export function buildCopilotCliCommand(connectorUrl: string): string {
  return `copilot mcp add corgtex --type http --url ${connectorUrl} --tools "*"`;
}

export function buildGeminiMcpCommand(connectorUrl: string): string {
  return `gemini mcp add --transport http --scope user corgtex ${connectorUrl}`;
}

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";
export const CLAUDE_CHAT_URL = "https://claude.ai/new";
export const CHATGPT_CHAT_URL = "https://chatgpt.com/";
export const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";
export const CHATGPT_CONNECTORS_ADVANCED_URL = "https://chatgpt.com/#settings/Connectors/Advanced";
export const COPILOT_DOCS_URL = "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference";
export const COPILOT_VSCODE_MCP_DOCS_URL = "https://code.visualstudio.com/docs/copilot/chat/mcp-servers";
export const CURSOR_MCP_DOCS_URL = "https://docs.cursor.com/context/model-context-protocol";
export const GEMINI_MCP_DOCS_URL = "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html";
export const OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download";

/**
 * Path to the hosted Claude installer landing page. Use this from anywhere
 * we want to send a non-technical user to the "Add to Claude" flow.
 *
 * The page itself works without auth, so it's safe to share publicly
 * (Slack, email) — the connector URL is also non-secret.
 */
export const CLAUDE_INSTALLER_PATH = "/install/claude";
export const CLAUDE_CODE_INSTALLER_PATH = "/install/claude-code";
export const INSTALL_INDEX_PATH = "/install";

export function buildClaudeInstallerShareUrl(origin?: string | null): string {
  const trimmedOrigin = origin?.trim().replace(/\/$/, "");
  return trimmedOrigin ? `${trimmedOrigin}${CLAUDE_INSTALLER_PATH}` : CLAUDE_INSTALLER_PATH;
}
