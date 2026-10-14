import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { installSourcePermissionEpochFixture } from "../../../packages/domain/src/source-permission-epochs.test-fixture";
import { mcpCredentialVersion, mcpScopesHash, captureMcpOAuthGrantEpoch } from "../../../packages/shared/src/mcp-context";
import { decryptSecret as decryptNativeInput } from "../../../packages/shared/src/crypto";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  actor: undefined as AppActor | undefined, featureEnabled: true,
  store: {
    $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
    artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    artifactInputSnapshot: { findFirst: vi.fn(), create: vi.fn() },
    mcpToolInput: { findFirst: vi.fn(), create: vi.fn() },
    mcpOAuthAccessToken: { findUnique: vi.fn(), findFirst: vi.fn() },
    workspaceToolLink: { findFirst: vi.fn() },
    agentCredential: { findUnique: vi.fn(), findFirst: vi.fn() },
    workspaceSupportGrant: { findUnique: vi.fn() },
    member: { findUnique: vi.fn(), findFirst: vi.fn() },
    action: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
  link: {} as any, manifests: [] as any[], nativeInputs: [] as any[], snapshots: [] as any[],
  decrypt: vi.fn(() => "synthetic-output"), audit: vi.fn(), archive: vi.fn(),
  externalSearch: vi.fn(), knowledgeSearch: vi.fn(),
}));
vi.mock("../../../packages/shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({
  ...await import("../../../packages/shared/src/mcp-context"),
  ...await import("../../../packages/shared/src/crypto"),
  prisma: mocks.store,
  env: { APP_URL: "https://synthetic.example.test", CONTROL_PLANE_MODE: false },
  beginAuthorizationContext: vi.fn(),
  setSupportAuthorizationActor: vi.fn(), setSupportAuthorizationGrant: vi.fn(),
  getSupportAuthorizationContext: () => undefined,
  decryptSecret: mocks.decrypt,
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
vi.mock("../../../packages/domain/src/finance", () => ({ getFinanceAccessPolicy: async () => ({ canRead: false }) }));
vi.mock("../../../packages/domain/src/audit-trail", () => ({ recordAudit: mocks.audit }));
vi.mock("../../../packages/domain/src/archive", () => ({ archiveFilterWhere: () => ({ archivedAt: null }), archiveWorkspaceArtifact: mocks.archive }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../packages/domain/src/auth"),
  ...await import("../../../packages/domain/src/mcp-tool-input"),
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
  searchConnectedExternalMcpContext: mocks.externalSearch,
}));

vi.mock("@corgtex/agents", () => ({ processConversationTurn: vi.fn() }));
vi.mock("@corgtex/knowledge", () => ({ searchIndexedKnowledge: mocks.knowledgeSearch }));

import { createCorgtexMcpServer } from "../../../packages/mcp/src/server";
import { withWorkspaceRoute } from "./route-handler";
import { resolveRequestActor } from "./auth";
import { listActions, createAction, deleteAction } from "../../../packages/domain/src/actions";
import { recordArtifactInputLineage } from "../../../packages/domain/src/source-lineage";
import { revealWorkspaceToolLinkCredential } from "../../../packages/domain/src/tool-links";
import { requireScope } from "../../../packages/mcp/src/auth";
import { POST as revealPost } from "../app/api/workspaces/[workspaceId]/tool-links/[toolLinkId]/reveal/route";

const workspaceId = "synthetic-workspace";
const credential = (scopes?: string[]): Extract<AppActor, { kind: "agent" }> => ({
  kind: "agent", authProvider: "credential", label: "Synthetic agent",
  credentialId: "synthetic-agent", credentialVersion: mcpCredentialVersion("synthetic-hash"),
  workspaceIds: [workspaceId], scopes,
});
const request = (method: string, suffix: string) => new NextRequest(`https://synthetic.example.test/api/workspaces/${workspaceId}/${suffix}`, {
  method, headers: { authorization: "Bearer synthetic-unused-token" },
});
const context = () => ({ params: Promise.resolve({ workspaceId, toolLinkId: "synthetic-tool" }) });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.featureEnabled = true;
  mocks.manifests.length = 0; mocks.nativeInputs.length = 0; mocks.snapshots.length = 0;
  mocks.store.$queryRaw.mockReset().mockResolvedValue([]); mocks.store.$executeRaw.mockReset().mockResolvedValue(1);
  installSourcePermissionEpochFixture(mocks.store);
  mocks.store.artifactInputLineage.create.mockImplementation(async ({ data }) => { const row = { id: `manifest-${mocks.manifests.length}`, ...data }; mocks.manifests.push(row); return row; });
  mocks.store.artifactInputLineage.findFirst.mockImplementation(async ({ where }) => [...mocks.manifests].reverse().find(row => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && row.artifactId === where.artifactId) ?? null);
  mocks.store.artifactInputLineage.findMany.mockImplementation(async ({ where }) => mocks.manifests.filter(row => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && where.artifactId.in.includes(row.artifactId)));
  for (const [delegate, rows] of [[mocks.store.mcpToolInput, mocks.nativeInputs], [mocks.store.artifactInputSnapshot, mocks.snapshots]] as const) {
    delegate.create.mockImplementation(async ({ data }: any) => { const row = { id: `native-${rows.length}`, createdAt: new Date(), ...data }; rows.push(row); return row; });
    delegate.findFirst.mockImplementation(async ({ where }: any) => rows.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
  }
  mocks.decrypt.mockImplementation((value?: string) => value === "synthetic-ciphertext" ? "synthetic-output" : decryptNativeInput(value!));
  mocks.store.$transaction.mockImplementation(async (run: (tx: typeof mocks.store) => Promise<unknown>) => run(new Proxy(mocks.store, { get(target, property) { return property === "$transaction" ? undefined : Reflect.get(target, property); } }) as any));
  mocks.store.workspaceSupportGrant.findUnique.mockResolvedValue(null);
  mocks.store.member.findUnique.mockResolvedValue({ id: "synthetic-member", role: "ADMIN", isActive: true });
  mocks.store.member.findFirst.mockResolvedValue({ userId: "synthetic-system-user" });
  mocks.archive.mockResolvedValue({ id: "synthetic-action" });
  mocks.externalSearch.mockResolvedValue({ results: [], errors: [] });
  mocks.store.agentCredential.findUnique.mockResolvedValue({ id: "synthetic-agent", workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: ["tools:credentials:read", "actions:read", "actions:write"] });
  mocks.store.agentCredential.findFirst.mockImplementation(async ({ where }) => {
    const row = await mocks.store.agentCredential.findUnique({ where: { id: where.id } });
    return row?.isActive && row.workspaceId === where.workspaceId ? row : null;
  });
  mocks.link = { id: "synthetic-tool", workspaceId, title: "Synthetic tool", createdByUserId: "synthetic-creator",
    url: "https://synthetic.example.test", category: "OTHER", descriptionMd: null, accessNotesMd: null,
    credentialLabel: "Synthetic label", credentialSecretEnc: "synthetic-ciphertext", archivedAt: null,
    archivedByUserId: null, archiveReason: null, circleTags: [], createdAt: new Date("2026-10-13"), updatedAt: new Date("2026-10-13") };
  mocks.store.workspaceToolLink.findFirst.mockImplementation(async ({ where, select }: any) => {
    if (where.id !== mocks.link.id || where.workspaceId !== mocks.link.workspaceId) return null;
    return select ? Object.fromEntries(Object.keys(select).map(key => [key, mocks.link[key]])) : { ...mocks.link };
  });
  mocks.store.action.findMany.mockResolvedValue([]);
  mocks.store.action.count.mockResolvedValue(0);
  await recordArtifactInputLineage({ tx: mocks.store as any, actor: { kind: "user", user: { id: "synthetic-creator", email: "creator@example.test", displayName: "Creator" } }, workspaceId,
    artifact: { kind: "WorkspaceToolLink", id: mocks.link.id }, content: mocks.link, origin: "HUMAN_ORIGINAL", inputs: [] });
  mocks.store.workspaceToolLink.findFirst.mockClear(); mocks.store.$transaction.mockClear();
});

const listRoute = withWorkspaceRoute(async (_req, { actor, workspaceId: workspace }) => NextResponse.json(await listActions(actor, workspace)));
const createRoute = withWorkspaceRoute(async (_req, { actor, workspaceId: workspace }) => {
  await createAction(actor, { workspaceId: workspace, title: "Synthetic action" });
  return NextResponse.json({ created: true });
});

describe("scoped agent transport and domain parity through actual auth and wrapper", () => {
  it.each([undefined, [], ["tools:read"], ["tools:write"]].map(scopes => ({ scopes })))("denies REST and direct-domain reveal with scopes %j before secret access", async ({ scopes }) => {
    mocks.actor = credential(scopes);
    const response = await revealPost(request("POST", "tool-links/synthetic-tool/reveal"), context());
    expect(response.status).toBe(403);
    await expect(revealWorkspaceToolLinkCredential(mocks.actor, { workspaceId, toolLinkId: "synthetic-tool" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.store.workspaceToolLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ["tools:read"]].map(scopes => ({ scopes })))("MCP also denies reveal with scopes %j", ({ scopes }) => {
    const actor = credential(scopes);
    expect(() => requireScope({ actor, workspaceId, authKind: "agent", scopes }, "tools:credentials:read")).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("permits the sensitive REST/domain path with explicit current grant", async () => {
    mocks.actor = credential(["tools:credentials:read"]);
    mocks.store.agentCredential.findUnique.mockResolvedValue({ id: "synthetic-agent", workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: [...mocks.actor.scopes!] });
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

async function actualMcpTools(scopes?: string[], principal: "credential" | "oauth-human" = "credential") {
  const actor: AppActor = principal === "credential" ? credential(scopes) : {
    kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: null },
  };
  const liveScopes = [...(scopes ?? [])];
  const row = { id: principal === "credential" ? "synthetic-agent" : "synthetic-oauth", workspaceId,
    userId: principal === "oauth-human" ? "synthetic-user" : undefined, isActive: true, tokenHash: "synthetic-hash",
    scopes: liveScopes, revokedAt: null, client: { isActive: true } };
  mocks.store.agentCredential.findUnique.mockResolvedValue(row);
  mocks.store.mcpOAuthAccessToken.findUnique.mockResolvedValue(row);
  mocks.store.mcpOAuthAccessToken.findFirst.mockResolvedValue(row);
  const origin = principal === "credential"
    ? { kind: "agent" as const, id: row.id, workspaceId, credentialVersion: mcpCredentialVersion(row.tokenHash), scopeHash: mcpScopesHash(liveScopes) }
    : { kind: "oauth" as const, id: row.id, workspaceId, scopeHash: mcpScopesHash(liveScopes), grantEpoch: await captureMcpOAuthGrantEpoch(mocks.store as any, workspaceId, row.id) };
  const server = createCorgtexMcpServer({ actor, workspaceId, authKind: principal === "credential" ? "agent" : "oauth", scopes, mcpOrigin: origin });
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
}

describe("actual registered MCP callback parity", () => {
  it.each(["credential", "oauth-human"] as const)("dispatches provider-only search under the transport grant (mock provider, %s)", async principal => {
    const scopes = ["external-tools:read"];
    const tools = await actualMcpTools(scopes, principal);
    await expect(tools.search_connected_context.handler({ query: "synthetic-provider-query", includeCorgtex: false })).resolves.toBeDefined();
    expect(mocks.externalSearch).toHaveBeenCalledOnce();
    expect(mocks.knowledgeSearch).not.toHaveBeenCalled();
    await expect(tools.search_connected_context.handler({ query: "synthetic-combined-query" })).rejects.toMatchObject({ status: 403 });
    await expect(tools.search_connected_context.handler({ query: "synthetic-combined-query", includeCorgtex: true })).rejects.toMatchObject({ status: 403 });
    expect(mocks.externalSearch).toHaveBeenCalledOnce();
    expect(mocks.knowledgeSearch).not.toHaveBeenCalled();
  });
  it.each([undefined, [], ["tools:read"], ["tools:write"]].map(scopes => ({ scopes })))("denies reveal with insufficient scope %j before domain secret access", async ({ scopes }) => {
    await expect((await actualMcpTools(scopes)).reveal_tool_link_credential.handler({ toolLinkId: "synthetic-tool" })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(mocks.store.workspaceToolLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ["tools:credentials:read"]].map(scopes => ({ scopes })))("keeps parameter-dependent version read scope checks with grants %j", async ({ scopes }) => {
    await expect((await actualMcpTools(scopes)).list_work_item_versions.handler({ entityType: "ACTION", entityId: "synthetic-action" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.store.action.findMany).not.toHaveBeenCalled();
  });

  it("allows explicit sensitive grant through the actual domain operation", async () => {
    const result = await (await actualMcpTools(["tools:credentials:read"])).reveal_tool_link_credential.handler({ toolLinkId: "synthetic-tool" });
    expect(JSON.stringify(result)).toContain("synthetic-output");
    expect(mocks.decrypt).toHaveBeenCalledOnce();
  });

  it("allows Actions read while denying Actions write through registered callbacks", async () => {
    const tools = await actualMcpTools(["actions:read"]);
    await expect(tools.list_actions.handler({})).resolves.toBeDefined();
    await expect(tools.delete_action.handler({ actionId: "synthetic-action" })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("allows Actions write while denying Actions read through registered callbacks", async () => {
    const tools = await actualMcpTools(["actions:write"]);
    await expect(tools.delete_action.handler({ actionId: "synthetic-action" })).resolves.toBeDefined();
    await expect(tools.list_actions.handler({})).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.store.action.findMany).not.toHaveBeenCalled();
  });
});
