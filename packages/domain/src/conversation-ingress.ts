import { mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { assertArtifactInputWriteFence, captureArtifactInputProof } from "./source-lineage";
import type { Prisma } from "@prisma/client";

/** Preserve the exact authenticated submission before it enters conversation context. */
export async function createConversationIngressInput(actor: AppActor, params: { workspaceId: string; content: string; tx?: Prisma.TransactionClient }) {
  const { workspaceId, content, tx: suppliedTx } = params;
  invariant(typeof content === "string", 400, "INVALID_INPUT", "Conversation input must be text.");
  invariant(actor.kind === "user" || (actor.authProvider === "credential" && typeof actor.credentialId === "string"
    && actor.credentialId.length > 0 && typeof actor.credentialVersion === "string" && actor.credentialVersion.length > 0
    && actor.scopes?.includes("conversations:write")),
  401, "AUTH_REQUIRED", "Conversation input requires an authenticated user or conversation credential.");

  const principal = actor.kind === "user" ? {
    actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null,
  } : {
    actorKind: "agent", userId: null, credentialId: actor.credentialId!, credentialVersion: actor.credentialVersion!, scopeHash: mcpScopesHash(actor.scopes ?? []),
  };
  const assertPrincipal = () => invariant(principal.actorKind === "user"
    ? actor.kind === "user" && actor.user.id === principal.userId
    : actor.kind === "agent" && actor.authProvider === "credential" && actor.credentialId === principal.credentialId
      && actor.credentialVersion === principal.credentialVersion && mcpScopesHash(actor.scopes ?? []) === principal.scopeHash,
  403, "AUTHORIZATION_CHANGED", "Conversation principal changed.");

  const persist = async (tx: Prisma.TransactionClient) => {
    await assertArtifactInputWriteFence(tx);
    await requireWorkspaceMembership({ actor, workspaceId, tx });
    assertPrincipal();
    if (principal.actorKind === "agent") {
      const credential = await tx.agentCredential.findFirst({ where: { id: principal.credentialId!, workspaceId, isActive: true },
        select: { tokenHash: true, scopes: true } });
      invariant(credential && mcpCredentialVersion(credential.tokenHash) === principal.credentialVersion
        && mcpScopesHash(credential.scopes) === principal.scopeHash && credential.scopes.includes("conversations:write"),
      403, "MCP_AUTHORIZATION_REVOKED", "Conversation credential authorization changed.");
    }
    await assertArtifactInputWriteFence(tx);
    assertPrincipal();
    const input = await tx.conversationIngressInput.create({ data: { workspaceId, ...principal, content } });
    // Native ingress is independently submitted input. Credential submissions are
    // never certified as HUMAN_ORIGINAL model output or guessed from tool arguments.
    await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationIngressInput", id: input.id, snapshot: input }], tx);
    await assertArtifactInputWriteFence(tx);
    assertPrincipal();
    return input;
  };
  return suppliedTx ? persist(suppliedTx) : prisma.$transaction(persist);
}
