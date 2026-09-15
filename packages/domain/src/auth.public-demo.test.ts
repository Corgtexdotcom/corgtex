import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), sessionCreate: vi.fn(), sessionFind: vi.fn(), sessionUpdate: vi.fn(), workspaceFind: vi.fn(), memberFind: vi.fn(), supportFind: vi.fn(), token: vi.fn(() => "token") }));
vi.mock("@corgtex/shared", () => ({
  env: { SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 300000 },
  prisma: { user: { findUnique: mocks.user }, session: { create: mocks.sessionCreate, findUnique: mocks.sessionFind, updateMany: mocks.sessionUpdate }, workspace: { findMany: mocks.workspaceFind }, member: { findUnique: mocks.memberFind }, workspaceSupportGrant: { findUnique: mocks.supportFind } },
  isPasswordLoginDisabled: (hash: string) => hash.startsWith("disabled$"),
  hashPassword: vi.fn(), verifyPassword: vi.fn(), randomOpaqueToken: mocks.token, sha256: (value: string) => value,
  getMcpOrigin: vi.fn(), setSupportAuthorizationActor: vi.fn(), setSupportAuthorizationGrant: vi.fn(), getSupportAuthorizationContext: vi.fn(), assertMcpOriginActive: vi.fn(),
}));
import { createSession, resolveSessionActor, requireWorkspaceMembership, listActorWorkspaces } from "./auth";
const actor = { kind: "user" as const, user: { id: "demo-user", email: "demo@jnj-demo.corgtex.app", displayName: "Demo", globalRole: "USER" as const } };
function dedicated() {
  return { ...actor.user, passwordHash: "ordinary-hash", memberships: [{ workspaceId: "demo", role: "CONTRIBUTOR", workspace: { slug: "jnj-demo" } }], workspaceSupportGrants: [] as { workspaceId: string }[] };
}
describe("central public demo isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.supportFind.mockResolvedValue(null); mocks.user.mockResolvedValue(dedicated()); mocks.memberFind.mockResolvedValue({ id: "membership", workspaceId: "demo", userId: actor.user.id, role: "CONTRIBUTOR", isActive: true }); });
  it.each(["foreign-member", "operator", "admin", "foreign-support", "wrong-slug", "no-member"])("fails closed for %s on session creation, resolution, and discovery", async scenario => {
    const user = dedicated();
    if (scenario === "foreign-member") user.memberships.push({ workspaceId: "client", role: "CONTRIBUTOR", workspace: { slug: "client" } });
    if (scenario === "operator") Object.assign(user, { globalRole: "OPERATOR" });
    if (scenario === "admin") user.memberships[0].role = "ADMIN";
    if (scenario === "foreign-support") user.workspaceSupportGrants.push({ workspaceId: "client" });
    if (scenario === "wrong-slug") user.memberships[0].workspace.slug = "client";
    if (scenario === "no-member") user.memberships = [];
    mocks.user.mockResolvedValue(user);
    await expect(createSession(actor.user.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.sessionCreate).not.toHaveBeenCalled();
    mocks.sessionFind.mockResolvedValue({ id: "session", user: actor.user, expiresAt: new Date(Date.now()+60000), lastSeenAt: new Date(0) });
    await expect(resolveSessionActor("old-token")).resolves.toBeNull(); expect(mocks.sessionUpdate).not.toHaveBeenCalled();
    await expect(listActorWorkspaces(actor)).resolves.toEqual([]); expect(mocks.workspaceFind).not.toHaveBeenCalled();
  });
  it("refuses cached foreign membership even when added after actor resolution", async () => {
    await expect(requireWorkspaceMembership({ actor, workspaceId: "client", resolvedMembership: { id: "foreign", workspaceId: "client", userId: actor.user.id, role: "ADMIN", isActive: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.memberFind).not.toHaveBeenCalled(); expect(mocks.supportFind).not.toHaveBeenCalled();
  });
  it("rechecks scope when a cached demo actor later gains foreign support", async () => {
    const user = dedicated(); user.workspaceSupportGrants.push({ workspaceId: "client" }); mocks.user.mockResolvedValue(user);
    await expect(requireWorkspaceMembership({ actor, workspaceId: "demo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("allows dedicated contributor login and restricts discovery query to demo", async () => {
    await expect(createSession(actor.user.id)).resolves.toMatchObject({ token: "token" });
    await expect(requireWorkspaceMembership({ actor, workspaceId: "demo" })).resolves.toMatchObject({ workspaceId: "demo" });
    mocks.workspaceFind.mockResolvedValue([{ id: "demo", slug: "jnj-demo" }]);
    await expect(listActorWorkspaces(actor)).resolves.toEqual([{ id: "demo", slug: "jnj-demo" }]);
    expect(mocks.workspaceFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "demo", slug: "jnj-demo" } }));
  });
});
