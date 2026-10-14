import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { mcpCredentialVersion } from "../../shared/src/mcp-context";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  store: {
    $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
    artifactInputLineage: { findFirst: vi.fn(), create: vi.fn() },
    workspaceToolLink: { findFirst: vi.fn() },
    agentCredential: { findUnique: vi.fn(), findFirst: vi.fn() },
    workspaceSupportGrant: { findUnique: vi.fn() },
    member: { findUnique: vi.fn() },
  },
  link: {} as any, manifests: [] as any[],
  decrypt: vi.fn(() => "synthetic-output"), audit: vi.fn(), events: [] as string[],
}));
vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"),
  prisma: mocks.store,
  env: {},
  setSupportAuthorizationActor: vi.fn(),
  setSupportAuthorizationGrant: vi.fn(),
  getSupportAuthorizationContext: () => undefined,
  decryptSecret: mocks.decrypt,
  encryptSecret: vi.fn(),
}));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: async () => ({ canRead: false }) }));
vi.mock("./audit-trail", () => ({ recordAudit: mocks.audit }));
vi.mock("./archive", () => ({ archiveFilterWhere: () => ({ archivedAt: null }), archiveWorkspaceArtifact: vi.fn() }));
import { recordArtifactInputLineage, captureArtifactInputProof } from "./source-lineage";
import { revealWorkspaceToolLinkCredential } from "./tool-links";

const agent = (scopes?: string[]): Extract<AppActor, { kind: "agent" }> => ({
  kind: "agent", authProvider: "credential", credentialId: "synthetic-agent",
  credentialVersion: mcpCredentialVersion("synthetic-token-hash"), label: "Synthetic agent",
  workspaceIds: ["synthetic-workspace"], scopes,
});
const human = (id: string): AppActor => ({
  kind: "user", user: { id, email: `${id}@example.test`, displayName: id },
});
const params = { workspaceId: "synthetic-workspace", toolLinkId: "synthetic-tool" };
const reveal = (actor: AppActor) => revealWorkspaceToolLinkCredential(actor, params);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.events.length = 0; mocks.manifests.length = 0;
  mocks.store.$queryRaw.mockReset().mockResolvedValue([]);
  mocks.store.$executeRaw.mockReset().mockResolvedValue(1);
  installSourcePermissionEpochFixture(mocks.store);
  mocks.store.artifactInputLineage.create.mockImplementation(async ({ data }) => { const row = { id: `manifest-${mocks.manifests.length}`, ...data }; mocks.manifests.push(row); return row; });
  mocks.store.artifactInputLineage.findFirst.mockImplementation(async ({ where }) => [...mocks.manifests].reverse().find(row => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && row.artifactId === where.artifactId) ?? null);
  mocks.store.$transaction.mockImplementation(async (run: (tx: typeof mocks.store) => Promise<unknown>) => run(mocks.store));
  mocks.store.workspaceSupportGrant.findUnique.mockResolvedValue(null);
  mocks.store.member.findUnique.mockResolvedValue({ id: "synthetic-member", role: "CONTRIBUTOR", isActive: true });
  mocks.store.agentCredential.findUnique.mockResolvedValue({
    id: "synthetic-agent", workspaceId: "synthetic-workspace", isActive: true, tokenHash: "synthetic-token-hash",
    scopes: ["tools:credentials:read"],
  });
  mocks.store.agentCredential.findFirst.mockImplementation(async ({ where }) => {
    const row = await mocks.store.agentCredential.findUnique({ where: { id: where.id } });
    return row?.isActive && row.workspaceId === where.workspaceId ? row : null;
  });
  mocks.link = { id: "synthetic-tool", workspaceId: "synthetic-workspace", title: "Synthetic tool", createdByUserId: "creator",
    url: "https://synthetic.example.test", category: "OTHER", descriptionMd: null, accessNotesMd: null,
    credentialLabel: "Synthetic credential", credentialSecretEnc: "synthetic-ciphertext", archivedAt: null,
    archivedByUserId: null, archiveReason: null, circleTags: [], createdAt: new Date("2026-10-13"), updatedAt: new Date("2026-10-13") };
  mocks.store.workspaceToolLink.findFirst.mockImplementation(async ({ where, select }: any) => {
    if (!select || select.credentialSecretEnc) mocks.events.push("secret-selected");
    if (where.id !== mocks.link.id || where.workspaceId !== mocks.link.workspaceId) return null;
    return select ? Object.fromEntries(Object.keys(select).map(key => [key, mocks.link[key]])) : { ...mocks.link };
  });
  mocks.decrypt.mockImplementation(() => { mocks.events.push("decrypt"); return "synthetic-output"; });
  mocks.audit.mockImplementation(async () => { mocks.events.push("success-audit"); });
  await recordArtifactInputLineage({ tx: mocks.store as any, actor: human("creator"), workspaceId: params.workspaceId,
    artifact: { kind: "WorkspaceToolLink", id: mocks.link.id }, content: mocks.link, origin: "HUMAN_ORIGINAL", inputs: [] });
  mocks.events.length = 0;
  mocks.store.workspaceToolLink.findFirst.mockClear();
});

function expectSecretUntouched() {
  expect(mocks.events).not.toContain("secret-selected");
  expect(mocks.decrypt).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

describe("tool credential domain authorization with real membership checks", () => {
  it.each([undefined, [], ["tools:read"], ["tools:write"], ["support:write"]].map(scopes => ({ scopes })))(
    "denies insufficient scopes %j before selecting/decrypting a secret or recording success", async ({ scopes }) => {
      await expect(reveal(agent(scopes))).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
      expectSecretUntouched();
    },
  );

  it("permits the explicit current sensitive scope", async () => {
    await expect(reveal(agent(["tools:credentials:read"]))).resolves.toEqual({
      credentialLabel: "Synthetic credential", credentialSecret: "synthetic-output",
    });
    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
    await expect(captureArtifactInputProof(agent(["tools:credentials:read"]), params.workspaceId,
      [{ kind: "WorkspaceToolLink", id: params.toolLinkId }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it.each(["missing", "changed"] as const)("requires the full current parent proof when it is %s", async state => {
    if (state === "missing") mocks.manifests.length = 0;
    else mocks.link.title = "Changed copied parent content";
    await expect(reveal(agent(["tools:credentials:read"]))).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("withholds a decrypted result after the current credential is revoked", async () => {
    mocks.decrypt.mockImplementation(() => {
      mocks.store.agentCredential.findUnique.mockResolvedValue({ id: "synthetic-agent", workspaceId: params.workspaceId,
        isActive: false, tokenHash: "synthetic-token-hash", scopes: ["tools:credentials:read"] });
      return "revoked-result-canary";
    });
    await expect(reveal(agent(["tools:credentials:read"]))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("revoked-result-canary");
  });

  it("rejects a stale scope snapshot even if the current grant still contains secret read", async () => {
    mocks.store.agentCredential.findUnique.mockResolvedValue({ id: "synthetic-agent", workspaceId: params.workspaceId,
      isActive: true, tokenHash: "synthetic-token-hash", scopes: ["tools:credentials:read", "tools:read"] });
    await expect(reveal(agent(["tools:credentials:read"]))).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("denies a different workspace before secret access", async () => {
    await expect(reveal({ ...agent(["tools:credentials:read"]), workspaceIds: ["other-workspace"] })).rejects.toMatchObject({ status: 403 });
    expectSecretUntouched();
  });

  it("denies revoked credentials at the domain boundary", async () => {
    mocks.store.agentCredential.findUnique.mockResolvedValue({ workspaceId: "synthetic-workspace", isActive: false });
    await expect(reveal(agent(["tools:credentials:read"]))).rejects.toMatchObject({ status: 403, code: "AGENT_AUTHORIZATION_REVOKED" });
    expectSecretUntouched();
  });

  it("rechecks credential authority inside the transaction before reading the secret", async () => {
    mocks.store.$transaction.mockImplementation(async (run: (tx: typeof mocks.store) => Promise<unknown>) => {
      mocks.store.agentCredential.findUnique.mockResolvedValue({ workspaceId: "synthetic-workspace", isActive: false });
      return run(mocks.store);
    });
    await expect(reveal(agent(["tools:credentials:read"]))).rejects.toMatchObject({ status: 403, code: "AGENT_AUTHORIZATION_REVOKED" });
    expectSecretUntouched();
  });

  it.each([
    { role: "SETUP", isActive: true, version: 1 },
    { role: "FULL", isActive: false, version: 1 },
    { role: "FULL", isActive: true, version: 2 },
  ])("denies invalid support-origin grant %j", async grant => {
    mocks.store.workspaceSupportGrant.findUnique.mockResolvedValue(grant);
    await expect(reveal({ ...agent(["tools:credentials:read"]), supportOrigin: { userId: "synthetic-support", workspaceId: "synthetic-workspace", version: 1 } })).rejects.toMatchObject({ status: 403, code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expectSecretUntouched();
  });

  it.each([
    ["creator", "CONTRIBUTOR"], ["admin", "ADMIN"], ["facilitator", "FACILITATOR"],
  ])("preserves the %s human path", async (id, role) => {
    mocks.store.member.findUnique.mockResolvedValue({ id: "synthetic-member", role, isActive: true });
    await expect(reveal(human(id))).resolves.toMatchObject({ credentialSecret: "synthetic-output" });
  });

  it("denies an active human nonmanager before selecting secret fields", async () => {
    await expect(reveal(human("other-member"))).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expectSecretUntouched();
  });

  it("denies an inactive human before secret access", async () => {
    mocks.store.member.findUnique.mockResolvedValue({ role: "ADMIN", isActive: false });
    await expect(reveal(human("inactive-admin"))).rejects.toMatchObject({ status: 403, code: "NOT_A_MEMBER" });
    expectSecretUntouched();
  });

  it("does not turn a bare bootstrap label into credential authority", async () => {
    await expect(reveal({ kind: "agent", authProvider: "bootstrap", label: "synthetic-bootstrap", workspaceIds: ["synthetic-workspace"] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
