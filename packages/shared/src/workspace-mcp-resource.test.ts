import { describe, expect, it } from "vitest";
import {
  isWorkspaceMcpId, parseWorkspaceMcpResource, workspaceMcpMetadataUrl,
  workspaceMcpOrigin, workspaceMcpResource,
} from "./workspace-mcp-resource";

const origin = "https://mcp.example.com";

describe("workspace MCP canonical resource", () => {
  it.each(["workspace_seed-123", "A", "a", "opaque.id~1", "a19ef3b6-42f0-4f57-b111-985b3bc53a01"])(
    "round trips opaque ID %s without a UUID assumption", (id) => {
      const resource = workspaceMcpResource(origin, id);
      expect(resource).toBe(`${origin}/mcp/workspaces/${id}`);
      expect(parseWorkspaceMcpResource(resource, origin)).toBe(id);
      expect(workspaceMcpMetadataUrl(origin, id)).toBe(
        `${origin}/.well-known/oauth-protected-resource/mcp/workspaces/${id}`,
      );
    },
  );

  it.each(["", ".", "..", "a/b", "a\\b", "%41", "%2f", "%252f", "a?b", "a#b", "a b", "a\n", "é"])(
    "rejects ambiguous/unsupported path ID %j", (id) => {
      expect(isWorkspaceMcpId(id)).toBe(false);
      expect(() => workspaceMcpResource(origin, id)).toThrow();
    },
  );

  it.each([
    `${origin}/mcp`, `${origin}/api/mcp`, `${origin}/mcp?workspaceId=A`,
    `${origin}/mcp/workspaces/A/`, `${origin}/mcp/workspaces/A?workspaceId=B`,
    `${origin}/mcp/workspaces/A#B`, `${origin}/mcp/workspaces/%41`,
    `${origin}/mcp/workspaces/a/../A`, `${origin}/mcp/workspaces/a\\..\\A`,
    `${origin}/mcp/workspaces/A\n`, `${origin}:443/mcp/workspaces/A`,
    "https://MCP.example.com/mcp/workspaces/A", "https://evil.example/mcp/workspaces/A",
    "https://mcp.example.com.evil.example/mcp/workspaces/A",
    "https://mcp.example.com@evil.example/mcp/workspaces/A",
  ])("rejects forged or noncanonical resource %j", (value) => {
    expect(parseWorkspaceMcpResource(value, origin)).toBeNull();
  });

  it("keeps workspace case and distinct IDs distinct", () => {
    expect(workspaceMcpResource(origin, "A")).not.toBe(workspaceMcpResource(origin, "a"));
    expect(parseWorkspaceMcpResource(`${origin}/mcp/workspaces/B`, origin)).toBe("B");
  });
});

describe("trusted MCP origin configuration", () => {
  it.each(["", "/", "/mcp", "/mcp/", "/api/mcp", "/api/mcp/"])(
    "uses configured MCP origin from %j", (path) => {
      expect(workspaceMcpOrigin({ mcpPublicUrl: `${origin}${path}`, appUrl: "https://app.example.com" })).toBe(origin);
    },
  );
  it("falls back only to configured APP_URL", () => {
    expect(workspaceMcpOrigin({ appUrl: `${origin}/` })).toBe(origin);
  });
  it.each([
    "https://user:password@mcp.example.com/mcp", `${origin}/mcp?x=1`, `${origin}/mcp#x`,
    `${origin}/mcp?`, `${origin}/mcp#`, `${origin}/x/../mcp`, `${origin}/%6dcp`,
    `${origin}/mcp/workspaces/A`, "http://mcp.example.com/mcp", "//mcp.example.com/mcp",
    `${origin}/mcp\n`, "https://MCP.example.com/mcp",
  ])("fails closed for configuration %j", (mcpPublicUrl) => {
    expect(() => workspaceMcpOrigin({ mcpPublicUrl, appUrl: origin })).toThrow();
  });
  it("permits loopback HTTP only with explicit local policy", () => {
    expect(() => workspaceMcpOrigin({ appUrl: "http://localhost:3000" })).toThrow();
    expect(workspaceMcpOrigin({ appUrl: "http://localhost:3000", allowLocalHttp: true })).toBe("http://localhost:3000");
    expect(() => workspaceMcpOrigin({ appUrl: "http://example.com", allowLocalHttp: true })).toThrow();
  });
});
