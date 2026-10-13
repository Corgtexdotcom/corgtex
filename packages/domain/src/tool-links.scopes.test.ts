import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  store: {
    $transaction: vi.fn(),
    workspaceToolLink: { findFirst: vi.fn() },
    agentCredential: { findUnique: vi.fn() },
    workspaceSupportGrant: { findUnique: vi.fn() },
    member: { findUnique: vi.fn() },
  },
  decrypt: vi.fn(() => "synthetic-output"), audit: vi.fn(), events: [] as string[],
}));
vi.mock("@corgtex/shared", () => ({
  prisma: mocks.store,
  env: {},
  getMcpOrigin: () => undefined,
  setSupportAuthorizationActor: vi.fn(),
  setSupportAuthorizationGrant: vi.fn(),
  getSupportAuthorizationContext: () => undefined,
  mcpCredentialVersion: (hash: string) => `version:${hash}`,
  decryptSecret: mocks.decrypt,
  encryptSecret: vi.fn(),
}));
vi.mock("./audit-trail", () => ({ recordAudit: mocks.audit }));
vi.mock("./archive", () => ({ archiveFilterWhere: () => ({ archivedAt: null }), archiveWorkspaceArtifact: vi.fn() }));
import { revealWorkspaceToolLinkCredential } from "./tool-links";

const agent = (scopes?: string[]): Extract<AppActor, { kind: "agent" }> => ({
  kind: "agent", authProvider: "credential", credentialId: "synthetic-agent",
  credentialVersion: "version:synthetic-token-hash", label: "Synthetic agent",
  workspaceIds: ["synthetic-workspace"], scopes,
});
const human = (id: string): AppActor => ({
  kind: "user", user: { id, email: `${id}@example.test`, displayName: id },
});
const params = { workspaceId: "synthetic-workspace", toolLinkId: "synthetic-tool" };
const reveal = (actor: AppActor) => revealWorkspaceToolLinkCredential(actor, params);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.store.$transaction.mockImplementation(async (run: (tx: typeof mocks.store) => Promise<unknown>) => run(mocks.store));
  mocks.store.workspaceSupportGrant.findUnique.mockResolvedValue(null);
  mocks.store.member.findUnique.mockResolvedValue({ id: "synthetic-member", role: "CONTRIBUTOR", isActive: true });
  mocks.store.agentCredential.findUnique.mockResolvedValue({
    workspaceId: "synthetic-workspace", isActive: true, tokenHash: "synthetic-token-hash",
    scopes: ["tools:credentials:read"],
  });
  mocks.store.workspaceToolLink.findFirst.mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
    if (select.credentialSecretEnc) mocks.events.push("secret-selected");
    return {
      id: "synthetic-tool", title: "Synthetic tool", createdByUserId: "creator",
      credentialLabel: "Synthetic credential", credentialSecretEnc: select.credentialSecretEnc ? "synthetic-ciphertext" : undefined,
    };
  });
  mocks.decrypt.mockImplementation(() => { mocks.events.push("decrypt"); return "synthetic-output"; });
  mocks.audit.mockImplementation(async () => { mocks.events.push("success-audit"); });
});

function expectSecretUntouched() {
  expect(mocks.events).not.toContain("secret-selected");
  expect(mocks.decrypt).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

describe("tool credential domain authorization with real membership checks", () => {
  it.each([undefined, [], ["tools:read"], ["tools:write"], ["support:write"]])(
    "denies insufficient scopes %j before selecting/decrypting a secret or recording success", async scopes => {
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

  it("preserves the trusted scoped bootstrap path", async () => {
    await expect(reveal({ kind: "agent", authProvider: "bootstrap", label: "synthetic-bootstrap", workspaceIds: ["synthetic-workspace"] })).resolves.toMatchObject({ credentialSecret: "synthetic-output" });
  });
});
