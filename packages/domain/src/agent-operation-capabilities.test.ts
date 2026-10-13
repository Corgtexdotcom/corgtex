import { describe, expect, it } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AGENT_OPERATION_CAPABILITIES, agentHasOperation, getAgentOperationCapability, requireAgentOperation } from "./agent-operation-capabilities";
import { MCP_TOOL_CAPABILITIES } from "./mcp-tool-capabilities";

const credential = (scopes?: string[]): AppActor => ({
  kind: "agent", authProvider: "credential", credentialId: "synthetic-credential",
  label: "Synthetic agent", workspaceIds: ["synthetic-workspace"], scopes,
});

describe("canonical agent operation authority", () => {
  it("shares the actual MCP registry across transports", () => {
    expect(AGENT_OPERATION_CAPABILITIES).toBe(MCP_TOOL_CAPABILITIES);
    expect(getAgentOperationCapability("reveal_tool_link_credential")).toEqual({
      scopes: ["tools:credentials:read"], sensitive: true,
    });
  });

  it.each([undefined, [], ["tools:read"], ["tools:write"], ["support:write"]])(
    "denies credential reveal with insufficient scopes %j", (scopes) => {
      expect(() => requireAgentOperation(credential(scopes), "reveal_tool_link_credential"))
        .toThrow(expect.objectContaining({ status: 403, code: "FORBIDDEN" }));
      expect(agentHasOperation(credential(scopes), "reveal_tool_link_credential")).toBe(false);
    },
  );

  it("allows explicit sensitive opt-in without granting metadata writes", () => {
    const actor = credential(["tools:credentials:read"]);
    expect(() => requireAgentOperation(actor, "reveal_tool_link_credential")).not.toThrow();
    expect(agentHasOperation(actor, "upsert_tool_link")).toBe(false);
  });

  it("requires both scopes for an Action read-before-write operation", () => {
    expect(agentHasOperation(credential(["actions:write"]), "update_action")).toBe(false);
    expect(agentHasOperation(credential(["actions:read"]), "update_action")).toBe(false);
    expect(agentHasOperation(credential(["actions:read", "actions:write"]), "update_action")).toBe(true);
  });

  it.each(["", "new_operation", "toString", "constructor", "__proto__"])(
    "fails closed for undeclared credential-agent operation %s", (operation) => {
      expect(() => requireAgentOperation(credential(["support:write", "tools:credentials:read"]), operation))
        .toThrow(expect.objectContaining({ code: "AGENT_OPERATION_UNDECLARED" }));
    },
  );

  it.each<AppActor>([
    { kind: "user", user: { id: "synthetic-human", email: "synthetic@example.test", displayName: null } },
    { kind: "agent", authProvider: "bootstrap", label: "synthetic-bootstrap", workspaceIds: ["synthetic-workspace"] },
    { kind: "agent", authProvider: "control-plane", label: "synthetic-control-plane", workspaceIds: ["synthetic-workspace"] },
  ])("preserves separate domain authority for %j", (actor) => {
    expect(() => requireAgentOperation(actor, "undeclared")).not.toThrow();
  });
});
