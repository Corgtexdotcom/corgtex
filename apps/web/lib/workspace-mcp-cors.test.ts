import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { withWorkspaceMcpCors, workspaceMcpPreflight } from "./workspace-mcp-cors";

afterEach(() => vi.unstubAllEnvs());
const request = (origin = "https://site.example.test") => new NextRequest("https://mcp.example.test/mcp/workspaces/opaque-id", { headers: { Origin: origin } });
describe("workspace MCP scoped CORS", () => {
  it("permits only the configured site and exposes the authentication challenge on errors", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.test");
    const preflight = await workspaceMcpPreflight(request());
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example.test");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Protocol-Version");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    for (const status of [200, 400, 401, 403, 500]) {
      const response = await withWorkspaceMcpCors(request(), async () => NextResponse.json({}, { status, headers: { "WWW-Authenticate": "Bearer resource_metadata=test" } }));
      expect(response.status).toBe(status);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example.test");
      expect(response.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
    }
    const run = vi.fn();
    for (const origin of ["https://evil.test", "null", "https://site.example.test.evil.test"]) {
      const denied = await withWorkspaceMcpCors(request(origin), run);
      expect(denied.status).toBe(403);
      expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("restricts discovery methods and fails closed on malformed configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.test/");
    expect((await workspaceMcpPreflight(request(), "GET, OPTIONS")).headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.test/path");
    expect((await workspaceMcpPreflight(request())).status).toBe(503);
  });
});
