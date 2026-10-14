import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpScopesHash, prisma, sha256, type AppActor } from "@corgtex/shared";
import { runWithSupportOrigin } from "../../shared/src/support-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createActivity, createCrmAccount } from "../../domain/src/crm";
import { captureArtifactInputProof, inspectStoredArtifactInputDependencies, isArtifactInputProofReadable } from "../../domain/src/source-lineage";
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

  it.each(["record_relationship_activity", "complete_relationship_activity", "create_communication_suggestion"] as const)("binds native %s creation and confirmation to one session and complete OAuth request roots", async toolName => runWithSupportOrigin(undefined, async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic MCP pending CRM", plan: "PAYG_AI", slug: `mcp-pending-${randomUUID()}` } });
    const user = await prisma.user.create({ data: { email: `mcp-pending-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
    const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null } };
    const account = await createCrmAccount(actor, { workspaceId: workspace.id, name: "Synthetic MCP account" });
    const initialActivity = toolName === "complete_relationship_activity" ? await createActivity(actor, {
      workspaceId: workspace.id, title: "Synthetic activity awaiting completion", accountId: account.id,
    }) : null;
    const initialActivityCount = initialActivity ? 1 : 0;
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
    const args = initialActivity ? { activityId: initialActivity.id }
      : { title: "Synthetic MCP permitted effect", bodyMd: "Synthetic exact approved body", accountId: account.id };
    model.chat.mockResolvedValueOnce(reply("", [{ id: "synthetic-pending-call", type: "function", function: {
      name: toolName, arguments: JSON.stringify(args),
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
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(initialActivityCount);
    expect(await prisma.crmCommunicationSuggestion.count({ where: { workspaceId: workspace.id } })).toBe(0);
    if (initialActivity) expect((await prisma.crmActivity.findUniqueOrThrow({ where: { id: initialActivity.id } })).completedAt).toBeNull();
    const confirmed = await registeredChat({ message: `confirm ${pending.id}` });
    expect(JSON.stringify(confirmed)).toContain(toolName === "create_communication_suggestion" ? "Suggestion ID:" : "Activity ID:");
    expect(await prisma.conversationSession.count({ where: { workspaceId: workspace.id } })).toBe(1);
    expect(await prisma.conversationIngressInput.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect((await prisma.conversationPendingOperation.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("EXECUTED");
    const expectedActivityCount = initialActivityCount + (toolName === "record_relationship_activity" ? 1 : 0);
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(expectedActivityCount);
    const confirmationInput = await prisma.conversationIngressInput.findFirstOrThrow({ where: { workspaceId: workspace.id, content: `confirm ${pending.id}` } });
    const effect = toolName === "create_communication_suggestion"
      ? { kind: "CrmCommunicationSuggestion" as const, id: (await prisma.crmCommunicationSuggestion.findFirstOrThrow({ where: { workspaceId: workspace.id } })).id }
      : { kind: "CrmActivity" as const, id: (await prisma.crmActivity.findFirstOrThrow({ where: { workspaceId: workspace.id } })).id };
    const auditAction = toolName === "create_communication_suggestion" ? "crm.communication_suggestion.created"
      : toolName === "complete_relationship_activity" ? "crm.activity.completed" : null;
    // Activity creation currently has no domain audit; completion and suggestion
    // do, and their applicable rows must commit exactly once with the effect.
    if (auditAction) expect(await prisma.auditLog.findMany({ where: { workspaceId: workspace.id, entityId: effect.id, action: auditAction } }))
      .toEqual([expect.objectContaining({ actorUserId: user.id, entityType: effect.kind })]);
    if (initialActivity) expect((await prisma.crmActivity.findUniqueOrThrow({ where: { id: initialActivity.id } })).completedAt).toBeInstanceOf(Date);
    for (const artifact of [effect,
      { kind: "ConversationPendingOperation" as const, id: pending.id }]) {
      const committedRoots = await captureArtifactInputProof(actor, workspace.id, [artifact]);
      // The prepared request is preserved as an immutable snapshot; inspect its
      // full stored closure rather than requiring a mutable direct source root.
      const closure = await inspectStoredArtifactInputDependencies(prisma, workspace.id, committedRoots);
      expect(closure.complete).toBe(true);
      expect(closure.roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ConversationIngressInput", id: ingress.id }),
        expect.objectContaining({ kind: "ConversationIngressInput", id: confirmationInput.id })]));
      expect(await isArtifactInputProofReadable(actor, workspace.id, committedRoots)).toBe(true);
    }
    expect(model.chat).toHaveBeenCalledTimes(2); // confirmation uses stored approved args without another model
    await prisma.mcpOAuthAccessToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await expect(registeredChat({ message: `confirm ${pending.id}` })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(await prisma.crmActivity.count({ where: { workspaceId: workspace.id } })).toBe(expectedActivityCount);
    if (auditAction) expect(await prisma.auditLog.count({ where: { workspaceId: workspace.id, entityId: effect.id, action: auditAction } })).toBe(1);
    await server.close();
  }));
});
