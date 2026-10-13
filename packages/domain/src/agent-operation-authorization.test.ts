import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const mocks = vi.hoisted(() => ({
  membership: vi.fn(), credential: vi.fn(), grant: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({
  prisma: { agentCredential: { findUnique: mocks.credential }, workspaceSupportGrant: { findUnique: mocks.grant } },
  mcpCredentialVersion: (tokenHash: string) => `version:${tokenHash}`,
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: mocks.membership }));
import { requireWorkspaceOperation } from "./agent-operation-authorization";

const actor: AppActor = {
  kind: "agent", authProvider: "credential", credentialId: "synthetic-credential",
  credentialVersion: "version:synthetic-hash", label: "Synthetic agent",
  workspaceIds: ["synthetic-workspace"], scopes: ["tools:credentials:read"],
};
const request = { actor, workspaceId: "synthetic-workspace", operation: "reveal_tool_link_credential" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue(null);
  mocks.grant.mockResolvedValue(null);
  mocks.credential.mockResolvedValue({
    workspaceId: "synthetic-workspace", isActive: true,
    tokenHash: "synthetic-hash", scopes: ["tools:credentials:read"], createdBy: null, supportGrantVersion: null,
  });
});

describe("current workspace operation authorization", () => {
  it.each([undefined, [], ["tools:read"]])("denies insufficient scopes before any database access %j", async scopes => {
    await expect(requireWorkspaceOperation({ ...request, actor: { ...actor, scopes } })).rejects.toMatchObject({ status: 403 });
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("fails closed for undeclared operations before storage access", async () => {
    await expect(requireWorkspaceOperation({ ...request, operation: "new_operation" })).rejects.toMatchObject({ code: "AGENT_OPERATION_UNDECLARED" });
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("checks workspace and support membership before credential metadata", async () => {
    mocks.membership.mockRejectedValue(Object.assign(new Error("denied"), { status: 403, code: "SUPPORT_AUTHORIZATION_REVOKED" }));
    await expect(requireWorkspaceOperation(request)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { isActive: false },
    { workspaceId: "different-workspace" },
    { tokenHash: "rotated-synthetic-hash" },
    { scopes: [] },
  ])("denies revoked, rotated or reduced credential authority %j", async overrides => {
    const current = await mocks.credential();
    mocks.credential.mockResolvedValue(overrides === null ? null : { ...current, ...overrides });
    await expect(requireWorkspaceOperation(request)).rejects.toMatchObject({ status: 403, code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it("allows exactly the active current credential grant", async () => {
    await expect(requireWorkspaceOperation(request)).resolves.toBeNull();
    expect(mocks.credential).toHaveBeenCalledWith({
      where: { id: "synthetic-credential" },
      select: { workspaceId: true, isActive: true, tokenHash: true, scopes: true,
        createdBy: { select: { id: true } }, supportGrantVersion: true },
    });
  });

  it.each([
    { role: "SETUP", isActive: true, version: 1 },
    { role: "FULL", isActive: false, version: 1 },
    { role: "FULL", isActive: true, version: 2 },
  ])("rechecks newly restricted support authority even when the cached actor lacks supportOrigin %j", async grant => {
    const current = await mocks.credential();
    mocks.credential.mockResolvedValue({ ...current, createdBy: { id: "synthetic-support" }, supportGrantVersion: 1 });
    mocks.grant.mockResolvedValue(grant);
    await expect(requireWorkspaceOperation(request)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("revalidates support:write when a managerial operation relies on it", async () => {
    await expect(requireWorkspaceOperation({ ...request,
      actor: { ...actor, scopes: ["tools:credentials:read", "support:write"] }, allowedRoles: ["ADMIN"],
    })).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
  });

  it("permits an unchanged Full support grant", async () => {
    const current = await mocks.credential();
    mocks.credential.mockResolvedValue({ ...current, createdBy: { id: "synthetic-support" }, supportGrantVersion: 1 });
    mocks.grant.mockResolvedValue({ role: "FULL", isActive: true, version: 1 });
    await expect(requireWorkspaceOperation(request)).resolves.toBeNull();
  });

  it("denies deleted support authority", async () => {
    const current = await mocks.credential();
    mocks.credential.mockResolvedValue({ ...current, createdBy: { id: "synthetic-support" }, supportGrantVersion: 1 });
    await expect(requireWorkspaceOperation(request)).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("uses the actual sensitive-operation transaction", async () => {
    const txCredential = vi.fn().mockResolvedValue({ workspaceId: "synthetic-workspace", isActive: false });
    const tx = { agentCredential: { findUnique: txCredential } } as unknown as NonNullable<Parameters<typeof requireWorkspaceOperation>[0]["tx"]>;
    await expect(requireWorkspaceOperation({ ...request, tx })).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REVOKED" });
    expect(mocks.membership).toHaveBeenCalledWith({ actor, workspaceId: "synthetic-workspace", tx });
    expect(txCredential).toHaveBeenCalledOnce();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it.each<AppActor>([
    { kind: "user", user: { id: "creator", email: "creator@example.test", displayName: null } },
    { kind: "agent", authProvider: "bootstrap", label: "trusted-bootstrap", workspaceIds: ["synthetic-workspace"] },
  ])("preserves human and bootstrap membership/role authorization %j", async trustedActor => {
    const membership = { role: "ADMIN", isActive: true };
    mocks.membership.mockResolvedValue(membership);
    await expect(requireWorkspaceOperation({ ...request, actor: trustedActor, allowedRoles: ["ADMIN"] })).resolves.toBe(membership);
    expect(mocks.membership).toHaveBeenCalledWith({ actor: trustedActor, workspaceId: "synthetic-workspace", allowedRoles: ["ADMIN"] });
    expect(mocks.credential).not.toHaveBeenCalled();
  });
});
