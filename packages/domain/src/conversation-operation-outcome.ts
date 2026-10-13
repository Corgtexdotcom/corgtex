import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { requireToolLinkCredentialManager } from "./collaborative-permissions";
import { requireWorkspaceMembership } from "./auth";
import { captureConversationInputReceipt, validateConversationInputReceipt, type ConversationInputReceipt } from "./conversation-lineage";
import { invariant } from "./errors";
import { assertArtifactInputWriteFence, captureArtifactInputProof, isArtifactInputProofReadable,
  recordArtifactInputLineage, type LineageRoot } from "./source-lineage";

const OPERATION = "TOOL_LINK_ARCHIVED";
const REQUEST_KINDS = new Set(["ConversationIngressInput", "ConversationPromptInput", "McpToolInput"]);
const operationReceipts = new WeakMap<object, ConversationInputReceipt>();
export type ConversationToolLinkArchiveResult = { success: true; message: "The tool link was archived." };
export type ConversationToolLinkArchiveRequest = { workspaceId: string; toolLinkId: string; requestLineageRoots: readonly LineageRoot[] };

async function requestIdentity(actor: AppActor, params: ConversationToolLinkArchiveRequest, tx: Prisma.TransactionClient) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
  invariant(params.requestLineageRoots.length > 0 && await isArtifactInputProofReadable(actor, params.workspaceId, params.requestLineageRoots, tx),
    409, "SOURCE_CHANGED", "The original operation request is unavailable.");
  const identities = new Set<string>();
  for (const root of params.requestLineageRoots) {
    if (REQUEST_KINDS.has(root.kind)) identities.add(`${root.kind}:${root.id}:${root.fingerprint}`);
    else if (root.kind === "ArtifactInputSnapshot") {
      const snapshot = await tx.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId: params.workspaceId } });
      invariant(snapshot && REQUEST_KINDS.has(snapshot.sourceKind), 409, "UNKNOWN_LINEAGE", "Operation acknowledgment requires an independent native request.");
      identities.add(`${snapshot.sourceKind}:${snapshot.sourceId}:${snapshot.sourceFingerprint}`);
    } else invariant(false, 409, "UNKNOWN_LINEAGE", "Operation acknowledgment cannot depend on model context.");
  }
  const principal = actor.kind === "user" ? {
    actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null,
  } : {
    actorKind: "agent", userId: null, credentialId: actor.credentialId ?? null,
    credentialVersion: actor.credentialVersion ?? null, scopeHash: mcpScopesHash(actor.scopes ?? []),
  };
  if (actor.kind === "agent") {
    invariant(actor.authProvider === "credential" && principal.credentialId && principal.credentialVersion,
      403, "FORBIDDEN", "Operation acknowledgment requires an authenticated principal.");
    const credential = await tx.agentCredential.findFirst({ where: { id: principal.credentialId, workspaceId: params.workspaceId, isActive: true } });
    invariant(credential && mcpCredentialVersion(credential.tokenHash) === principal.credentialVersion
      && mcpScopesHash(credential.scopes) === principal.scopeHash && credential.scopes.includes("tools:write"),
    403, "MCP_AUTHORIZATION_REVOKED", "Operation principal authorization changed.");
  }
  const requestKey = createHash("sha256").update(JSON.stringify([params.workspaceId, principal, OPERATION,
    [...identities].sort(), params.toolLinkId])).digest("hex");
  return { principal, requestKey };
}

async function bindOutcome(actor: AppActor, workspaceId: string, outcomeId: string, tx: Prisma.TransactionClient) {
  const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationOperationOutcome", id: outcomeId }], tx);
  const value: ConversationToolLinkArchiveResult = { success: true, message: "The tool link was archived." };
  operationReceipts.set(value, await captureConversationInputReceipt({ actor, workspaceId, value, trustedRoots: roots, db: tx }));
  return value;
}

/** A current exact replay reads the committed operational fact without re-reading archived body context. */
export async function findConversationToolLinkArchiveOutcome(actor: AppActor, params: ConversationToolLinkArchiveRequest,
  tx: Prisma.TransactionClient): Promise<ConversationToolLinkArchiveResult | null> {
  const { requestKey } = await requestIdentity(actor, params, tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation-operation:${params.workspaceId}:${requestKey}`}, 0))`;
  const row = await tx.conversationOperationOutcome.findFirst({ where: { workspaceId: params.workspaceId, requestKey } });
  return row ? bindOutcome(actor, params.workspaceId, row.id, tx) : null;
}

/** Internal writer: the actual archive and this exact native fact commit in the caller's transaction. */
export async function recordConversationToolLinkArchiveOutcome(actor: AppActor, params: ConversationToolLinkArchiveRequest,
  tx: Prisma.TransactionClient): Promise<ConversationToolLinkArchiveResult> {
  await assertArtifactInputWriteFence(tx);
  const { principal, requestKey } = await requestIdentity(actor, params, tx);
  const archived = await tx.workspaceToolLink.findFirst({ where: { id: params.toolLinkId, workspaceId: params.workspaceId, archivedAt: { not: null } },
    select: { id: true, archivedAt: true, createdByUserId: true } });
  invariant(archived?.archivedAt, 409, "OPERATION_NOT_COMMITTED", "The operation has not completed.");
  const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
  requireToolLinkCredentialManager(actor, membership, archived);
  const row = await tx.conversationOperationOutcome.create({ data: {
    workspaceId: params.workspaceId, ...principal, operation: OPERATION, requestKey, requiredScopes: ["tools:write"],
  } });
  await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "ConversationOperationOutcome", id: row.id }, content: row,
    origin: "DERIVED", inputs: [], inheritedRoots: [...params.requestLineageRoots] });
  await assertArtifactInputWriteFence(tx);
  return bindOutcome(actor, params.workspaceId, row.id, tx);
}

/** Only the exact server-created constant result can retrieve this receipt. */
export function getConversationOperationOutcomeInputReceipt(value: unknown) {
  return value !== null && typeof value === "object" ? operationReceipts.get(value) : undefined;
}
export async function getConversationOperationOutcomeInputRoots(actor: AppActor, workspaceId: string, value: object) {
  const receipt = operationReceipts.get(value);
  invariant(receipt, 409, "UNKNOWN_LINEAGE", "Operation acknowledgment has no committed native proof.");
  return validateConversationInputReceipt({ actor, workspaceId, value, receipt });
}

/** Read-only process entry used for retries before any model-derived driver can be consulted. */
export async function readConversationToolLinkArchiveOutcome(actor: AppActor, params: ConversationToolLinkArchiveRequest) {
  const value = await prisma.$transaction((tx) => findConversationToolLinkArchiveOutcome(actor, params, tx));
  if (value) await getConversationOperationOutcomeInputRoots(actor, params.workspaceId, value);
  return value;
}
