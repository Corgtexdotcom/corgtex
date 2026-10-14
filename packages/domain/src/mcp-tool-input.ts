import { createHash } from "node:crypto";
import { assertMcpOriginActive, encryptSecret, getMcpOrigin, mcpCredentialVersion, mcpScopesHash, parseMcpOrigin, prisma,
  withMcpRequiredScopes, type AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { getConversationOperationOutcomeInputReceipt, getConversationOperationOutcomeInputRoots } from "./conversation-operation-outcome";
import { getMcpToolInputRoots, mcpToolInputActorIdentity, withMcpToolInputContext } from "./mcp-tool-input-context";
import { assertArtifactInputWriteFence, captureArtifactInputProof, isArtifactInputProofReadable, withArtifactInputReadCapture, type LineageRoot } from "./source-lineage";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

function submission<T>(args: T): { argumentsJson: string; args: T } {
  const seen = new Set<object>();
  const valid = (value: unknown): boolean => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => descriptor.get || descriptor.set)) return false;
    if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) return false;
    seen.add(value); const result = Object.values(value).every(valid); seen.delete(value); return result;
  };
  invariant(valid(args), 400, "INVALID_INPUT", "MCP tool arguments must be parsed JSON.");
  const argumentsJson = JSON.stringify(args);
  invariant(typeof argumentsJson === "string", 400, "INVALID_INPUT", "MCP tool arguments must be parsed JSON.");
  return { argumentsJson, args: freeze(JSON.parse(argumentsJson) as T) };
}

/** The sole terminal exception is an exact registered constant archive outcome
 * whose committed receipt includes this invocation's immutable submission.
 */
async function validateArchiveOutcome(actor: AppActor, workspaceId: string, value: unknown,
  ownInput: LineageRoot, args: unknown) {
  invariant(getConversationOperationOutcomeInputReceipt(value), 409, "UNKNOWN_LINEAGE", "Archive did not provide its committed native outcome receipt.");
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), 409, "UNKNOWN_LINEAGE", "Archive outcome is unavailable.");
  const proof = await getConversationOperationOutcomeInputRoots(actor, workspaceId, value);
  const outcomes = proof.filter(root => root.kind === "ConversationOperationOutcome");
  invariant(outcomes.length === 1, 409, "UNKNOWN_LINEAGE", "Archive outcome has no exact native operation proof.");
  const requestKinds = new Set(["McpToolInput", "ConversationIngressInput", "ConversationPromptInput"]);
  const identities = new Set<string>();
  let ownsSubmission = false;
  for (const root of proof) {
    if (root.kind === "ConversationOperationOutcome") continue;
    let identity = root;
    if (root.kind === "ArtifactInputSnapshot") {
      const snapshot = await prisma.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId } });
      invariant(snapshot && requestKinds.has(snapshot.sourceKind), 409, "UNKNOWN_LINEAGE", "Archive outcome depends on superseded model context.");
      identity = { kind: snapshot.sourceKind as LineageRoot["kind"], id: snapshot.sourceId, fingerprint: snapshot.sourceFingerprint };
    }
    invariant(requestKinds.has(identity.kind), 409, "UNKNOWN_LINEAGE", "Archive outcome depends on model context.");
    identities.add(`${identity.kind}:${identity.id}:${identity.fingerprint}`);
    if (identity.kind === ownInput.kind && identity.id === ownInput.id && identity.fingerprint === ownInput.fingerprint) ownsSubmission = true;
  }
  invariant(ownsSubmission, 409, "SOURCE_CHANGED", "Archive outcome belongs to a different submitted request.");
  invariant(args !== null && typeof args === "object" && "toolLinkId" in args && typeof args.toolLinkId === "string" && args.toolLinkId.length > 0,
    409, "UNKNOWN_LINEAGE", "Archive outcome has no exact requested operation identity.");
  const principal = actor.kind === "user" ? { actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null }
    : { actorKind: "agent", userId: null, credentialId: actor.credentialId ?? null, credentialVersion: actor.credentialVersion ?? null, scopeHash: mcpScopesHash(actor.scopes ?? []) };
  const requestKey = createHash("sha256").update(JSON.stringify([workspaceId, principal, "TOOL_LINK_ARCHIVED", [...identities].sort(), args.toolLinkId])).digest("hex");
  const outcome = await prisma.conversationOperationOutcome.findFirst({ where: { id: outcomes[0]!.id, workspaceId } });
  invariant(outcome?.operation === "TOOL_LINK_ARCHIVED" && outcome.requestKey === requestKey,
    409, "SOURCE_CHANGED", "Archive outcome does not match this operation request.");
  // Repeat after the additional identity lookups; only the registered constant
  // value is released. No consumed old body is returned or re-certified.
  await getConversationOperationOutcomeInputRoots(actor, workspaceId, value);
}

/** Bind a status-only result to this invocation's exact submitted command. */
async function validateActionCompletionOutcome(actor: AppActor, workspaceId: string, value: unknown,
  ownInput: LineageRoot, args: unknown) {
  const { getActionCompletionOutcomeInputReceipt, getActionCompletionOutcomeInputRoots } = await import("./action-completion");
  invariant(getActionCompletionOutcomeInputReceipt(value) && value !== null && typeof value === "object",
    409, "UNKNOWN_LINEAGE", "Completion has no registered native command result.");
  const roots = await getActionCompletionOutcomeInputRoots(actor, workspaceId, value as object);
  const outcomes = roots.filter(root => root.kind === "ConversationOperationOutcome");
  invariant(outcomes.length === 1 && args !== null && typeof args === "object" && "actionId" in args,
    409, "UNKNOWN_LINEAGE", "Completion has no exact command identity.");
  const outcome = await prisma.conversationOperationOutcome.findFirst({ where: { id: outcomes[0]!.id, workspaceId } });
  const control = outcome?.controlJson;
  invariant(outcome?.operation === "ACTION_COMPLETED" && control !== null && typeof control === "object" && !Array.isArray(control)
    && control.inputId === ownInput.id && control.inputFingerprint === ownInput.fingerprint && control.actionId === args.actionId,
  409, "SOURCE_CHANGED", "Completion belongs to a different submitted command.");
  await getActionCompletionOutcomeInputRoots(actor, workspaceId, value as object);
}

/** Capture the complete authenticated tool submission before invoking the trusted handler. */
export async function withMcpToolInput<TArgs, TResult>(actor: AppActor, params: { workspaceId: string; toolName: string; args: TArgs; requiredScopes: readonly string[] },
  work: (args: TArgs) => PromiseLike<TResult>): Promise<TResult> {
  const { workspaceId, toolName } = params;
  const actorIdentity = mcpToolInputActorIdentity(actor);
  const submitted = submission(params.args);
  invariant(Array.isArray(params.requiredScopes), 400, "INVALID_INPUT", "MCP tool submission needs its required scopes.");
  const requiredScopes = [...new Set(params.requiredScopes)].sort();
  invariant(typeof toolName === "string" && toolName.trim().length > 0 && requiredScopes.length > 0
    && requiredScopes.every((scope) => typeof scope === "string" && scope.trim().length > 0),
  400, "INVALID_INPUT", "MCP tool submission needs a name and its required scopes.");
  if (toolName === "archive_tool_link") invariant(requiredScopes.includes("tools:write"),
    403, "FORBIDDEN", "Archive requires its current tool write scope.");
  const ambient = getMcpOrigin();
  invariant(ambient, 401, "AUTH_REQUIRED", "MCP tool input requires an authenticated MCP origin.");
  const origin = parseMcpOrigin(ambient);
  const principal = actor.kind === "user" ? { actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null }
    : { actorKind: "agent", userId: null, credentialId: actor.credentialId, credentialVersion: actor.credentialVersion, scopeHash: mcpScopesHash(actor.scopes ?? []) };
  invariant(actor.kind === "user" ? origin.kind === "oauth" : actor.authProvider === "credential" && origin.kind === "agent"
    && principal.credentialId === origin.id && principal.credentialVersion === origin.credentialVersion && principal.scopeHash === origin.scopeHash
    && requiredScopes.every((scope) => actor.scopes?.includes(scope)),
  403, "MCP_AUTHORIZATION_REVOKED", "MCP tool principal authorization changed.");
  const inherited = getMcpToolInputRoots(actor, workspaceId);
  const { roots, ownInput } = await prisma.$transaction(async (tx) => withMcpRequiredScopes(tx, origin, requiredScopes, async () => {
    await assertArtifactInputWriteFence(tx);
    await requireWorkspaceMembership({ actor, workspaceId, tx });
    if (actor.kind === "user") {
      const token = await tx.mcpOAuthAccessToken.findFirst({ where: { id: origin.id, workspaceId, userId: principal.userId! } });
      invariant(token, 403, "MCP_AUTHORIZATION_REVOKED", "MCP tool principal authorization changed.");
    } else {
      const credential = await tx.agentCredential.findFirst({ where: { id: principal.credentialId!, workspaceId, isActive: true } });
      invariant(credential && mcpCredentialVersion(credential.tokenHash) === principal.credentialVersion
        && mcpScopesHash(credential.scopes) === principal.scopeHash && requiredScopes.every((scope) => credential.scopes.includes(scope)),
      403, "MCP_AUTHORIZATION_REVOKED", "MCP tool credential authorization changed.");
    }
    await assertArtifactInputWriteFence(tx);
    // The field holds an opaque AES-GCM envelope, including credential/token
    // arguments. Only this trusted invocation receives the frozen plaintext.
    const input = await tx.mcpToolInput.create({ data: { workspaceId, ...principal, toolName, argumentsJson: encryptSecret(submitted.argumentsJson), requiredScopes } });
    const proof = await captureArtifactInputProof(actor, workspaceId, [{ kind: "McpToolInput", id: input.id, snapshot: input }], tx);
    await assertMcpOriginActive(tx, { ...origin, requiredScopes }, workspaceId);
    await assertArtifactInputWriteFence(tx);
    const ownInput = proof.find(root => root.kind === "McpToolInput" && root.id === input.id);
    invariant(ownInput, 409, "UNKNOWN_LINEAGE", "The submitted tool input has no native identity.");
    return { roots: [...inherited, ...proof], ownInput };
  }));
  return withMcpRequiredScopes(prisma as Prisma.TransactionClient, origin, requiredScopes, () =>
    withMcpToolInputContext(actor, workspaceId, roots, async () => {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, getMcpToolInputRoots(actor, workspaceId)),
        409, "SOURCE_CHANGED", "MCP tool inputs changed before execution.");
      let terminalValue: TResult | undefined;
      let terminalReady = false;
      let value: TResult;
      try {
        const captured = await withArtifactInputReadCapture(actor, workspaceId, async () => {
          await captureArtifactInputProof(actor, workspaceId, roots.map((root) => ({ kind: root.kind, id: root.id })));
          const result = await work(submitted.args);
          if (toolName === "complete_action") await validateActionCompletionOutcome(actor, workspaceId, result, ownInput, submitted.args);
          if (toolName === "archive_tool_link" && getConversationOperationOutcomeInputReceipt(result)) {
            await validateArchiveOutcome(actor, workspaceId, result, ownInput, submitted.args);
            terminalValue = result;
            terminalReady = true;
          }
          return result;
        }, { preserveConsumedRevisions: true });
        value = captured.value;
      } catch (error) {
        // A handler throw, canceled work, unregistered result, or wrong request
        // never enters this path. The exact committed native fact is the only
        // exception to the superseded body/context read scope after success.
        if (!terminalReady || !(error instanceof AppError)
          || !["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
        await validateArchiveOutcome(actor, workspaceId, terminalValue, ownInput, submitted.args);
        value = terminalValue as TResult;
      }
      if (terminalReady) await validateArchiveOutcome(actor, workspaceId, value, ownInput, submitted.args);
      if (toolName === "complete_action") await validateActionCompletionOutcome(actor, workspaceId, value, ownInput, submitted.args);
      const currentRoots = getMcpToolInputRoots(actor, workspaceId);
      await requireWorkspaceMembership({ actor, workspaceId });
      invariant(await isArtifactInputProofReadable(actor, workspaceId, currentRoots),
        409, "SOURCE_CHANGED", "MCP tool input permissions changed before its result could be returned.");
      return value;
    }, actorIdentity));
}
