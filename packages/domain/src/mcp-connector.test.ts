import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("MCP connector registry", () => {
  it("defaults the current Crina deployment to a registered active instance", async () => {
    restoreEnv();
    Object.assign(process.env, {
      APP_URL: "https://crina.corgtex.com",
      WORKSPACE_SLUG: "crina",
    });

    const { listMcpConnectorInstances } = await import("./mcp-connector");
    expect(listMcpConnectorInstances()).toEqual([
      expect.objectContaining({
        slug: "crina",
        displayName: "Crina",
        baseUrl: "https://crina.corgtex.com",
        workspaceSlugs: ["crina"],
        status: "active",
      }),
    ]);
  });

  it("reads explicitly registered instances from MCP_INSTANCE_REGISTRY", async () => {
    restoreEnv();
    Object.assign(process.env, {
      APP_URL: "https://app.corgtex.com",
      MCP_INSTANCE_REGISTRY: JSON.stringify([
        {
          slug: "crina",
          displayName: "Crina",
          baseUrl: "https://crina.corgtex.com/",
          workspaceSlugs: ["crina"],
          status: "active",
        },
      ]),
    });

    const { listMcpConnectorInstances } = await import("./mcp-connector");
    expect(listMcpConnectorInstances()).toEqual([
      expect.objectContaining({
        slug: "crina",
        displayName: "Crina",
        baseUrl: "https://crina.corgtex.com",
        workspaceSlugs: ["crina"],
      }),
    ]);
  });

  it("treats /mcp and /api/mcp on the same origin as the same audience", async () => {
    const { areEquivalentMcpResources } = await import("./mcp-connector");

    expect(areEquivalentMcpResources("https://mcp.corgtex.com/mcp", "https://mcp.corgtex.com/api/mcp")).toBe(true);
    expect(areEquivalentMcpResources("https://mcp.corgtex.com/mcp", "https://crina.corgtex.com/mcp")).toBe(false);
  });
});
