import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  buildClaudeCodeCommand,
  buildCursorInstallLinks,
  buildCursorMcpConfig,
  encodeBase64Utf8,
} from "./CorgtexConnectorManager";

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
});
