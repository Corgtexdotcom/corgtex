import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@corgtex/domain", () => ({ MCP_CONNECTOR_DEFAULT_SCOPES: ["workspace:read"] }));
import { GET } from "./route";

const path = "/.well-known/oauth-protected-resource/mcp/workspaces/";
const origin = "https://mcp.example.com";
const get = (id: string, suffix = id) => GET(
  new NextRequest(`https://attacker.example${path}${suffix}`, {
    headers: { host: "attacker.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
  }),
  { params: Promise.resolve({ workspaceId: id }) },
);

describe("scoped MCP protected resource discovery", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MCP_PUBLIC_URL", `${origin}/mcp`);
    vi.stubEnv("APP_URL", "https://app.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("ignores forged request origin and emits exact configured resource metadata", async () => {
    const response = await get("seed_workspace-A");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      resource: `${origin}/mcp/workspaces/seed_workspace-A`,
      resource_name: "Corgtex", resource_documentation: `${origin}/install`,
      resource_policy_uri: `${origin}/install`, authorization_servers: [origin],
      scopes_supported: ["workspace:read"], bearer_methods_supported: ["header"],
    });
  });

  it("does not reveal existence or labels for an unknown valid ID", async () => {
    const a = await (await get("A")).json();
    const b = await (await get("nonexistent_seed")).json();
    expect({ ...a, resource: null }).toEqual({ ...b, resource: null });
  });

  it.each([["A", "%41"], ["A", "A?workspaceId=B"], ["A", "A/"], ["A", "B"], ["..", ".."], ["a/b", "a%2Fb"]])(
    "rejects path or query ambiguity %s / %s", async (id, suffix) => {
      expect((await get(id, suffix)).status).toBe(404);
    },
  );

  it("uses APP_URL fallback without trusting headers", async () => {
    vi.stubEnv("MCP_PUBLIC_URL", "");
    expect((await (await get("A")).json()).resource).toBe("https://app.example.com/mcp/workspaces/A");
  });

  it("fails closed without exposing misconfigured values", async () => {
    vi.stubEnv("MCP_PUBLIC_URL", "https://user:password@example.com/mcp");
    const response = await get("A");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "MCP discovery unavailable" });
  });

  it("rejects default localhost in production", async () => {
    vi.stubEnv("MCP_PUBLIC_URL", "");
    vi.stubEnv("APP_URL", "");
    expect((await get("A")).status).toBe(503);
  });
});
