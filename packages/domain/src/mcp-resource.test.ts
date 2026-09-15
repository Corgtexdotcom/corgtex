import { describe, expect, it, vi } from "vitest";
vi.mock("@corgtex/shared", () => ({ env: { APP_URL: "https://app.example.test", MCP_PUBLIC_URL: undefined, MCP_WORKSPACE_CONNECTIONS_ENABLED: true } }));
import { getWorkspaceMcpResource, getWorkspaceMcpMetadataUrl, validateMcpConsentResource, workspaceFromMcpResource } from "./mcp-resource";

describe("canonical workspace MCP resource", () => {
  it("uses immutable workspace identity and path-specific public discovery", () => {
    expect(getWorkspaceMcpResource("workspace-A")).toBe("https://app.example.test/mcp/workspaces/workspace-A");
    expect(getWorkspaceMcpMetadataUrl("workspace-A")).toBe("https://app.example.test/.well-known/oauth-protected-resource/mcp/workspaces/workspace-A");
    expect(validateMcpConsentResource(getWorkspaceMcpResource("workspace-A"), "workspace-A")).toBe("workspace-A");
    expect(() => validateMcpConsentResource(getWorkspaceMcpResource("workspace-A"), "workspace-B")).toThrow();
  });
  it.each([
    "https://foreign.example/mcp/workspaces/workspace-A", "https://app.example.test/api/mcp/workspaces/workspace-A",
    "https://app.example.test/mcp/workspaces/workspace-A/", "https://app.example.test/mcp/workspaces/workspace-A?workspaceId=workspace-B",
    "https://app.example.test/mcp/workspaces/workspace-A#fragment", "https://app.example.test/mcp/workspaces/%77orkspace-A",
    "https://app.example.test:443/mcp/workspaces/workspace-A", "https://app.example.test/mcp/workspaces/../workspace-A",
  ])("rejects a noncanonical or widened resource: %s", resource => {
    expect(workspaceFromMcpResource(resource)).toBeNull();
    expect(() => validateMcpConsentResource(resource)).toThrow();
  });
  it("permits only the two explicit legacy aliases", () => {
    expect(validateMcpConsentResource("https://app.example.test/mcp", "workspace-A")).toBeNull();
    expect(validateMcpConsentResource("https://app.example.test/api/mcp", "workspace-A")).toBeNull();
    expect(() => getWorkspaceMcpResource("A/B")).toThrow();
  });
});
