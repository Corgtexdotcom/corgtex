import { describe, expect, it } from "vitest";
import { buildCodexMcpCommand, buildCopilotCliCommand, buildCursorMcpJsonConfig, buildVsCodeMcpConfig, buildCopilotCliMcpConfig, buildGeminiMcpCommand, buildGeminiMcpConfig, buildInstallerPath, mcpConnectionName } from "./install-helpers";
describe("workspace MCP install identity", () => {
  it.each([buildCursorMcpJsonConfig, buildVsCodeMcpConfig, buildCopilotCliMcpConfig, buildGeminiMcpConfig])("keeps two workspaces as separate config entries", build => {
    const a = Object.values(build("https://app.example/mcp/workspaces/A"))[0];
    const b = Object.values(build("https://app.example/mcp/workspaces/B"))[0];
    expect(Object.keys({ ...a, ...b })).toEqual(["corgtex-A", "corgtex-B"]);
  });
  it("keeps explicit workspace choice through installer navigation and preserves legacy names", () => {
    expect(buildInstallerPath("claude", { workspaceId: "A" })).toContain("workspaceId=A");
    expect(buildInstallerPath("codex", { workspaceId: "A" })).toBe("/install/codex?workspaceId=A");
    expect(mcpConnectionName("https://app.example/mcp")).toBe("corgtex");
  });

  it("uses each selected workspace in supported CLI commands", () => {
    const url = "https://app.example/mcp/workspaces/A";
    expect(buildCodexMcpCommand(url)).toBe(`codex mcp add corgtex-A --url ${url}`);
    expect(buildCopilotCliCommand(url)).toBe(`copilot mcp add --transport http corgtex-A ${url}`);
    expect(buildGeminiMcpCommand(url)).toBe(`gemini mcp add --transport http --scope user corgtex-A ${url}`);
  });
});
