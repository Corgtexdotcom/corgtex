import { createHash } from "node:crypto";
import { Prisma, type ConversationOperationOutcome } from "@prisma/client";
import { assertMcpOriginActive, getMcpOrigin, mcpScopesHash, mcpCredentialVersion, decryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { isMcpToolInputEncryptedPayload } from "./mcp-tool-input-cipher";
import { requireWorkspaceMembership } from "./auth";
import { requireWorkspaceOperation } from "./agent-operation-authorization";
import { appendEvents } from "./events";
import { recordAudit } from "./audit-trail";
import { invariant } from "./errors";
import { humanMemberIdentityWhere } from "./member-identity";
import { acquireWorkItemAdvisoryLock } from "./work-item-versions";
import { captureConversationInputReceipt, validateConversationInputReceipt, type ConversationInputReceipt } from "./conversation-lineage";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactPermissionEpochs, isArtifactInputProofReadable,
  lineageContentFingerprint,
  sealArtifactInputActor, type LineageRoot } from "./source-lineage";
import { assertActionCompletionNativeRequest, prepareActionCompletionLineage, finishActionCompletionLineage,
  actionCompletionPublicationContext,
  type ActionCompletionRequest } from "./action-completion-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  parsePermissionEpochProof } from "./source-permission-epochs";
import { isArtifactInputPermissionEpochCoverageComplete } from "./source-permission-coverage";

export type ActionCompletionResult = Readonly<{ id: string; status: "COMPLETED" }>;
export const ACTION_COMPLETION_PUBLIC_NOTE = "ACTION_COMPLETION_PUBLIC_NOTE";
const resultReceipts = new WeakMap<object, ConversationInputReceipt>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadataSelect = {id: true, workspaceId: true, isPrivate: true, archivedAt: true, duplicateOfActionId: true,
  status: true, assigneeMemberId: true, version: true, updatedAt: true, completedVia: true} as const;
type Control = {version: 1; actionId: string; actionVersion: number; completedAt: string; assigneeMemberId: string;
  completedViaHash: string; controlHash: string; inputId: string; inputFingerprint: string};
type PublicNoteControl = Control & {completedVia: string; publicationPolicyVersion: 1; audience: "ACTION_READERS";
  oldActionSnapshotId: string; oldActionSnapshotFingerprint: string;
  publishedActionRevision: number; completedActionFingerprint: string};
function storedRoot(value: unknown): value is {kind: string; id: string; fingerprint: string} {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "kind" in value && typeof value.kind === "string"
    && "id" in value && typeof value.id === "string"
    && "fingerprint" in value && typeof value.fingerprint === "string";
}
function controlHash(row: {id: string; workspaceId: string; isPrivate: boolean; archivedAt: Date | null; duplicateOfActionId: string | null;
  status: string; assigneeMemberId: string | null; version: number; updatedAt: Date; completedVia: string | null}) {
  return hash([row.id, row.workspaceId, row.isPrivate, row.archivedAt, row.duplicateOfActionId,
    row.status, row.assigneeMemberId, row.version, row.updatedAt, hash(row.completedVia)]);
}

async function assertPrincipalCommand(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient) {
  const origin = getMcpOrigin();
  invariant(origin, 401, "AUTH_REQUIRED", "Action completion requires an authenticated tool invocation.");
  await assertMcpOriginActive(tx, {...origin, requiredScopes: ["actions:write"]}, workspaceId);
  await requireWorkspaceOperation({actor, workspaceId, operation: "complete_action", tx});
}

/** Native control metadata only; this guard never selects title/body or relaxes Action read grants. */
export async function isActionCompletionOutcomeReadable(actor: AppActor, workspaceId: string,
  outcome: ConversationOperationOutcome, tx: Prisma.TransactionClient = prisma) {
  try {
    const origin = getMcpOrigin();
    if (origin) {
      await assertMcpOriginActive(tx, {...origin, requiredScopes: ["actions:write"]}, workspaceId);
      if (origin.kind === "oauth") {
        if (actor.kind !== "user") return false;
        const token = await tx.mcpOAuthAccessToken.findUnique({where: {id: origin.id}});
        if (token?.userId !== actor.user.id) return false;
      } else if (actor.kind !== "agent" || actor.credentialId !== origin.id) return false;
    }
    await requireWorkspaceOperation({actor, workspaceId, operation: "complete_action", tx});
    if (actor.kind === "agent") {
      if (actor.authProvider !== "credential" || !actor.credentialId || !actor.credentialVersion) return false;
      const credential = await tx.agentCredential.findFirst({where: {id: actor.credentialId, workspaceId, isActive: true}});
      if (!credential || mcpCredentialVersion(credential.tokenHash) !== actor.credentialVersion
        || mcpScopesHash(credential.scopes) !== mcpScopesHash(actor.scopes ?? []) || !credential.scopes.includes("actions:write")) return false;
    }
    if (outcome.workspaceId !== workspaceId || outcome.operation !== "ACTION_COMPLETED"
      || outcome.requiredScopes.length !== 1 || outcome.requiredScopes[0] !== "actions:write") return false;
    const control = (outcome as ConversationOperationOutcome & {controlJson?: unknown}).controlJson as Control | undefined;
    if (!control || control.version !== 1 || Object.keys(control).length !== 9 || typeof control.actionId !== "string"
      || !Number.isInteger(control.actionVersion) || control.actionVersion <= 0 || typeof control.completedAt !== "string"
      || typeof control.assigneeMemberId !== "string" || ![control.completedViaHash, control.controlHash, control.inputFingerprint]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || typeof control.inputId !== "string") return false;
    const row = await tx.action.findFirst({where: {id: control.actionId, workspaceId}, select: metadataSelect});
    if (!row || row.isPrivate || row.archivedAt || row.duplicateOfActionId || row.status !== "COMPLETED"
      || row.assigneeMemberId !== control.assigneeMemberId || row.version !== control.actionVersion
      || row.updatedAt.toISOString() !== control.completedAt || hash(row.completedVia) !== control.completedViaHash
      || controlHash(row) !== control.controlHash) return false;
    if (!await tx.member.findFirst({where: {id: control.assigneeMemberId, workspaceId, isActive: true, ...humanMemberIdentityWhere()}, select: {id: true}})) return false;
    const input = await tx.mcpToolInput.findFirst({where: {id: control.inputId, workspaceId}});
    if (!input || input.toolName !== "complete_action" || input.requiredScopes.length !== 1 || input.requiredScopes[0] !== "actions:write"
      || !isMcpToolInputEncryptedPayload(input.argumentsJson)
      || lineageContentFingerprint("McpToolInput", input) !== control.inputFingerprint) return false;
    let submitted: unknown;
    try { submitted = JSON.parse(decryptSecret(input.argumentsJson as string)); } catch { return false; }
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) || Object.keys(submitted).length !== 2
      || !("actionId" in submitted) || submitted.actionId !== row.id || !("completedVia" in submitted)
      || typeof submitted.completedVia !== "string" || hash(submitted.completedVia.trim()) !== control.completedViaHash) return false;
    const principal = actor.kind === "user" ? {actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null}
      : {actorKind: "agent", userId: null, credentialId: actor.credentialId ?? null, credentialVersion: actor.credentialVersion ?? null, scopeHash: mcpScopesHash(actor.scopes ?? [])};
    if (Object.entries(principal).some(([key, value]) => outcome[key as keyof ConversationOperationOutcome] !== value
      || input[key as keyof typeof input] !== value)) return false;
    return outcome.requestKey === hash([workspaceId, principal, "ACTION_COMPLETED", control.inputId, control.inputFingerprint, control.actionId]);
  } catch { return false; }
}

/** A separate, deliberately published native projection. It verifies the exact
 * encrypted command server-side without granting readers its raw MCP root. */
export async function isActionCompletionPublicNoteReadable(actor: AppActor, workspaceId: string,
  outcome: ConversationOperationOutcome, tx: Prisma.TransactionClient = prisma) {
  try {
    await requireWorkspaceMembership({actor, workspaceId, tx});
    const origin = getMcpOrigin();
    if (origin) await assertMcpOriginActive(tx, origin, workspaceId);
    // The bound old Action snapshot below performs the existing Action source
    // read-family check (actions:read or brain:read) for this exact caller.
    if (outcome.workspaceId !== workspaceId || outcome.operation !== ACTION_COMPLETION_PUBLIC_NOTE
      || outcome.actorKind !== "public" || outcome.userId !== null || outcome.credentialId !== null
      || outcome.credentialVersion !== null || outcome.scopeHash !== null || outcome.requiredScopes.length !== 0) return false;
    const control = outcome.controlJson as PublicNoteControl | null;
    if (!control || control.version !== 1 || control.publicationPolicyVersion !== 1
      || control.audience !== "ACTION_READERS" || Object.keys(control).length !== 16
      || typeof control.actionId !== "string" || !Number.isInteger(control.actionVersion) || control.actionVersion <= 0
      || typeof control.completedAt !== "string" || typeof control.assigneeMemberId !== "string"
      || typeof control.completedVia !== "string" || control.completedVia.length === 0
      || typeof control.oldActionSnapshotId !== "string"
      || !Number.isInteger(control.publishedActionRevision) || control.publishedActionRevision <= 0
      || ![control.completedViaHash, control.controlHash, control.inputFingerprint,
        control.oldActionSnapshotFingerprint, control.completedActionFingerprint]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || typeof control.inputId !== "string") return false;
    if (outcome.requestKey !== hash([workspaceId, ACTION_COMPLETION_PUBLIC_NOTE, control.actionId,
      control.inputId, control.inputFingerprint, control.completedViaHash,
      control.oldActionSnapshotId, control.oldActionSnapshotFingerprint,
      control.publishedActionRevision, control.completedActionFingerprint])) return false;
    const noteManifest = await tx.artifactInputLineage.findFirst({where: {workspaceId,
      artifactType: "ConversationOperationOutcome", artifactId: outcome.id}, orderBy: {revision: "desc"}});
    const noteProof = parsePermissionEpochProof(noteManifest?.permissionEpochsJson);
    const expectedPolicyKeys = [["Action", control.actionId], ["ConversationOperationOutcome", outcome.id],
      ["Workspace", workspaceId]];
    if (!noteManifest || noteManifest.origin !== "NATIVE_ORIGINAL" || noteManifest.revision !== 1
      || noteManifest.contentHash !== lineageContentFingerprint("ConversationOperationOutcome", outcome)
      || !Array.isArray(noteManifest.inputsJson) || noteManifest.inputsJson.length !== 0
      || !Array.isArray(noteManifest.rootsJson) || noteManifest.rootsJson.length !== 0
      || !noteProof || JSON.stringify(noteProof.entries.map(entry => [entry.kind, entry.id])) !== JSON.stringify(expectedPolicyKeys)
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, noteProof, tx)) return false;
    const row = await tx.action.findFirst({where: {id: control.actionId, workspaceId}});
    if (!row || row.isPrivate || row.archivedAt || row.duplicateOfActionId
      || hash(control.completedVia) !== control.completedViaHash) return false;
    const input = await tx.mcpToolInput.findFirst({where: {id: control.inputId, workspaceId}});
    if (!input || input.toolName !== "complete_action" || input.requiredScopes.length !== 1
      || input.requiredScopes[0] !== "actions:write" || !isMcpToolInputEncryptedPayload(input.argumentsJson)
      || lineageContentFingerprint("McpToolInput", input) !== control.inputFingerprint) return false;
    let submitted: unknown;
    try { submitted = JSON.parse(decryptSecret(input.argumentsJson as string)); } catch { return false; }
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) || Object.keys(submitted).length !== 2
      || !("actionId" in submitted) || submitted.actionId !== row.id || !("completedVia" in submitted)
      || typeof submitted.completedVia !== "string" || submitted.completedVia.trim() !== control.completedVia) return false;
    const publishedManifest = await tx.artifactInputLineage.findFirst({where: {workspaceId, artifactType: "Action",
      artifactId: row.id, revision: control.publishedActionRevision}});
    if (!publishedManifest || publishedManifest.origin !== "DERIVED"
      || publishedManifest.contentHash !== control.completedActionFingerprint
      || !Array.isArray(publishedManifest.rootsJson)
      || !publishedManifest.rootsJson.some(root => storedRoot(root)
        && root.kind === "ConversationOperationOutcome" && root.id === outcome.id
        && root.fingerprint === lineageContentFingerprint("ConversationOperationOutcome", outcome))) return false;
    // The note is public only to readers of the pre-completion Action body.
    // Check its immutable snapshot directly to avoid recursing into this new
    // outcome via the current Action root.
    const oldSnapshot = publishedManifest.rootsJson.find(root => storedRoot(root) && root.kind === "ArtifactInputSnapshot"
      && root.id === control.oldActionSnapshotId && root.fingerprint === control.oldActionSnapshotFingerprint);
    if (!storedRoot(oldSnapshot)) return false;
    const snapshot = await tx.artifactInputSnapshot.findFirst({where: {id: oldSnapshot.id, workspaceId}});
    if (!snapshot || snapshot.sourceKind !== "Action" || snapshot.sourceId !== row.id
      || lineageContentFingerprint("ArtifactInputSnapshot", snapshot) !== oldSnapshot.fingerprint
      || !snapshot.contentJson || typeof snapshot.contentJson !== "object" || Array.isArray(snapshot.contentJson)
      || !Array.isArray(snapshot.rootsJson) || !snapshot.rootsJson.every(storedRoot)
      || !await isArtifactInputPermissionEpochCoverageComplete({workspaceId,
        artifact: {kind: "Action", id: row.id}, content: snapshot.contentJson as Record<string, unknown>,
        roots: snapshot.rootsJson as LineageRoot[], permissionEpochs: snapshot.permissionEpochsJson, db: tx})) return false;
    return isArtifactInputProofReadable(actor, workspaceId,
      [{kind: "ArtifactInputSnapshot", id: oldSnapshot.id, fingerprint: oldSnapshot.fingerprint}], tx);
  } catch { return false; }
}

async function recordPublicNote(params: ActionCompletionRequest,
  action: NonNullable<Awaited<ReturnType<typeof prisma.action.findFirst>>>, root: LineageRoot,
  oldSnapshot: LineageRoot, publishedActionRevision: number, tx: Prisma.TransactionClient) {
  const control: PublicNoteControl = {version: 1, publicationPolicyVersion: 1, audience: "ACTION_READERS",
    actionId: action.id, actionVersion: action.version,
    completedAt: action.updatedAt.toISOString(), assigneeMemberId: action.assigneeMemberId!,
    completedVia: action.completedVia!, completedViaHash: hash(action.completedVia), controlHash: controlHash(action),
    inputId: root.id, inputFingerprint: root.fingerprint,
    oldActionSnapshotId: oldSnapshot.id, oldActionSnapshotFingerprint: oldSnapshot.fingerprint,
    publishedActionRevision, completedActionFingerprint: lineageContentFingerprint("Action", action)};
  const outcome = await tx.conversationOperationOutcome.create({data: {
    workspaceId: params.workspaceId, actorKind: "public", userId: null, credentialId: null, credentialVersion: null,
    scopeHash: null, operation: ACTION_COMPLETION_PUBLIC_NOTE, requiredScopes: [],
    requestKey: hash([params.workspaceId, ACTION_COMPLETION_PUBLIC_NOTE, action.id, root.id, root.fingerprint,
      control.completedViaHash, control.oldActionSnapshotId, control.oldActionSnapshotFingerprint,
      control.publishedActionRevision, control.completedActionFingerprint]), controlJson: control,
  } as Prisma.ConversationOperationOutcomeUncheckedCreateInput});
  const publicRoot: LineageRoot = {kind: "ConversationOperationOutcome", id: outcome.id,
    fingerprint: lineageContentFingerprint("ConversationOperationOutcome", outcome)};
  // This is an explicit shared publication. Its standing revision belongs to
  // the note, Action and workspace, never the submitting user's private MCP
  // credential or OAuth consent. The private operation receipt keeps those.
  const epochs = await capturePermissionEpochs(tx, params.workspaceId,
    [{kind: "ConversationOperationOutcome", id: outcome.id}, {kind: "Action", id: action.id},
      {kind: "Workspace", id: params.workspaceId}]);
  await tx.artifactInputLineage.create({data: {workspaceId: params.workspaceId, artifactType: "ConversationOperationOutcome",
    artifactId: outcome.id, revision: 1, origin: "NATIVE_ORIGINAL", contentHash: publicRoot.fingerprint,
    inputsJson: [], rootsJson: [], epochProofVersion: 1,
    permissionEpochsJson: epochs as unknown as Prisma.InputJsonValue}});
  return {...publicRoot, permissionEpochs: epochs};
}

async function recordOutcome(actor: AppActor, params: ActionCompletionRequest,
  action: NonNullable<Awaited<ReturnType<typeof prisma.action.findFirst>>>, root: LineageRoot, tx: Prisma.TransactionClient) {
  const principal = actor.kind === "user" ? {actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null}
    : {actorKind: "agent", userId: null, credentialId: actor.credentialId!, credentialVersion: actor.credentialVersion!, scopeHash: mcpScopesHash(actor.scopes ?? [])};
  const control: Control = {version: 1, actionId: action.id, actionVersion: action.version, completedAt: action.updatedAt.toISOString(),
    assigneeMemberId: action.assigneeMemberId!, completedViaHash: hash(action.completedVia), controlHash: controlHash(action), inputId: root.id, inputFingerprint: root.fingerprint};
  const data = {workspaceId: params.workspaceId, ...principal, operation: "ACTION_COMPLETED", requiredScopes: ["actions:write"],
    requestKey: hash([params.workspaceId, principal, "ACTION_COMPLETED", root.id, root.fingerprint, action.id]), controlJson: control};
  const outcome = await tx.conversationOperationOutcome.create({data: data as Prisma.ConversationOperationOutcomeUncheckedCreateInput});
  const outcomeRoot: LineageRoot = {kind: "ConversationOperationOutcome", id: outcome.id, fingerprint: lineageContentFingerprint("ConversationOperationOutcome", outcome)};
  const epochs = await captureArtifactPermissionEpochs(actor, params.workspaceId, [outcomeRoot, root], tx);
  await tx.artifactInputLineage.create({data: {workspaceId: params.workspaceId, artifactType: "ConversationOperationOutcome", artifactId: outcome.id,
    revision: 1, origin: "NATIVE_ORIGINAL", contentHash: outcomeRoot.fingerprint, inputsJson: [], rootsJson: [],
    epochProofVersion: 1, permissionEpochsJson: epochs as unknown as Prisma.InputJsonValue}});
  const roots = await captureArtifactInputProof(actor, params.workspaceId, [{kind: "ConversationOperationOutcome", id: outcome.id}], tx);
  const result: ActionCompletionResult = Object.freeze({id: action.id, status: "COMPLETED"});
  resultReceipts.set(result, await captureConversationInputReceipt({actor, workspaceId: params.workspaceId, value: result, trustedRoots: roots, db: tx}));
  return result;
}

/** Dedicated status control: the old body is retained internally and is never returned or observed as a read. */
export async function completeActionWithNativeRequest(actor: AppActor, input: ActionCompletionRequest): Promise<ActionCompletionResult> {
  sealArtifactInputActor(actor);
  const params = Object.freeze({workspaceId: input.workspaceId, actionId: input.actionId, completedVia: input.completedVia});
  invariant(typeof params.actionId === "string" && params.actionId.trim().length > 0
    && typeof params.completedVia === "string" && params.completedVia.trim().length > 0,
  400, "INVALID_INPUT", "An action and completion note are required.");
  const result = await prisma.$transaction(async tx => {
    await assertArtifactInputWriteFence(tx);
    await assertPrincipalCommand(actor, params.workspaceId, tx);
    const root = await assertActionCompletionNativeRequest(actor, params, tx);
    await acquireWorkItemAdvisoryLock(tx, "Action", params.actionId);
    await tx.$queryRaw`SELECT id FROM "Action" WHERE id = ${params.actionId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const before = await tx.action.findFirst({where: {id: params.actionId, workspaceId: params.workspaceId,
      isPrivate: false, archivedAt: null, duplicateOfActionId: null, status: {in: ["OPEN", "IN_PROGRESS"]}}});
    invariant(before && !before.isPrivate && !before.archivedAt && !before.duplicateOfActionId && ["OPEN", "IN_PROGRESS"].includes(before.status),
      409, "INVALID_STATE", "Only an active public assigned Action can be completed.");
    invariant(before.assigneeMemberId, 400, "INVALID_INPUT", "An active human assignee is required.");
    await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${before.assigneeMemberId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    invariant(await tx.member.findFirst({where: {id: before.assigneeMemberId, workspaceId: params.workspaceId, isActive: true, ...humanMemberIdentityWhere()}, select: {id: true}}),
      400, "INVALID_INPUT", "An active human assignee is required.");
    const receipt = await prepareActionCompletionLineage(actor, params, before, tx);
    await assertArtifactInputWriteFence(tx);
    const updated = await tx.action.update({where: {id: before.id, workspaceId: params.workspaceId, status: before.status,
      isPrivate: false, archivedAt: null, version: before.version}, data: {status: "COMPLETED", completedVia: params.completedVia.trim()}});
    const publication = actionCompletionPublicationContext(actor, params, receipt, tx);
    const publicNoteRoot = await recordPublicNote(params, updated, root, publication.oldSnapshot, publication.revision, tx);
    await finishActionCompletionLineage(actor, params, receipt, updated, tx, publicNoteRoot);
    await recordAudit(tx, actor, {workspaceId: params.workspaceId, action: "action.completed", entityType: "Action", entityId: updated.id,
      meta: {fields: ["status", "completedVia"]}});
    await appendEvents(tx, [{workspaceId: params.workspaceId, type: "action.updated", aggregateType: "Action", aggregateId: updated.id,
      payload: {actionId: updated.id, fields: ["status", "completedVia"]}}]);
    await assertActionCompletionNativeRequest(actor, params, tx);
    await assertArtifactInputWriteFence(tx);
    return recordOutcome(actor, params, updated, root, tx);
  });
  await getActionCompletionOutcomeInputRoots(actor, params.workspaceId, result);
  return result;
}

export function getActionCompletionOutcomeInputReceipt(value: unknown) {
  return value !== null && typeof value === "object" ? resultReceipts.get(value) : undefined;
}
export async function getActionCompletionOutcomeInputRoots(actor: AppActor, workspaceId: string, value: object) {
  const receipt = resultReceipts.get(value);
  invariant(receipt, 409, "UNKNOWN_LINEAGE", "Completion acknowledgment is not a registered committed result.");
  return validateConversationInputReceipt({actor, workspaceId, value, receipt});
}
