import { describe, expect, it } from "vitest";
import { buildCursorMcpJsonConfig, buildVsCodeMcpConfig, buildCopilotCliMcpConfig, buildGeminiMcpConfig, buildInstallerPath, mcpConnectionName } from "./install-helpers";
describe("workspace MCP install identity", () => {
  it.each([buildCursorMcpJsonConfig, buildVsCodeMcpConfig, buildCopilotCliMcpConfig, buildGeminiMcpConfig])("keeps two workspaces as separate config entries", build => {
    const a = Object.values(build("https://app.example/mcp/workspaces/A"))[0];
    const b = Object.values(build("https://app.example/mcp/workspaces/B"))[0];
    expect(Object.keys({ ...a, ...b })).toEqual(["corgtex-A", "corgtex-B"]);
  });
  it("keeps explicit workspace choice through installer navigation and preserves legacy names", () => {
    expect(buildInstallerPath("claude", { workspaceId: "A" })).toContain("workspaceId=A");
    expect(mcpConnectionName("https://app.example/mcp")).toBe("corgtex");
  });
});
