import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  actor: undefined as AppActor | undefined, featureEnabled: true,
  store: {
    $transaction: vi.fn(),
    workspaceToolLink: { findFirst: vi.fn() },
    agentCredential: { findUnique: vi.fn() },
    workspaceSupportGrant: { findUnique: vi.fn() },
    member: { findUnique: vi.fn(), findFirst: vi.fn() },
    action: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
  decrypt: vi.fn(() => "synthetic-output"), audit: vi.fn(), archive: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({
  prisma: mocks.store,
  env: { APP_URL: "https://synthetic.example.test", CONTROL_PLANE_MODE: false },
  beginAuthorizationContext: vi.fn(),
  getMcpOrigin: () => undefined,
  setSupportAuthorizationActor: vi.fn(), setSupportAuthorizationGrant: vi.fn(),
  getSupportAuthorizationContext: () => undefined,
  mcpCredentialVersion: (hash: string) => `version:${hash}`,
  decryptSecret: mocks.decrypt, encryptSecret: vi.fn(),
  isDatabaseUnavailableError: () => false,
  sessionCookieName: () => "synthetic-session",
}));
vi.mock("@corgtex/shared/telemetry-node", () => ({ captureErrorTelemetry: vi.fn() }));
vi.mock("./support-request-access", () => ({
  requireSupportRequestAccess: vi.fn(), workspaceIdFromPath: () => "synthetic-workspace",
  isWorkspaceAuthorizedProviderRoute: () => false,
}));
vi.mock("./workspace-feature-route", () => ({
  disabledWorkspaceFeatureResponse: async () => mocks.featureEnabled ? null
    : NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
}));
vi.mock("../../../packages/domain/src/audit-trail", () => ({ recordAudit: mocks.audit }));
vi.mock("../../../packages/domain/src/archive", () => ({ archiveFilterWhere: () => ({ archivedAt: null }), archiveWorkspaceArtifact: mocks.archive }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../packages/domain/src/auth"),
  ...await import("../../../packages/domain/src/errors"),
  ...await import("../../../packages/domain/src/agent-operation-capabilities"),
  ...await import("../../../packages/domain/src/mcp-tool-capabilities"),
  ...await import("../../../packages/domain/src/tool-links"),
  ...await import("../../../packages/domain/src/actions"),
  ...await import("../../../packages/domain/src/release-diagnostics"),
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS: [{ flag: "TOOL_LINKS", label: "Synthetic", description: "Synthetic", defaultEnabled: true }],
  FINANCE_PARENT_FLAG: "FINANCE",
  evaluateDelegatedActionPolicy: () => ({ policyClass: "read" }),
  getWorkspacePermanentPathForEntity: vi.fn(async () => null),
  resolveAgentActorFromBearer: vi.fn(async () => mocks.actor ?? null),
  resolveControlPlaneAgentFromBearer: vi.fn(async () => null),
  resolveMcpOAuthAccessToken: vi.fn(async () => null),
  requireTrialMcpAccess: vi.fn(), requireWorkspaceMcpActivation: vi.fn(),
  describeScope: (scope: string) => scope,
}));

vi.mock("@corgtex/agents", () => ({ processConversationTurn: vi.fn() }));
vi.mock("@corgtex/knowledge", () => ({ searchIndexedKnowledge: vi.fn() }));

import { createCorgtexMcpServer } from "../../../packages/mcp/src/server";
import { withWorkspaceRoute } from "./route-handler";
import { resolveRequestActor } from "./auth";
import { listActions, createAction, deleteAction } from "../../../packages/domain/src/actions";
import { revealWorkspaceToolLinkCredential } from "../../../packages/domain/src/tool-links";
import { requireScope } from "../../../packages/mcp/src/auth";
import { POST as revealPost } from "../app/api/workspaces/[workspaceId]/tool-links/[toolLinkId]/reveal/route";

const workspaceId = "synthetic-workspace";
const credential = (scopes?: string[]): Extract<AppActor, { kind: "agent" }> => ({
  kind: "agent", authProvider: "credential", label: "Synthetic agent",
  credentialId: "synthetic-agent", credentialVersion: "version:synthetic-hash",
  workspaceIds: [workspaceId], scopes,
});
const request = (method: string, suffix: string) => new NextRequest(`https://synthetic.example.test/api/workspaces/${workspaceId}/${suffix}`, {
  method, headers: { authorization: "Bearer synthetic-unused-token" },
});
const context = () => ({ params: Promise.resolve({ workspaceId, toolLinkId: "synthetic-tool" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.featureEnabled = true;
  mocks.store.$transaction.mockImplementation(async (run: (tx: typeof mocks.store) => Promise<unknown>) => run(mocks.store));
  mocks.store.workspaceSupportGrant.findUnique.mockResolvedValue(null);
  mocks.store.member.findUnique.mockResolvedValue({ id: "synthetic-member", role: "ADMIN", isActive: true });
  mocks.store.member.findFirst.mockResolvedValue({ userId: "synthetic-system-user" });
  mocks.archive.mockResolvedValue({ id: "synthetic-action" });
  mocks.store.agentCredential.findUnique.mockResolvedValue({ workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: ["tools:credentials:read", "actions:read", "actions:write"] });
  mocks.store.workspaceToolLink.findFirst.mockResolvedValue({ id: "synthetic-tool", title: "Synthetic tool", createdByUserId: "synthetic-creator", credentialLabel: "Synthetic label", credentialSecretEnc: "synthetic-ciphertext" });
  mocks.store.action.findMany.mockResolvedValue([]);
  mocks.store.action.count.mockResolvedValue(0);
});

const listRoute = withWorkspaceRoute(async (_req, { actor, workspaceId: workspace }) => NextResponse.json(await listActions(actor, workspace)));
const createRoute = withWorkspaceRoute(async (_req, { actor, workspaceId: workspace }) => {
  await createAction(actor, { workspaceId: workspace, title: "Synthetic action" });
  return NextResponse.json({ created: true });
});

describe("scoped agent transport and domain parity through actual auth and wrapper", () => {
  it.each([undefined, [], ["tools:read"], ["tools:write"]])("denies REST and direct-domain reveal with scopes %j before secret access", async scopes => {
    mocks.actor = credential(scopes);
    const response = await revealPost(request("POST", "tool-links/synthetic-tool/reveal"), context());
    expect(response.status).toBe(403);
    await expect(revealWorkspaceToolLinkCredential(mocks.actor, { workspaceId, toolLinkId: "synthetic-tool" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.store.workspaceToolLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ["tools:read"]])("MCP also denies reveal with scopes %j", scopes => {
    const actor = credential(scopes);
    expect(() => requireScope({ actor, workspaceId, authKind: "agent", scopes }, "tools:credentials:read")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("permits the sensitive REST/domain path with explicit current grant", async () => {
    mocks.actor = credential(["tools:credentials:read"]);
    const response = await revealPost(request("POST", "tool-links/synthetic-tool/reveal"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ credentialSecret: "synthetic-output" });
    expect(() => requireScope({ actor: mocks.actor!, workspaceId, authKind: "agent", scopes: ["tools:credentials:read"] }, "tools:credentials:read")).not.toThrow();
  });

  it("keeps feature-off reveal at 404 before scope denial and secret access", async () => {
    mocks.actor = credential([]);
    mocks.featureEnabled = false;
    const response = await revealPost(request("POST", "tool-links/synthetic-tool/reveal"), context());
    expect(response.status).toBe(404);
    expect(mocks.store.workspaceToolLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("preserves Action read grant while denying write before mutation", async () => {
    mocks.actor = credential(["actions:read"]);
    expect((await listRoute(request("GET", "actions"), context())).status).toBe(200);
    expect((await createRoute(request("POST", "actions"), context())).status).toBe(403);
    await expect(createAction(mocks.actor, { workspaceId, title: "Synthetic action" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.store.action.create).not.toHaveBeenCalled();
  });

  it("allows canonical Action write without an unrelated read grant", async () => {
    mocks.actor = credential(["actions:write"]);
    const deleteRoute = withWorkspaceRoute(async (_req, { actor, workspaceId: workspace }) => {
      await deleteAction(actor, { workspaceId: workspace, actionId: "synthetic-action" });
      return NextResponse.json({ archived: true });
    });
    expect((await deleteRoute(request("DELETE", "actions/synthetic-action"), context())).status).toBe(200);
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(() => requireScope({ actor: mocks.actor!, workspaceId, authKind: "agent", scopes: ["actions:write"] }, "actions:write")).not.toThrow();
  });

  it("denies Action reads before storage access to a write-only credential", async () => {
    mocks.actor = credential(["actions:write"]);
    expect((await listRoute(request("GET", "actions"), context())).status).toBe(403);
    expect(mocks.store.action.findMany).not.toHaveBeenCalled();
    expect(mocks.store.action.count).not.toHaveBeenCalled();
  });

  it("fails closed on undeclared REST operations even with all relevant grants", async () => {
    mocks.actor = credential(["support:write", "actions:read", "actions:write", "tools:credentials:read"]);
    await expect(resolveRequestActor(request("POST", "unclassified-new-operation"))).rejects.toMatchObject({ status: 403, code: "AGENT_OPERATION_UNDECLARED" });
    expect(mocks.store.$transaction).not.toHaveBeenCalled();
  });
});

function actualMcpTools(scopes?: string[]) {
  const server = createCorgtexMcpServer({ actor: credential(scopes), workspaceId, authKind: "agent", scopes });
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
}

describe("actual registered MCP callback parity", () => {
  it.each([undefined, [], ["tools:read"], ["tools:write"]])("denies reveal with insufficient scope %j before domain secret access", async scopes => {
    await expect(actualMcpTools(scopes).reveal_tool_link_credential.handler({ toolLinkId: "synthetic-tool" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.store.workspaceToolLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("allows explicit sensitive grant through the actual domain operation", async () => {
    const result = await actualMcpTools(["tools:credentials:read"]).reveal_tool_link_credential.handler({ toolLinkId: "synthetic-tool" });
    expect(JSON.stringify(result)).toContain("synthetic-output");
    expect(mocks.decrypt).toHaveBeenCalledOnce();
  });

  it("allows Actions read while denying Actions write through registered callbacks", async () => {
    const tools = actualMcpTools(["actions:read"]);
    await expect(tools.list_actions.handler({})).resolves.toBeDefined();
    await expect(tools.delete_action.handler({ actionId: "synthetic-action" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("allows Actions write while denying Actions read through registered callbacks", async () => {
    const tools = actualMcpTools(["actions:write"]);
    await expect(tools.delete_action.handler({ actionId: "synthetic-action" })).resolves.toBeDefined();
    await expect(tools.list_actions.handler({})).rejects.toMatchObject({ status: 403 });
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.store.action.findMany).not.toHaveBeenCalled();
  });
});
