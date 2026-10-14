import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const f = vi.hoisted(() => ({
  prisma: {}, origin: null as any, events: [] as string[],
  finance: vi.fn(async () => { f.events.push("finance-physical"); }),
}));
vi.mock("@corgtex/shared", () => ({ prisma: f.prisma, getMcpOrigin: () => f.origin }));
vi.mock("./finance", () => ({ lockFinanceReadAuthority: f.finance }));
import { lockArtifactReadAuthorityRows } from "./artifact-read-authority-locks";

const actor = { kind: "user", user: { id: "owner", email: "owner@synthetic.test" } } as AppActor;
function transaction() {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      f.events.push(strings.join("?").match(/FROM "([^"]+)"/)?.[1] ?? "unknown");
      return [];
    }),
    mcpOAuthAccessToken: { findFirst: vi.fn(async () => ({ clientId: "client" })) },
  } as any;
}
beforeEach(() => { vi.clearAllMocks(); f.origin = null; f.events = []; });

describe("ambient source read-authority physical reservations", () => {
  it("takes Finance physical rows and the OAuth token/client before any source proof", async () => {
    f.origin = { kind: "oauth", id: "token", workspaceId: "workspace" };
    const tx = transaction();
    await lockArtifactReadAuthorityRows(actor, "workspace", tx);
    expect(f.finance).toHaveBeenCalledWith(tx, "workspace", "owner");
    expect(f.events).toEqual(["finance-physical", "User", "McpOAuthAccessToken", "McpOAuthClient"]);
  });
  it.each(["primary", "foreign-workspace"] as const)("rejects %s before any physical row operation", async mode => {
    if (mode === "foreign-workspace") f.origin = { kind: "oauth", id: "token", workspaceId: "foreign" };
    await expect(lockArtifactReadAuthorityRows(actor, "workspace", mode === "primary" ? f.prisma as any : transaction()))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.events).toEqual([]);
    expect(f.finance).not.toHaveBeenCalled();
  });
  it("holds the exact credential and support principal without treating locks as a policy result", async () => {
    const agent = { kind: "agent", credentialId: "credential", agentIdentityId: "identity",
      supportOrigin: { userId: "support-user", workspaceId: "workspace", version: 1 } } as AppActor;
    expect(await lockArtifactReadAuthorityRows(agent, "workspace", transaction())).toBeUndefined();
    expect(f.events).toEqual(["AgentCredential", "AgentIdentity", "User", "WorkspaceSupportGrant"]);
    expect(f.finance).not.toHaveBeenCalled();
  });
  it("withholds after a missing OAuth token instead of assuming a successful physical read grants access", async () => {
    f.origin = { kind: "oauth", id: "token", workspaceId: "workspace" };
    const tx = transaction();
    tx.mcpOAuthAccessToken.findFirst.mockResolvedValue(null);
    await expect(lockArtifactReadAuthorityRows(actor, "workspace", tx)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.events).toEqual(["finance-physical", "User", "McpOAuthAccessToken"]);
  });
});
