import { isDeepStrictEqual } from "node:util";
import { Prisma, type Action } from "@prisma/client";
import { decryptSecret, type AppActor } from "@corgtex/shared";
import { humanMemberIdentityWhere } from "./member-identity";
import { requireWorkspaceOperation } from "./agent-operation-authorization";
import { invariant } from "./errors";
import { getMcpToolInputRoots, mcpToolInputActorIdentity } from "./mcp-tool-input-context";
import { isMcpToolInputEncryptedPayload } from "./mcp-tool-input-cipher";
import { assertArtifactInputWriteFence, currentArtifactInputRoots, isArtifactInputProofReadable,
  lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs, parsePermissionEpochProof,
  type PermissionEpochProof } from "./source-permission-epochs";
import { isArtifactInputPermissionEpochCoverageComplete } from "./source-permission-coverage";

export type ActionCompletionRequest = Readonly<{ workspaceId: string; actionId: string; completedVia: string }>;
export type ActionCompletionLineageReceipt = Readonly<{ purpose: "ACTION_COMPLETION" }>;
const receipts = new WeakMap<ActionCompletionLineageReceipt, { tx: Prisma.TransactionClient; actor: AppActor; actorIdentity: string;
  params: ActionCompletionRequest; before: Action; snapshotRoot: LineageRoot; oldRoots: LineageRoot[];
  oldProof: PermissionEpochProof | null; nativeRoot: LineageRoot; revision: number; known: boolean }>();

/** Returns only the immutable pre-completion Action revision captured by this
 * exact transaction and authenticated principal. The receipt remains opaque. */
export function actionCompletionPublicationContext(actor: AppActor, params: ActionCompletionRequest,
  receipt: ActionCompletionLineageReceipt, tx: Prisma.TransactionClient): {oldSnapshot: LineageRoot; revision: number} {
  const state = receipts.get(receipt);
  invariant(state && state.tx === tx && state.actor === actor && state.actorIdentity === mcpToolInputActorIdentity(actor)
    && isDeepStrictEqual(state.params, params), 409, "UNKNOWN_LINEAGE", "Action completion receipt is unavailable.");
  return {oldSnapshot: {...state.snapshotRoot}, revision: state.revision};
}

/** Only the current trusted TLS tool submission may drive this control operation. */
export async function assertActionCompletionNativeRequest(actor: AppActor, params: ActionCompletionRequest, tx: Prisma.TransactionClient) {
  await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "complete_action", tx });
  const root = getMcpToolInputRoots(actor, params.workspaceId).filter(input => input.kind === "McpToolInput").at(-1);
  invariant(root, 401, "AUTH_REQUIRED", "Action completion requires its authenticated native tool request.");
  const input = await tx.mcpToolInput.findFirst({where: {id: root.id, workspaceId: params.workspaceId}});
  invariant(input && input.toolName === "complete_action" && input.requiredScopes.length === 1 && input.requiredScopes[0] === "actions:write"
    && isMcpToolInputEncryptedPayload(input.argumentsJson)
    && lineageContentFingerprint("McpToolInput", input) === root.fingerprint,
  409, "UNKNOWN_LINEAGE", "Action completion has no exact native request.");
  let submitted: unknown;
  try { submitted = JSON.parse(decryptSecret(input.argumentsJson as string)); } catch { submitted = null; }
  invariant(submitted !== null && typeof submitted === "object" && !Array.isArray(submitted)
    && Object.keys(submitted).length === 2
    && "actionId" in submitted && submitted.actionId === params.actionId
    && "completedVia" in submitted && submitted.completedVia === params.completedVia,
  409, "UNKNOWN_LINEAGE", "Action completion does not match its original submitted arguments.");
  invariant(parsePermissionEpochProof(root.permissionEpochs)
    && await isArtifactInputProofReadable(actor, params.workspaceId, [root], tx),
  409, "SOURCE_CHANGED", "Action completion request authorization changed.");
  return root;
}

/** Internal control-purpose preservation; no old body is admitted to a read/model capture. */
export async function prepareActionCompletionLineage(actor: AppActor, params: ActionCompletionRequest,
  before: Action, tx: Prisma.TransactionClient): Promise<ActionCompletionLineageReceipt> {
  params = Object.freeze({...params});
  before = structuredClone(before);
  await assertArtifactInputWriteFence(tx);
  const nativeRoot = await assertActionCompletionNativeRequest(actor, params, tx);
  await tx.$queryRaw`SELECT id FROM "Action" WHERE id = ${params.actionId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const current = await tx.action.findFirst({where: {id: params.actionId, workspaceId: params.workspaceId,
    isPrivate: false, archivedAt: null, duplicateOfActionId: null, status: {in: ["OPEN", "IN_PROGRESS"]}}});
  invariant(current && isDeepStrictEqual(current, before), 409, "SOURCE_CHANGED", "Action completion source changed.");
  invariant(before.assigneeMemberId && await tx.member.findFirst({where: {id: before.assigneeMemberId,
    workspaceId: params.workspaceId, isActive: true, ...humanMemberIdentityWhere()}, select: {id: true}}),
  400, "INVALID_INPUT", "An active human assignee is required.");
  invariant(before.id === params.actionId && before.workspaceId === params.workspaceId && !before.isPrivate && !before.archivedAt
    && !before.duplicateOfActionId && ["OPEN", "IN_PROGRESS"].includes(before.status),
  409, "INVALID_STATE", "Action completion control changed.");
  const fingerprint = lineageContentFingerprint("Action", before);
  const manifest = await tx.artifactInputLineage.findFirst({where: {workspaceId: params.workspaceId, artifactType: "Action", artifactId: before.id},
    orderBy: {revision: "desc"}});
  const oldRoots = await currentArtifactInputRoots(tx, params.workspaceId, {kind: "Action", id: before.id}, before);
  const structural = manifest?.contentHash === fingerprint && oldRoots !== null
    && Array.isArray(manifest.inputsJson)
    && ((manifest.origin === "HUMAN_ORIGINAL" && oldRoots.length === 0 && manifest.inputsJson.length === 0)
      || (manifest.origin === "DERIVED" && oldRoots.length > 0));
  const oldProof = structural && manifest.epochProofVersion === 1 ? parsePermissionEpochProof(manifest.permissionEpochsJson) : null;
  const completeOldProof = Boolean(oldProof && await isArtifactInputPermissionEpochCoverageComplete({
    workspaceId: params.workspaceId, artifact: {kind: "Action", id: before.id}, content: before,
    roots: oldRoots ?? [], permissionEpochs: oldProof, db: tx,
  }));
  const snapshot = await tx.artifactInputSnapshot.create({data: {
    workspaceId: params.workspaceId, sourceKind: "Action", sourceId: before.id, sourceFingerprint: fingerprint,
    origin: structural && completeOldProof ? manifest.origin : "UNKNOWN", contentJson: JSON.parse(JSON.stringify(before)),
    accessEnvelopeJson: {isPrivate: before.isPrivate, authorUserId: before.authorUserId, status: before.status,
      archivedAt: null, ownerMemberId: null,
      ...(structural && completeOldProof && manifest.origin === "HUMAN_ORIGINAL"
        ? {humanOriginalManifestId: manifest.id, humanOriginalManifestRevision: manifest.revision} : {})},
    rootsJson: manifest?.rootsJson != null ? manifest.rootsJson as Prisma.InputJsonValue : manifest ? Prisma.JsonNull : [],
    epochProofVersion: manifest?.epochProofVersion ?? null,
    permissionEpochsJson: manifest?.permissionEpochsJson != null ? manifest.permissionEpochsJson as Prisma.InputJsonValue : Prisma.DbNull,
  }});
  const receipt = Object.freeze({purpose: "ACTION_COMPLETION" as const});
  receipts.set(receipt, {tx, actor, actorIdentity: mcpToolInputActorIdentity(actor), params, before: structuredClone(before),
    snapshotRoot: {kind: "ArtifactInputSnapshot", id: snapshot.id, fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot)},
    oldRoots: oldRoots ?? [], oldProof, nativeRoot, revision: (manifest?.revision ?? 0) + 1,
    known: Boolean(completeOldProof && oldProof && await isArtifactPermissionEpochProofCurrent(params.workspaceId, oldProof, tx))});
  return receipt;
}

export async function finishActionCompletionLineage(actor: AppActor, params: ActionCompletionRequest,
  receipt: ActionCompletionLineageReceipt, after: Action, tx: Prisma.TransactionClient, publicNoteRoot: LineageRoot) {
  params = Object.freeze({...params});
  after = structuredClone(after);
  const state = receipts.get(receipt);
  invariant(state && state.tx === tx && state.actor === actor && state.actorIdentity === mcpToolInputActorIdentity(actor)
    && isDeepStrictEqual(state.params, params), 409, "UNKNOWN_LINEAGE", "Action completion receipt is unavailable.");
  receipts.delete(receipt);
  await assertArtifactInputWriteFence(tx);
  await assertActionCompletionNativeRequest(actor, params, tx);
  const current = await tx.action.findFirst({where: {id: params.actionId, workspaceId: params.workspaceId}});
  invariant(current && isDeepStrictEqual(current, after), 409, "SOURCE_CHANGED", "Action completion output changed.");
  const changes = [...new Set([...Object.keys(state.before), ...Object.keys(after)])]
    .filter(field => !isDeepStrictEqual(state.before[field as keyof Action], after[field as keyof Action]));
  invariant(changes.every(field => ["status", "completedVia", "updatedAt"].includes(field))
    && after.status === "COMPLETED" && after.completedVia === params.completedVia.trim(),
  409, "SOURCE_CHANGED", "Action completion cannot change source content or permissions.");
  const note = publicNoteRoot.kind === "ConversationOperationOutcome"
    ? await tx.conversationOperationOutcome.findFirst({where: {id: publicNoteRoot.id, workspaceId: params.workspaceId}}) : null;
  const control = note?.controlJson as Record<string, unknown> | null | undefined;
  invariant(note?.operation === "ACTION_COMPLETION_PUBLIC_NOTE" && note.actorKind === "public"
    && lineageContentFingerprint("ConversationOperationOutcome", note) === publicNoteRoot.fingerprint
    && control?.actionId === after.id && control.actionVersion === after.version
    && control.inputId === state.nativeRoot.id && control.inputFingerprint === state.nativeRoot.fingerprint
    && control.oldActionSnapshotId === state.snapshotRoot.id
    && control.oldActionSnapshotFingerprint === state.snapshotRoot.fingerprint
    && control.publishedActionRevision === state.revision
    && control.completedActionFingerprint === lineageContentFingerprint("Action", after)
    && control.completedVia === after.completedVia && control.publicationPolicyVersion === 1
    && control.audience === "ACTION_READERS" && parsePermissionEpochProof(publicNoteRoot.permissionEpochs)
    && await isArtifactPermissionEpochProofCurrent(params.workspaceId,
      parsePermissionEpochProof(publicNoteRoot.permissionEpochs)!, tx),
  409, "SOURCE_CHANGED", "Action completion public note changed.");
  let proof: PermissionEpochProof | undefined;
  let known = state.known && state.oldProof !== null
    && await isArtifactPermissionEpochProofCurrent(params.workspaceId, state.oldProof, tx);
  if (known) {
    try { proof = mergePermissionEpochProofs(state.oldProof!, publicNoteRoot.permissionEpochs); }
    catch { known = false; }
  }
  await tx.artifactInputLineage.create({data: {
    workspaceId: params.workspaceId, artifactType: "Action", artifactId: after.id, revision: state.revision,
    origin: known ? "DERIVED" : "UNKNOWN", contentHash: lineageContentFingerprint("Action", after), inputsJson: [],
    rootsJson: known ? [state.snapshotRoot, ...state.oldRoots, publicNoteRoot] as unknown as Prisma.InputJsonValue : [],
    epochProofVersion: known ? 1 : null, permissionEpochsJson: known && proof ? proof as unknown as Prisma.InputJsonValue : Prisma.DbNull,
  }});
  await assertArtifactInputWriteFence(tx);
}
