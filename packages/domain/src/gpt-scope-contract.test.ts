import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { requiredAgentOperationScopes, requireScopedOperation } from "./agent-operation-capabilities";
import { createOAuthApp, issueAuthorizationCode } from "./oauth-server";

const mocks = vi.hoisted(() => ({
  app: { create: vi.fn(), findUnique: vi.fn() },
  code: { create: vi.fn() },
}));
vi.mock("@corgtex/shared", () => ({
  prisma: { oAuthApp: mocks.app, oAuthAuthorizationCode: mocks.code },
  randomOpaqueToken: () => "synthetic-opaque-value",
  sha256: (value: string) => `synthetic-hash:${value}`,
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn() }));
vi.mock("./oauth-workspace-authorization", () => ({
  withOAuthWorkspaceAuthorization: async (_userId: string, _workspaceId: string, run: (tx: unknown) => Promise<unknown>) =>
    run({ oAuthAuthorizationCode: mocks.code }),
}));

const actor: AppActor = {
  kind: "user", user: { id: "synthetic-user", email: "synthetic@example.test", displayName: null },
};
const workspaceId = "synthetic-workspace";
const redirectUri = "https://chatgpt.com/aip/g-synthetic/oauth/callback";
const legacyScopes = ["chat", "read", "write"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.findUnique.mockResolvedValue({
    id: "synthetic-app", workspaceId, scopes: legacyScopes,
    redirectUris: [redirectUri], isActive: true, archivedAt: null,
  });
  mocks.app.create.mockImplementation(async ({ data }) => ({ id: "synthetic-app", ...data }));
});

describe("legacy GPT OAuth grant contract", () => {
  it.each(["chat", "read", "write"])("issues exactly the requested legacy %s grant", async scope => {
    await issueAuthorizationCode(actor, { workspaceId, clientId: "synthetic-client", redirectUri, scopes: [scope] });
    expect(mocks.code.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ scopes: [scope] }),
    }));
  });

  it("retains the configured legacy default without synthesizing canonical grants", async () => {
    await issueAuthorizationCode(actor, { workspaceId, clientId: "synthetic-client", redirectUri, scopes: [] });
    expect(mocks.code.create.mock.calls[0][0].data.scopes).toEqual(legacyScopes);
  });

  it.each(["conversations:write", "actions:write", "tools:credentials:read", "finance:read"])(
    "cannot opt into canonical %s through the legacy app contract", async scope => {
      await expect(createOAuthApp(actor, { workspaceId, name: "Synthetic app", redirectUris: [redirectUri], scopes: [scope] }))
        .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      await expect(issueAuthorizationCode(actor, { workspaceId, clientId: "synthetic-client", redirectUri, scopes: [scope] }))
        .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
      expect(mocks.app.create).not.toHaveBeenCalled();
      expect(mocks.code.create).not.toHaveBeenCalled();
    },
  );

  it("has an unambiguous chat-only canonical scope", () => {
    expect(requiredAgentOperationScopes("chat")).toEqual(["conversations:write"]);
    expect(() => requireScopedOperation("chat", ["conversations:write"])).not.toThrow();
    expect(() => requireScopedOperation("reveal_tool_link_credential", ["conversations:write"]))
      .toThrow(expect.objectContaining({ status: 403 }));
  });

  it.each([
    ["create_action", "delete_action"],
    ["create_tension", "delete_tension"],
    ["create_proposal", "archive_proposal"],
    ["create_goal", "archive_goal"],
  ])("requires an operation allowlist to represent create-only %s consent", (createOperation, otherOperation) => {
    const scopes = requiredAgentOperationScopes(createOperation)!;
    expect(() => requireScopedOperation(createOperation, scopes)).not.toThrow();
    // These are intentionally valid canonical grants. The proof is that scopes
    // alone cannot distinguish this pair under legacy create-only consent.
    expect(requiredAgentOperationScopes(otherOperation)).toEqual(scopes);
    expect(() => requireScopedOperation(otherOperation, scopes)).not.toThrow();
  });

  it("cannot safely combine legacy read/write as broad category grants", () => {
    const scopes = [...requiredAgentOperationScopes("list_actions")!, ...requiredAgentOperationScopes("create_action")!];
    expect(() => requireScopedOperation("update_action", scopes)).not.toThrow();
    expect(() => requireScopedOperation("complete_action", scopes)).not.toThrow();
  });
});
