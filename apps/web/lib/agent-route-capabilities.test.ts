import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { MCP_TOOL_CAPABILITIES } from "../../../packages/domain/src/mcp-tool-capabilities";

vi.mock("@corgtex/domain", async () => import("../../../packages/domain/src/agent-operation-capabilities"));

import {
  AGENT_REST_ROUTE_CAPABILITIES,
  getAgentRouteCapability,
  getAgentRouteOperation,
  requireAgentRouteCapability,
} from "./agent-route-capabilities";

const credential = (scopes?: string[]): AppActor => ({
  kind: "agent", authProvider: "credential", label: "synthetic", workspaceIds: ["workspace-1"], scopes,
});
const request = (method: string, suffix: string) => ({
  method, nextUrl: { pathname: `/api/workspaces/workspace-1/${suffix}` },
});

describe("credential agent REST operation capabilities", () => {
  it.each([
    ["GET", "actions", "list_actions"],
    ["POST", "actions", "create_action"],
    ["PATCH", "actions/action-1", "update_action"],
    ["DELETE", "actions/action-1", "delete_action"],
    ["GET", "tool-links", "list_tool_links"],
    ["GET", "tool-links/link-1", "list_tool_links"],
    ["POST", "tool-links", "upsert_tool_link"],
    ["PATCH", "tool-links/link-1", "upsert_tool_link"],
    ["DELETE", "tool-links/link-1", "archive_tool_link"],
    ["POST", "tool-links/link-1/reveal", "reveal_tool_link_credential"],
  ])("maps %s %s to canonical %s", (method, suffix, operation) => {
    const req = request(method, suffix);
    expect(getAgentRouteOperation(method, req.nextUrl.pathname)).toBe(operation);
    const scopes = MCP_TOOL_CAPABILITIES[operation as keyof typeof MCP_TOOL_CAPABILITIES].scopes;
    expect(() => requireAgentRouteCapability(credential([...scopes]), req)).not.toThrow();
    expect(() => requireAgentRouteCapability(credential([]), req)).toThrow();
  });

  it("requires both canonical scopes for Action update", () => {
    const req = request("PATCH", "actions/action-1");
    expect(() => requireAgentRouteCapability(credential(["actions:write"]), req)).toThrow();
    expect(() => requireAgentRouteCapability(credential(["actions:read"]), req)).toThrow();
    expect(() => requireAgentRouteCapability(credential(["actions:read", "actions:write"]), req)).not.toThrow();
  });

  it("treats missing and unrelated scopes as no grant", () => {
    expect(() => requireAgentRouteCapability(credential(), request("GET", "actions"))).toThrow();
    expect(() => requireAgentRouteCapability(credential(["tools:read"]), request("GET", "actions"))).toThrow();
    expect(() => requireAgentRouteCapability(credential(["tools:write"]), request("POST", "tool-links/link-1/reveal"))).toThrow();
  });

  it.each([
    ["POST", "actions/duplicates"],
    ["DELETE", "actions/duplicates"],
    ["PATCH", "actions/duplicates"],
    ["GET", "actions/action-1"],
    ["PUT", "actions"],
    ["HEAD", "actions"],
    ["POST", "agent-credentials"],
    ["POST", "agent-credentials/credential-1/rotate"],
    ["POST", "finance/imports"],
    ["POST", "proposals"],
    ["DELETE", "brain/articles/article-1"],
    ["POST", "meetings/meeting-1/recording/schedule"],
    ["POST", "meetings/meeting-1/recording/cancel"],
    ["GET", "unknown"],
    ["GET", "actions/export/all"],
    ["POST", "tool-links/link-1/reveal/extra"],
  ])("denies undeclared or explicitly denied %s %s despite all scopes", (method, suffix) => {
    const allScopes = [...new Set(Object.values(MCP_TOOL_CAPABILITIES).flatMap(capability => [...capability.scopes]))];
    expect(() => requireAgentRouteCapability(credential(allScopes), request(method, suffix))).toThrow(
      "This operation is unavailable to agent credentials.",
    );
  });

  it("never authorizes MCP transports through ordinary REST mapping", () => {
    for (const pathname of ["/api/mcp", "/mcp", "/mcp/workspaces/workspace-1", "/api/control-plane/mcp"]) {
      expect(getAgentRouteCapability("POST", pathname)).toBeNull();
      expect(() => requireAgentRouteCapability(credential(["actions:read"]), { method: "POST", nextUrl: { pathname } })).toThrow();
    }
  });

  it("never treats inherited method names as declarations", () => {
    for (const method of ["constructor", "toString", "__proto__", "get"]) {
      expect(getAgentRouteCapability(method, request(method, "actions").nextUrl.pathname)).toBeNull();
    }
  });

  it.each(["actions/", "actions//action-1", "actions/action%2Fextra", "actions/action%5Cextra", "actions?export=true", "actions#fragment", "actions\\extra"])(
    "does not broaden matching for %s", suffix => {
      expect(getAgentRouteCapability("PATCH", request("PATCH", suffix).nextUrl.pathname)).toBeNull();
    },
  );

  it("exposes exact feature metadata and defers only known tool-link scopes", () => {
    const req = request("POST", "tool-links/link-1/reveal");
    expect(getAgentRouteCapability(req.method, req.nextUrl.pathname)).toEqual({
      operation: "reveal_tool_link_credential", feature: "TOOL_LINKS",
    });
    expect(() => requireAgentRouteCapability(credential([]), req, { deferToolLinkScope: true })).not.toThrow();
    // The route calls the default guard after its feature-off 404 check.
    expect(() => requireAgentRouteCapability(credential([]), req)).toThrow();
    expect(() => requireAgentRouteCapability(credential([]), request("GET", "actions"), { deferToolLinkScope: true })).toThrow();
    expect(() => requireAgentRouteCapability(credential([]), request("POST", "tool-links/link-1/reveal/extra"), { deferToolLinkScope: true })).toThrow();
  });

  it("preserves human, bootstrap, and independent control-plane authorization", () => {
    const actors: AppActor[] = [
      { kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: null } },
      { kind: "agent", authProvider: "bootstrap", label: "synthetic-bootstrap" },
      { kind: "agent", authProvider: "control-plane", label: "synthetic-control-plane" },
    ];
    for (const actor of actors) expect(() => requireAgentRouteCapability(actor, request("POST", "unknown"))).not.toThrow();
  });

  it("references canonical policies without duplicating scope lists", () => {
    for (const methods of Object.values(AGENT_REST_ROUTE_CAPABILITIES)) {
      for (const capability of Object.values(methods)) {
        if (capability.operation) expect(MCP_TOOL_CAPABILITIES).toHaveProperty(capability.operation);
      }
    }
  });
});
