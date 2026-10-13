import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { MCP_TOOL_CAPABILITIES } from "../../domain/src/mcp-tool-capabilities";

const mocks = vi.hoisted(() => ({ membership: vi.fn(), credential: vi.fn(), grant: vi.fn() }));
vi.mock("@corgtex/shared", () => ({
  prisma: { agentCredential: { findUnique: mocks.credential }, workspaceSupportGrant: { findUnique: mocks.grant } },
  mcpCredentialVersion: (hash: string) => `version:${hash}`,
}));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: mocks.membership }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/agent-operation-capabilities"),
  ...await import("../../domain/src/agent-operation-authorization"),
}));
import {
  authorizeConversationKnowledge,
  authorizeConversationPageContext,
  authorizeConversationTool,
  authorizeConversationTurn,
  canUseConversationTool,
  CONVERSATION_TOOL_CAPABILITIES,
  guardConversationToolHandlers,
  filterConversationKnowledgeDomains,
} from "./conversation-capabilities";

const workspaceId = "synthetic-workspace";
const allScopes = [...new Set(Object.values(MCP_TOOL_CAPABILITIES).flatMap(capability => [...capability.scopes]))];
const credential = (scopes?: string[]): AppActor => ({
  kind: "agent", authProvider: "credential", label: "synthetic",
  credentialId: "synthetic-credential", credentialVersion: "version:synthetic-hash",
  workspaceIds: [workspaceId], scopes,
});
const currentCredential = (overrides: Record<string, unknown> = {}) => ({
  workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: allScopes,
  createdBy: null, supportGrantVersion: null, ...overrides,
});
const trustedActors: AppActor[] = [
  { kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: null } },
  { kind: "agent", authProvider: "bootstrap", label: "synthetic-bootstrap" },
  { kind: "agent", authProvider: "control-plane", label: "synthetic-control-plane" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue(null);
  mocks.credential.mockResolvedValue(currentCredential());
  mocks.grant.mockResolvedValue(null);
});

describe("scoped native conversation tool dispatch", () => {
  it.each([
    ["query_actions", "actions:read"], ["query_tensions", "tensions:read"],
    ["query_proposals", "proposals:read"], ["query_goals", "goals:read"],
    ["search_brain", "brain:read"], ["create_tension", "tensions:write"],
    ["create_action", "actions:write"], ["create_proposal", "proposals:write"],
    ["create_goal", "goals:write"], ["create_corgtex_scheduled_meeting", "meetings:write"],
    ["upload_meeting_transcript", "meetings:write"], ["get_context_map_info", "context-graph:read"],
    ["get_selected_context_map_region", "context-graph:read"],
    ["create_context_map_diff", "context-graph:propose"],
  ])("guards %s with its canonical %s capability", async (toolName, scope) => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const guarded = guardConversationToolHandlers({ [toolName]: handler });
    for (const scopes of [undefined, [], ["conversations:write"]]) {
      await expect(guarded[toolName](credential(scopes), { workspaceId }, {})).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(canUseConversationTool(credential(scopes), toolName)).toBe(false);
    }
    expect(canUseConversationTool(credential([scope]), toolName)).toBe(true);
    await expect(guarded[toolName](credential([scope]), { workspaceId }, {})).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.credential).toHaveBeenCalledOnce();
  });

  it.each(["unknown_tool", "constructor", "toString", "__proto__", "schedule_meeting", "check_calendar_availability", "query_org_structure", "assign_role", "unassign_role", "get_member_profile", "save_to_brain"])(
    "denies undeclared %s despite broad credential scopes", async toolName => {
      expect(canUseConversationTool(credential(allScopes), toolName)).toBe(false);
      await expect(authorizeConversationTool(credential(allScopes), workspaceId, toolName)).rejects.toMatchObject({ code: "AGENT_OPERATION_UNDECLARED" });
      expect(mocks.membership).not.toHaveBeenCalled();
      expect(mocks.credential).not.toHaveBeenCalled();
    },
  );

  it.each(["update_action", "update_tension"])("requires read and write for %s", async toolName => {
    const category = toolName === "update_action" ? "actions" : "tensions";
    await expect(authorizeConversationTool(credential([`${category}:write`]), workspaceId, toolName)).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTool(credential([`${category}:read`, `${category}:write`]), workspaceId, toolName)).resolves.toBeUndefined();
  });

  it("authorizes every aggregate category before an overview handler reads storage", async () => {
    const scopes = ["workspace:read", "circles:read", "members:read", "actions:read", "tensions:read", "proposals:read", "goals:read"];
    const handler = vi.fn().mockResolvedValue("synthetic-overview");
    const guarded = guardConversationToolHandlers({ get_workspace_overview: handler });
    for (const omitted of scopes) {
      const actor = credential(scopes.filter(scope => scope !== omitted));
      expect(canUseConversationTool(actor, "get_workspace_overview")).toBe(false);
      await expect(guarded.get_workspace_overview(actor, { workspaceId }, {})).rejects.toMatchObject({ status: 403 });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(guarded.get_workspace_overview(credential(scopes), { workspaceId }, {})).resolves.toBe("synthetic-overview");
  });

  it("checks proposal source reads before invoking any source lookup or mutation", async () => {
    const sourceLookupAndWrite = vi.fn().mockResolvedValue("synthetic-proposal");
    const guarded = guardConversationToolHandlers({ create_proposal: sourceLookupAndWrite });
    const args = { sourceTensionId: "synthetic-tension", relatedActionIds: ["synthetic-action"] };
    for (const scopes of [["proposals:write"], ["proposals:write", "tensions:read"], ["proposals:write", "actions:read"]]) {
      await expect(guarded.create_proposal(credential(scopes), { workspaceId }, args)).rejects.toMatchObject({ status: 403 });
    }
    expect(sourceLookupAndWrite).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(guarded.create_proposal(credential(["proposals:write", "tensions:read", "actions:read"]), { workspaceId }, args)).resolves.toBe("synthetic-proposal");
    expect(mocks.credential).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, {}, { sourceTensionId: "  ", relatedActionIds: [] }])("keeps ordinary proposal creation write-only for %j", async args => {
    await expect(authorizeConversationTool(credential(["proposals:write"]), workspaceId, "create_proposal", args)).resolves.toBeUndefined();
    expect(mocks.credential).toHaveBeenCalledOnce();
  });

  it("checks graph approval before creating a pending diff or applying it", async () => {
    const pendingSideEffect = vi.fn().mockResolvedValue("applied");
    const guarded = guardConversationToolHandlers({ apply_context_map_diff: pendingSideEffect });
    await expect(guarded.apply_context_map_diff(credential(["context-graph:propose"]), { workspaceId }, {})).rejects.toMatchObject({ status: 403 });
    await expect(guarded.apply_context_map_diff(credential(["context-graph:approve"]), { workspaceId }, {})).rejects.toMatchObject({ status: 403 });
    expect(pendingSideEffect).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(guarded.apply_context_map_diff(credential(["context-graph:propose", "context-graph:approve"]), { workspaceId }, {})).resolves.toBe("applied");
  });

  it("requires Brain authority for the native connected-context composite", async () => {
    await expect(authorizeConversationTool(credential(["external-tools:read"]), workspaceId, "search_connected_context")).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTool(credential(["external-tools:read", "brain:read"]), workspaceId, "search_connected_context")).resolves.toBeUndefined();
  });

  it.each([null, { isActive: false }, { workspaceId: "other-workspace" }, { tokenHash: "rotated-hash" }, { scopes: [] }])(
    "rechecks the current credential before a cached actor dispatches %j", async overrides => {
      mocks.credential.mockResolvedValue(overrides === null ? null : currentCredential(overrides));
      const handler = vi.fn();
      const guarded = guardConversationToolHandlers({ query_actions: handler });
      await expect(guarded.query_actions(credential(["actions:read"]), { workspaceId }, {})).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rechecks current dynamic input authority as well as proposal write authority", async () => {
    mocks.credential.mockResolvedValue(currentCredential({ scopes: ["proposals:write"] }));
    const handler = vi.fn();
    const guarded = guardConversationToolHandlers({ create_proposal: handler });
    await expect(guarded.create_proposal(credential(["proposals:write", "tensions:read"]), { workspaceId }, { sourceTensionId: "synthetic-tension" })).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rechecks support restrictions on cached credentials", async () => {
    mocks.credential.mockResolvedValue(currentCredential({ createdBy: { id: "synthetic-support" }, supportGrantVersion: 1 }));
    mocks.grant.mockResolvedValue({ role: "SETUP", isActive: true, version: 1 });
    await expect(authorizeConversationTool(credential(["actions:read"]), workspaceId, "query_actions")).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("preserves map shape, arguments, context, results, and existing noncredential behavior", async () => {
    type Context = { workspaceId: string; sessionId: string };
    const handler = vi.fn(async (_actor: AppActor, ctx: Context, args: { value: string }) => ({ sessionId: ctx.sessionId, value: args.value }));
    const original = { unreviewed_tool: handler, absent: undefined };
    const guarded = guardConversationToolHandlers(original);
    expect(Object.keys(guarded)).toEqual(Object.keys(original));
    expect(original.unreviewed_tool).toBe(handler);
    expect(guarded.absent).toBeUndefined();
    const ctx = { workspaceId, sessionId: "synthetic-session" };
    const args = { value: "synthetic-value" };
    for (const actor of trustedActors) {
      expect(canUseConversationTool(actor, "unreviewed_tool")).toBe(true);
      await expect(guarded.unreviewed_tool(actor, ctx, args)).resolves.toEqual({ sessionId: ctx.sessionId, value: args.value });
      expect(handler).toHaveBeenLastCalledWith(actor, ctx, args);
    }
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("does not expose inherited properties as unguarded model tools", () => {
    const guarded = guardConversationToolHandlers({ query_actions: vi.fn() }) as Record<string, unknown>;
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(guarded[name]).toBeUndefined();
    expect(Object.getPrototypeOf(guarded)).toBeNull();
  });

  it("only references nonempty canonical policies", () => {
    for (const operations of Object.values(CONVERSATION_TOOL_CAPABILITIES)) {
      if (operations === null) continue;
      expect(operations.length).toBeGreaterThan(0);
      for (const operation of operations) expect(MCP_TOOL_CAPABILITIES).toHaveProperty(operation);
    }
  });
});

describe("eager conversation context authorization", () => {
  it("requires current chat authority before a direct credential turn", async () => {
    await expect(authorizeConversationTurn(credential(["brain:read"]), workspaceId)).rejects.toMatchObject({ status: 403 });
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(authorizeConversationTurn(credential(["conversations:write"]), workspaceId)).resolves.toBeUndefined();
    mocks.credential.mockResolvedValue(currentCredential({ isActive: false }));
    await expect(authorizeConversationTurn(credential(["conversations:write"]), workspaceId)).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });
  it.each([undefined, [], ["conversations:write"], ["actions:read"]].map(scopes => ({ scopes })))("skips eager knowledge without storage access for %j", async ({ scopes }) => {
    await expect(authorizeConversationKnowledge(credential(scopes), workspaceId)).resolves.toBe(false);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("permits eager knowledge only after current Brain grant validation", async () => {
    await expect(authorizeConversationKnowledge(credential(["brain:read"]), workspaceId)).resolves.toBe(true);
    expect(mocks.credential).toHaveBeenCalledOnce();
    mocks.credential.mockResolvedValue(currentCredential({ scopes: [] }));
    await expect(authorizeConversationKnowledge(credential(["brain:read"]), workspaceId)).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it.each([["crm", "relationships:read"], ["context-map", "context-graph:read"]] as const)("checks the read category of %s page context", async (surface, scope) => {
    await expect(authorizeConversationPageContext(credential(["conversations:write"]), workspaceId, surface)).rejects.toMatchObject({ status: 403 });
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(authorizeConversationPageContext(credential([scope]), workspaceId, surface)).resolves.toBeUndefined();
    mocks.credential.mockResolvedValue(currentCredential({ isActive: false }));
    await expect(authorizeConversationPageContext(credential([scope]), workspaceId, surface)).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it.each(trustedActors)("preserves existing eager context behavior for %j", async actor => {
    await expect(authorizeConversationKnowledge(actor, workspaceId)).resolves.toBe(true);
    await expect(authorizeConversationPageContext(actor, workspaceId, "crm")).resolves.toBeUndefined();
    await expect(authorizeConversationPageContext(actor, workspaceId, "context-map")).resolves.toBeUndefined();
    expect(mocks.credential).not.toHaveBeenCalled();
  });
});

describe("conversation transport scope ceilings", () => {
  const humanOperator: AppActor = {
    kind: "user", user: { id: "synthetic-operator", email: "operator@example.test", displayName: null, globalRole: "OPERATOR" },
  };

  it.each([[], ["conversations:write"], ["tools:read"], ["tools:write"]].map(operationScopes => ({ operationScopes })))("blocks a scoped human operator's secret handler for %j", async ({ operationScopes }) => {
    const secretHandler = vi.fn().mockResolvedValue("synthetic-secret");
    const guarded = guardConversationToolHandlers({ reveal_tool_link_credential: secretHandler });
    await expect(guarded.reveal_tool_link_credential(humanOperator, { workspaceId, operationScopes }, {})).rejects.toMatchObject({ status: 403 });
    expect(canUseConversationTool(humanOperator, "reveal_tool_link_credential", operationScopes)).toBe(false);
    expect(secretHandler).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("permits a scoped human's explicit sensitive grant while retaining handler semantics", async () => {
    const secretHandler = vi.fn().mockResolvedValue("synthetic-secret");
    const guarded = guardConversationToolHandlers({ reveal_tool_link_credential: secretHandler });
    const operationScopes = Object.freeze(["tools:credentials:read"]);
    expect(canUseConversationTool(humanOperator, "reveal_tool_link_credential", operationScopes)).toBe(true);
    await expect(guarded.reveal_tool_link_credential(humanOperator, { workspaceId, operationScopes }, {})).resolves.toBe("synthetic-secret");
    expect(secretHandler).toHaveBeenCalledOnce();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it.each(["unknown_tool", "save_to_brain", "constructor", "__proto__", "toString"])("denies unclassified scoped-human %s even with all grants", async toolName => {
    expect(canUseConversationTool(humanOperator, toolName, allScopes)).toBe(false);
    await expect(authorizeConversationTool(humanOperator, workspaceId, toolName, {}, allScopes)).rejects.toMatchObject({ code: "AGENT_OPERATION_UNDECLARED" });
  });

  it("keeps the model's tool arguments from overriding the context grant ceiling", async () => {
    const handler = vi.fn();
    const guarded = guardConversationToolHandlers({ reveal_tool_link_credential: handler });
    await expect(guarded.reveal_tool_link_credential(humanOperator, { workspaceId, operationScopes: [] }, {
      operationScopes: allScopes, scopes: allScopes, actor: credential(allScopes), workspaceId: "other-workspace",
    })).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires credential actor grants, transport ceiling, and current grants independently", async () => {
    await expect(authorizeConversationTool(credential(allScopes), workspaceId, "query_actions", {}, [])).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTool(credential([]), workspaceId, "query_actions", {}, ["actions:read"])).rejects.toMatchObject({ status: 403 });
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(authorizeConversationTool(credential(["actions:read"]), workspaceId, "query_actions", {}, ["actions:read"])).resolves.toBeUndefined();
    mocks.credential.mockResolvedValue(currentCredential({ scopes: [] }));
    await expect(authorizeConversationTool(credential(["actions:read"]), workspaceId, "query_actions", {}, ["actions:read"])).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it("enforces dynamic proposal input reads for a scoped human", async () => {
    const args = { sourceTensionId: "synthetic-tension", relatedActionIds: ["synthetic-action"] };
    await expect(authorizeConversationTool(humanOperator, workspaceId, "create_proposal", args, ["proposals:write"])).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTool(humanOperator, workspaceId, "create_proposal", args, ["proposals:write", "tensions:read", "actions:read"])).resolves.toBeUndefined();
  });

  it("skips eager knowledge when either ceiling or actor lacks Brain read", async () => {
    await expect(authorizeConversationKnowledge(humanOperator, workspaceId, [])).resolves.toBe(false);
    await expect(authorizeConversationKnowledge(credential(["brain:read"]), workspaceId, ["conversations:write"])).resolves.toBe(false);
    await expect(authorizeConversationKnowledge(credential([]), workspaceId, ["brain:read"])).resolves.toBe(false);
    expect(mocks.credential).not.toHaveBeenCalled();
    await expect(authorizeConversationKnowledge(humanOperator, workspaceId, ["brain:read"])).resolves.toBe(true);
    await expect(authorizeConversationKnowledge(credential(["brain:read"]), workspaceId, ["brain:read"])).resolves.toBe(true);
    mocks.credential.mockResolvedValue(currentCredential({ isActive: false }));
    await expect(authorizeConversationKnowledge(credential(["brain:read"]), workspaceId, ["brain:read"])).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it.each([["crm", "relationships:read"], ["context-map", "context-graph:read"]] as const)("enforces human page-context ceiling for %s", async (surface, scope) => {
    await expect(authorizeConversationPageContext(humanOperator, workspaceId, surface, [])).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationPageContext(humanOperator, workspaceId, surface, [scope])).resolves.toBeUndefined();
  });

  it("requires explicit chat grant for a transport-scoped human turn", async () => {
    await expect(authorizeConversationTurn(humanOperator, workspaceId, [])).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTurn(humanOperator, workspaceId, ["conversations:write"])).resolves.toBeUndefined();
  });

  it.each(trustedActors)("applies ceilings before trusted principal bypass without changing ordinary context %j", async actor => {
    await expect(authorizeConversationTool(actor, workspaceId, "unknown_tool")).resolves.toBeUndefined();
    await expect(authorizeConversationTool(actor, workspaceId, "query_actions", {}, [])).rejects.toMatchObject({ status: 403 });
    await expect(authorizeConversationTool(actor, workspaceId, "query_actions", {}, ["actions:read"])).resolves.toBeUndefined();
    expect(canUseConversationTool(actor, "query_actions")).toBe(true);
    expect(canUseConversationTool(actor, "query_actions", [])).toBe(false);
  });
});

describe("Finance knowledge-domain scope filtering", () => {
  const domains = Object.freeze(["WORKSPACE", "FINANCE"] as const);

  it.each([[], ["brain:read"], ["finance:write"]].map(operationScopes => ({ operationScopes })))(
    "excludes Finance without its canonical read ceiling %j before credential storage access", async ({ operationScopes }) => {
      mocks.credential.mockResolvedValue(currentCredential({ scopes: ["brain:read"] }));
      await expect(filterConversationKnowledgeDomains(credential(["brain:read", "finance:read"]), workspaceId, domains, operationScopes)).resolves.toEqual(["WORKSPACE"]);
      expect(mocks.membership).not.toHaveBeenCalled();
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(domains).toEqual(["WORKSPACE", "FINANCE"]);
    },
  );

  it.each([undefined, [], ["brain:read"]].map(scopes => ({ scopes })))("excludes Finance without cached credential authority %j", async ({ scopes }) => {
    await expect(filterConversationKnowledgeDomains(credential(scopes), workspaceId, domains, ["brain:read", "finance:read"])).resolves.toEqual(["WORKSPACE"]);
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("revalidates a cached Finance grant before returning Finance", async () => {
    mocks.credential.mockResolvedValue(currentCredential({ scopes: ["finance:read"] }));
    const actor = credential(["brain:read", "finance:read"]);
    await expect(filterConversationKnowledgeDomains(actor, workspaceId, domains, ["brain:read", "finance:read"])).resolves.toEqual(["WORKSPACE", "FINANCE"]);
    expect(mocks.membership).toHaveBeenCalledWith({ actor, workspaceId });
    expect(mocks.credential).toHaveBeenCalledOnce();
    expect(mocks.credential.mock.calls[0][0]).toMatchObject({ where: { id: "synthetic-credential" } });
  });

  it.each([{ scopes: ["brain:read"] }, { isActive: false }, { tokenHash: "rotated-hash" }, { workspaceId: "other-workspace" }])(
    "rejects current Finance scope loss, revocation, rotation, or tenant mismatch before indexed querying %j", async overrides => {
      mocks.credential.mockResolvedValue(currentCredential(overrides));
      const indexedQuery = vi.fn();
      const query = async () => {
        const accessDomains = await filterConversationKnowledgeDomains(
          credential(["brain:read", "finance:read"]), workspaceId, domains, ["brain:read", "finance:read"],
        );
        return indexedQuery({ workspaceId, accessDomains });
      };
      await expect(query()).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
      expect(indexedQuery).not.toHaveBeenCalled();
    },
  );

  it("revalidates eligible credentials even without an explicit transport ceiling", async () => {
    mocks.credential.mockResolvedValue(currentCredential({ scopes: ["brain:read"] }));
    await expect(filterConversationKnowledgeDomains(credential(["brain:read", "finance:read"]), workspaceId, domains)).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it.each(trustedActors)("preserves unscoped trusted principals' role-resolved Finance domains %j", async actor => {
    await expect(filterConversationKnowledgeDomains(actor, workspaceId, domains)).resolves.toEqual(["WORKSPACE", "FINANCE"]);
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("retains scoped-human role decisions without inventing Finance access", async () => {
    const human = trustedActors[0];
    await expect(filterConversationKnowledgeDomains(human, workspaceId, domains, ["brain:read"])).resolves.toEqual(["WORKSPACE"]);
    await expect(filterConversationKnowledgeDomains(human, workspaceId, domains, ["brain:read", "finance:read"])).resolves.toEqual(["WORKSPACE", "FINANCE"]);
    await expect(filterConversationKnowledgeDomains(human, workspaceId, ["WORKSPACE"], ["finance:read"])).resolves.toEqual(["WORKSPACE"]);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("does not query Finance authority when role-resolved domains exclude Finance", async () => {
    await expect(filterConversationKnowledgeDomains(credential(["finance:read"]), workspaceId, ["WORKSPACE"], [])).resolves.toEqual(["WORKSPACE"]);
    await expect(filterConversationKnowledgeDomains(credential(["finance:read"]), workspaceId, [], [])).resolves.toEqual([]);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });
});
