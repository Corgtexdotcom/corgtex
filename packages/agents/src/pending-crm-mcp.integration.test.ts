import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpScopesHash, prisma, sha256, type AppActor } from "@corgtex/shared";
import { runWithSupportOrigin } from "../../shared/src/support-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createCrmAccount } from "../../domain/src/crm";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "../../domain/src/source-lineage";
import { listMcpConnectorInstances, resolveMcpOAuthAccessToken } from "../../domain/src/mcp-connector";

const model = vi.hoisted(() => ({ chat: vi.fn(), embed: vi.fn(), rerank: vi.fn() }));
vi.mock("@corgtex/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@corgtex/models")>(),
  defaultModelGateway: { chat: model.chat, embed: model.embed, rerank: model.rerank },
}));
import { createCorgtexMcpServer } from "../../mcp/src/server";

const reply = (content: string, tool_calls?: any[]) => ({ content, tool_calls, model: "synthetic-chat",
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

describe("registered MCP chat with native ingress and actual pending CRM execution", () => {
  beforeEach(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/corgtex_test" || target.searchParams.get("schema") !== "public") {
      throw new Error("This suite requires the disposable local test database.");
    }
    await truncateAllTables(); vi.clearAllMocks();
    model.embed.mockResolvedValue({ embeddings: [[1, 0]], usage: {} });
    model.rerank.mockResolvedValue({ results: [], usage: {} });
  });

  it("binds pending creation and confirmation to the same stored mcp-assistant session and native OAuth request roots", async () => runWithSupportOrigin(undefined, async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic MCP pending CRM", plan: "PAYG_AI", slug: `mcp-pending-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `mcp-pending-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null } };
    const account = await createCrmAccount(actor, { workspaceId: workspace.id, name: "Synthetic MCP account" });
    const scopes = ["workspace:read", "conversations:write", "relationships:read", "relationships:write", "brain:read"];
    const client = await prisma.mcpOAuthClient.create({ data: { clientId: `synthetic-client-${randomUUID()}`, name: "Synthetic in-process MCP", redirectUris: [], scopes } });
    const bearer = `mcp_at_${randomUUID()}`;
    const token = await prisma.mcpOAuthAccessToken.create({ data: { clientId: client.id, userId: user.id, workspaceId: workspace.id,
      instanceSlug: listMcpConnectorInstances()[0]!.slug, tokenHash: sha256(bearer), scopes,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    const authenticated = await resolveMcpOAuthAccessToken(bearer);
    expect(authenticated?.connectionId).toBe(token.id);
    expect(authenticated?.actor.kind).toBe("user");
    const server = createCorgtexMcpServer({ actor, workspaceId: workspace.id, authKind: "oauth", scopes,
      mcpOrigin: { kind: "oauth", id: token.id, workspaceId: workspace.id,
        scopeHash: mcpScopesHash(scopes), grantEpoch: authenticated!.grantEpoch } });
    const registeredChat = (server as any)._registeredTools.chat.handler as (args: { message: string }) => Promise<any>;
    const args = { title: "Synthetic MCP permitted effect", bodyMd: "Synthetic exact approved body", accountId: account.id };
    model.chat.mockResolvedValueOnce(reply("", [{ id: "synthetic-pending-call", type: "function", function: {
      name: "record_relationship_activity", arguments: JSON.stringify(args),
    } }])).mockResolvedValueOnce(reply("Synthetic change prepared for confirmation."));
    const request = "Prepare the synthetic account follow-up.";
    const prepared = await registeredChat({ message: request });
    const session = await prisma.conversationSession.findFirstOrThrow({ where: { workspaceId: workspace.id, userId: user.id } });
    expect(session.agentKey).toBe("mcp-assistant");
    const pending = await prisma.conversationPendingOperation.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(pending).toMatchObject({ conversationId: session.id, userId: user.id, agentKey: "mcp-assistant", status: "PENDING", argsJson: args });
    expect(JSON.stringify(prepared)).toContain(pending.id);
    const ingress = await prisma.conversationIngressInput.findFirstOrThrow({ where: { workspaceId: workspace.id, content: request } });
    expect(ingress).toMatchObject({ actorKind: "user", userId: user.id });
    expect(await prisma.conversationPromptInput.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.mcpToolInput.count({ where: { workspaceId: workspace.id } })).toBe(0);
    const roots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "ConversationPendingOperation", id: pending.id }]);
    expect(roots.some(root => root.kind === "ConversationIngressInput" && root.id === ingress.id)).toBe(true);
    expect(await isArtifactInputProofReadable(actor, workspace.id, roots)).toBe(true);
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(0);
    const confirmed = await registeredChat({ message: `confirm ${pending.id}` });
    expect(JSON.stringify(confirmed)).toContain("Activity ID:");
    expect(await prisma.conversationSession.count({ where: { workspaceId: workspace.id } })).toBe(1);
    expect(await prisma.conversationIngressInput.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect((await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("EXECUTED");
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(1);
    expect(model.chat).toHaveBeenCalledTimes(2); // confirmation uses stored approved args without another model
    await prisma.mcpOAuthAccessToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await expect(registeredChat({ message: `confirm ${pending.id}` })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(1);
    await server.close();
  }));
});
