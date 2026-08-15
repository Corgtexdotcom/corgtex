import { describe, expect, it } from "vitest";
import { getRequiredScopesForMcpTool, getMcpToolCapability, hasMcpToolCapability } from "./mcp-tool-capabilities";

describe("mcp-tool-capabilities", () => {
  it("daily_overview requires exactly the five core scopes and excludes finance:read", () => {
    expect(hasMcpToolCapability("daily_overview")).toBe(true);
    const capability = getMcpToolCapability("daily_overview");
    expect(capability?.scopes).toEqual([
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
    ]);
    const requiredScopes = getRequiredScopesForMcpTool("daily_overview");
    expect(requiredScopes).toEqual([
      "workspace:read",
      "actions:read",
      "proposals:read",
      "tensions:read",
      "meetings:read",
    ]);
    expect(requiredScopes).not.toContain("finance:read");
  });

  it("get_finance_readiness continues to require finance:read", () => {
    expect(hasMcpToolCapability("get_finance_readiness")).toBe(true);
    const requiredScopes = getRequiredScopesForMcpTool("get_finance_readiness");
    expect(requiredScopes).toEqual(["finance:read"]);
  });

  it.each([
    ["update_proposal", "proposals"], ["update_action", "actions"],
    ["update_tension", "tensions"], ["update_goal", "goals"],
  ])("%s declares its read-before-write scopes", (tool, scope) => {
    expect(getRequiredScopesForMcpTool(tool)).toEqual([`${scope}:read`, `${scope}:write`]);
  });
});
