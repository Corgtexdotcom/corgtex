import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, mcpCredentialVersion, mcpScopesHash, getSupportAuthorizationContext, type AppActor } from "@corgtex/shared";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { canReadInformationCategory } from "./information-category-policy";
import { artifactPermissionParents } from "./source-permission-parents";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, captureArtifactPermissionEpochs, isArtifactInputProofReadable,
  captureArtifactReadHeadObservation, withArtifactCountReleaseSnapshot,
  lineageContentFingerprint, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof, type PermissionEpochProof } from "./source-permission-epochs";
import { withCompanyLegacyRecoveryCapture } from "./legacy-recovery-context";
import { inspectSourceLineageBackfill } from "./source-lineage-backfill";

export const LEGACY_RECOVERY_OPERATION = "LEGACY_RECOVERY_PUBLICATION";
export const LEGACY_RECOVERY_KINDS = ["Action", "Goal", "GoalUpdate", "KeyResult", "ConversationSession", "ConversationTurn", "Document", "BrainSource", "Role", "Circle"] as const;
export type LegacyRecoveryKind = typeof LEGACY_RECOVERY_KINDS[number];
type Row = Record<string, unknown> & { id: string };
type Db = Prisma.TransactionClient;
type Selection = { workspaceId: string; kind: LegacyRecoveryKind; id: string };
type ByteBinding = { storageKey: string; sha256: string; sizeBytes: number };
type Capsule = { version: 1; workspaceId: string; userId: string; targetKind: LegacyRecoveryKind; targetId: string;
  targetFingerprint: string; targetManifestId: string; requestHash: string; basis: "EXISTING_EVIDENCE" | "CURRENT_ATTESTATION"; content: Row;
  audience: "COMPANY" | "OWNER"; operationEpochs: PermissionEpochProof; epochs: PermissionEpochProof; roots: LineageRoot[]; file: ByteBinding | null };
const pending = new AsyncLocalStorage<{ actor: AppActor; tx: Db; receiptId: string; active: boolean }>();
// Distinct roots do not bound work: revisions and creation sources may repeat
// the same evidence or contain none. Each history must be exhausted, not sampled.
const RECOVERY_EVIDENCE_CANDIDATES = 5000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const isLegacyRecoveryKind = (kind: unknown): kind is LegacyRecoveryKind => LEGACY_RECOVERY_KINDS.includes(kind as LegacyRecoveryKind);

async function load(db: Db, selection: Selection): Promise<Row | null> {
  const where = { id: selection.id, workspaceId: selection.workspaceId };
  switch (selection.kind) {
    case "Action": return db.action.findFirst({ where });
    case "Goal": return db.goal.findFirst({ where });
    case "GoalUpdate": return db.goalUpdate.findFirst({ where: { id: selection.id, goal: { workspaceId: selection.workspaceId } } });
    case "KeyResult": return db.keyResult.findFirst({ where: { id: selection.id, goal: { workspaceId: selection.workspaceId } } });
    case "Role": return db.role.findFirst({ where: { id: selection.id, circle: { workspaceId: selection.workspaceId } } });
    case "Circle": return db.circle.findFirst({ where });
    case "Document": return db.document.findFirst({ where });
    case "BrainSource": return db.brainSource.findFirst({ where });
    case "ConversationSession": return db.conversationSession.findFirst({ where });
    case "ConversationTurn": return db.conversationTurn.findFirst({ where: { id: selection.id, conversation: { workspaceId: selection.workspaceId } } });
  }
}

/** This is only the closed recovery target's existing audience, not a general
 * artifact read bypass. Normal lineage is required everywhere outside recovery. */
async function targetAudience(actor: AppActor, selection: Selection, row: Row, db: Db): Promise<boolean> {
  if (row.archivedAt != null || row.accessDomain === "FINANCE") return false;
  if (selection.kind === "GoalUpdate" || selection.kind === "KeyResult") {
    const parent = await db.goal.findFirst({ where: { id: String(row.goalId), workspaceId: selection.workspaceId } });
    return Boolean(parent && await targetAudience(actor, { ...selection, kind: "Goal", id: parent.id }, parent, db));
  }
  if (actor.kind === "agent") {
    if (actor.authProvider !== "credential" || !actor.credentialId || !actor.credentialVersion
      || !actor.workspaceIds?.includes(selection.workspaceId) || selection.kind.startsWith("Conversation") || row.isPrivate === true) return false;
    const credential = await db.agentCredential.findFirst({where:{id:actor.credentialId,workspaceId:selection.workspaceId,isActive:true}});
    const scopes = selection.kind === "Role" || selection.kind === "Circle" ? ["circles:read"]
      : selection.kind === "Action" ? ["actions:read", "brain:read"]
        : selection.kind === "Goal" ? ["goals:read", "brain:read"] : ["brain:read"];
    if (!credential || mcpCredentialVersion(credential.tokenHash) !== actor.credentialVersion
      || mcpScopesHash(credential.scopes) !== mcpScopesHash(actor.scopes ?? []) || !scopes.some(scope=>credential.scopes.includes(scope))) return false;
    if (selection.kind === "Role") return Boolean(await db.circle.findFirst({ where: { id: String(row.circleId), workspaceId: selection.workspaceId, archivedAt: null } }));
    return selection.kind === "Circle" || selection.kind === "Action" || selection.kind === "Goal" || row.accessDomain === "WORKSPACE" && typeof row.informationCategory === "string"
      && await canReadInformationCategory(actor,selection.workspaceId,row.informationCategory,db);
  }
  const member = await db.member.findFirst({ where: { workspaceId: selection.workspaceId, userId: actor.user.id, isActive: true } });
  if (!member) return false;
  if (selection.kind === "Role") return Boolean(await db.circle.findFirst({ where: { id: String(row.circleId), workspaceId: selection.workspaceId, archivedAt: null } }));
  if (selection.kind === "Circle") return true;
  if (selection.kind === "ConversationSession") return row.userId === actor.user.id;
  if (selection.kind === "ConversationTurn") return Boolean(await db.conversationSession.findFirst({ where: {
    id: String(row.conversationId), workspaceId: selection.workspaceId, userId: actor.user.id } }));
  if (selection.kind === "Action" || selection.kind === "Goal") return row.isPrivate !== true || row.authorUserId === actor.user.id && row.status === "DRAFT";
  return row.accessDomain === "WORKSPACE" && typeof row.informationCategory === "string"
    && await canReadInformationCategory(actor, selection.workspaceId, row.informationCategory, db);
}

export function decodeLegacyRecovery(row: Record<string, unknown>): Capsule | null {
  try {
    if (row.operation !== LEGACY_RECOVERY_OPERATION || !record(row.controlJson) || row.controlJson.version !== 1
      || typeof row.controlJson.encryptedPayloadJson !== "string") return null;
    const value: unknown = JSON.parse(decryptSecret(row.controlJson.encryptedPayloadJson));
    if (!record(value) || value.version !== 1 || !isLegacyRecoveryKind(value.targetKind) || typeof value.workspaceId !== "string"
      || typeof value.targetId !== "string" || typeof value.userId !== "string" || typeof value.targetManifestId !== "string"
      || typeof value.targetFingerprint !== "string" || typeof value.requestHash !== "string" || !["EXISTING_EVIDENCE", "CURRENT_ATTESTATION"].includes(String(value.basis)) || !record(value.content)
      || value.content.id !== value.targetId || !Array.isArray(value.roots) || value.roots.length > 1000
      || !parsePermissionEpochProof(value.operationEpochs) || !["COMPANY","OWNER"].includes(String(value.audience))
      || (value.audience === "COMPANY") !== (["Action","Goal","GoalUpdate","KeyResult","Document","BrainSource","Role","Circle"].includes(value.targetKind) && value.content.isPrivate !== true)
      || row.controlJson.audience !== value.audience || !parsePermissionEpochProof(value.epochs) || row.workspaceId !== value.workspaceId || row.userId !== value.userId
      || row.actorKind !== "user" || row.credentialId != null || row.credentialVersion != null || row.scopeHash != null
      || row.controlJson.targetKind !== value.targetKind || row.controlJson.targetId !== value.targetId
      || lineageContentFingerprint(value.targetKind, value.content) !== value.targetFingerprint) return null;
    return value as unknown as Capsule;
  } catch { return null; }
}

export async function currentLegacyRecoveryPublication(actor: AppActor, workspaceId: string, receipt: Record<string, unknown>, db: Db): Promise<Capsule | null> {
  const capsule = decodeLegacyRecovery(receipt);
  if (!capsule || capsule.workspaceId !== workspaceId || !await isArtifactPermissionEpochProofCurrent(workspaceId, capsule.epochs, db)) return null;
  const selection = { workspaceId, kind: capsule.targetKind, id: capsule.targetId };
  const current = await load(db, selection);
  if (!current || !await targetAudience(actor, selection, current, db)) return null;
  const scope = pending.getStore();
  if (scope?.active && scope.actor === actor && scope.tx === db && scope.receiptId === receipt.id
    && lineageContentFingerprint(selection.kind, current) === capsule.targetFingerprint) return capsule;
  const manifest = await db.artifactInputLineage.findFirst({ where: { id: capsule.targetManifestId, workspaceId,
    artifactType: capsule.targetKind, artifactId: capsule.targetId, contentHash: capsule.targetFingerprint, origin: "DERIVED" } });
  if (!manifest || !Array.isArray(manifest.rootsJson) || !manifest.rootsJson.some(root => record(root)
    && root.kind === "ConversationOperationOutcome" && root.id === receipt.id
    && root.fingerprint === lineageContentFingerprint("ConversationOperationOutcome", receipt))) return null;
  return capsule;
}

/** Already recorded contributors remain restrictions, even when an UNKNOWN head
 * has no usable roots. Audit labels and guessed prompt segments are not inputs. */
async function knownRoots(actor: AppActor, selection: Selection, row: Row, db: Db): Promise<LineageRoot[]> {
  const roots = new Map<string, LineageRoot>();
  let retainedBytes = 0;
  function retain(root: LineageRoot) {
    const key = hash(root);
    if (roots.has(key)) return;
    retainedBytes += Buffer.byteLength(JSON.stringify(root));
    invariant(roots.size < 1000 && retainedBytes <= 1_048_576,413,"RECOVERY_EVIDENCE_LIMIT","The distinct original evidence exceeds this recovery's safe bound.");
    roots.set(key,root);
  }
  let revision: number | undefined;
  let examinedManifests = 0;
  for (;;) {
    const take = Math.min(100, RECOVERY_EVIDENCE_CANDIDATES - examinedManifests) || 1;
    const manifests = await db.artifactInputLineage.findMany({where:{workspaceId:selection.workspaceId,
      artifactType:selection.kind,artifactId:selection.id,...(revision===undefined?{}:{revision:{lt:revision}})},orderBy:{revision:"desc"},take});
    invariant(examinedManifests + manifests.length <= RECOVERY_EVIDENCE_CANDIDATES,413,"RECOVERY_EVIDENCE_LIMIT",
      "The historical manifest evidence exceeds this recovery's safe bound. Regenerate from currently authorized sources.");
    examinedManifests += manifests.length;
    for (const manifest of manifests) {
      invariant(Array.isArray(manifest.rootsJson),409,"RECOVERY_EVIDENCE_INVALID","Historical ancestry is malformed.");
      for (const value of manifest.rootsJson) {
        invariant(record(value) && typeof value.kind === "string" && typeof value.id === "string" && typeof value.fingerprint === "string",
          409,"RECOVERY_EVIDENCE_INVALID","Historical ancestry is malformed.");
        const root = value as unknown as LineageRoot;
        invariant(!(root.kind === selection.kind && root.id === selection.id),409,"RECOVERY_EVIDENCE_INVALID","Cyclic historical ancestry cannot be recovered.");
        retain(root);
      }
    }
    if (manifests.length < take) break;
    revision = manifests.at(-1)!.revision;
  }
  const parents=artifactPermissionParents(selection.kind,row);
  if(selection.kind === "BrainSource" && record(row.metadata) && typeof row.metadata.documentId === "string"
    && !parents.some(parent=>parent.kind === "Document" && parent.id === (row.metadata as Record<string,unknown>).documentId)) {
    parents.push({kind:"Document",id:row.metadata.documentId});
  }
  for (const parent of parents) {
    for (const root of await captureArtifactInputProof(actor, selection.workspaceId, [parent], db)) retain(root);
  }
  if (selection.kind === "Action") {
    let cursor: string | undefined;
    let examinedSources = 0;
    for (;;) {
      const take = Math.min(100, RECOVERY_EVIDENCE_CANDIDATES - examinedSources) || 1;
      const sources=await db.actionCreationSource.findMany({where:{workspaceId:selection.workspaceId,actionId:selection.id,
        ...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:"asc"},take});
      invariant(examinedSources + sources.length <= RECOVERY_EVIDENCE_CANDIDATES,413,"RECOVERY_EVIDENCE_LIMIT",
        "The original Action source evidence exceeds this recovery's safe bound. Regenerate from currently authorized sources.");
      examinedSources += sources.length;
      for (const source of sources) if(source.sourceType === "MEETING_INSIGHT") {
        for(const root of await captureArtifactInputProof(actor,selection.workspaceId,[{kind:"MeetingInsight",id:source.sourceId}],db)) retain(root);
      }
      if(sources.length<take) break;
      cursor=sources.at(-1)!.id;
    }
  }

  const result = [...roots].sort(([a],[b])=>a.localeCompare(b)).map(([,root])=>root);
  invariant(result.length <= 1000 && (!result.length || await isArtifactInputProofReadable(actor, selection.workspaceId, result, db)),
    409, "RECOVERY_SOURCE_RESTRICTED", "A known original contributor is no longer available. Regenerate from currently authorized sources.");
  return result;
}

async function selectionForRecovery(actor: AppActor, selection: Selection, db: Db) {
  invariant(actor.kind === "user" && !getMcpOrigin() && !getSupportAuthorizationContext()?.origin, 403, "RECOVERY_HUMAN_REQUIRED", "Recover selected history from your authenticated workspace session.");
  invariant(isLegacyRecoveryKind(selection.kind) && typeof selection.id === "string" && selection.id.length > 0,
    400, "INVALID_INPUT", "Select a supported historical record.");
  const member = await requireWorkspaceMembership({ actor, workspaceId: selection.workspaceId, tx: db });
  invariant(!getSupportAuthorizationContext()?.origin,403,"RECOVERY_HUMAN_REQUIRED","Use a direct workspace membership to recover history.");
  const row = await load(db, selection);
  invariant(row && await targetAudience(actor, selection, row, db), 404, "NOT_FOUND", "Selected history is unavailable.");
  invariant(selection.kind.startsWith("Conversation") || member?.role === "ADMIN", 403, "RECOVERY_ADMIN_REQUIRED", "A workspace administrator must recover company history.");
  return row;
}

export async function inspectLegacyRecovery(actor: AppActor, selection: Selection) {
  // UNKNOWN targets are eligible only under recovery's existing audience rule.
  // Bind its original row, head and caller epochs before contributor reads. Content
  // admission applies to the contributors, never as a bypass for the target.
  const observed = await captureArtifactReadHeadObservation(async () => {
    const target = await prisma.$transaction(async tx => {
      const row = await selectionForRecovery(actor, selection, tx);
      const head = await tx.artifactInputLineage.findFirst({ where: { workspaceId: selection.workspaceId,
        artifactType: selection.kind, artifactId: selection.id }, orderBy: { revision: "desc" } });
      const epochs = await captureArtifactPermissionEpochs(actor, selection.workspaceId,
        [{ kind: selection.kind, id: selection.id, fingerprint: lineageContentFingerprint(selection.kind, row) }], tx);
      return { row, rowStamp: hash(row), headStamp: hash(head), epochs };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
    // Native contributors retain their normal outside-transaction replay.
    const roots = await knownRoots(actor, selection, target.row, prisma);
    const parent = selection.kind === "GoalUpdate" || selection.kind === "KeyResult"
      ? await prisma.goal.findFirst({ where: { id: String(target.row.goalId), workspaceId: selection.workspaceId } }) : null;
    return { ...target, roots,
      preview: { ...selection, fingerprint: lineageContentFingerprint(selection.kind, target.row), knownContributors: roots.length,
        requiresConfirmation: true, private: selection.kind.startsWith("Conversation") || target.row.isPrivate === true || parent?.isPrivate === true,
        hasFile: selection.kind === "BrainSource" && typeof target.row.fileStorageKey === "string" } };
  });
  const original = observed.value;
  return withArtifactCountReleaseSnapshot(actor, selection.workspaceId, original.roots, async () => {}, async tx => {
    const current = await selectionForRecovery(actor, selection, tx);
    const head = await tx.artifactInputLineage.findFirst({ where: { workspaceId: selection.workspaceId,
      artifactType: selection.kind, artifactId: selection.id }, orderBy: { revision: "desc" } });
    invariant(hash(current) === original.rowStamp && hash(head) === original.headStamp
      && await isArtifactPermissionEpochProofCurrent(selection.workspaceId, original.epochs, tx),
    409, "RECOVERY_STALE", "The original recovery preview or its authority changed.");
    return original.preview;
  }, observed.heads);
}

/** Strict namespace evidence is deliberately stronger than an arbitrary stored
 * key. No foreign object is fetched to discover whether it might be authorized. */
export function assertRecoveryStorageKey(workspaceId: string, key: string) {
  invariant(/^[A-Za-z0-9_-]+$/.test(workspaceId) && key.startsWith(`workspaces/${workspaceId}/uploads/`)
    && !key.includes("\\") && !key.split("/").some(part => !part || part === "." || part === "..")
    && !/%[0-9a-f]{2}/i.test(key), 409, "RECOVERY_STORAGE_UNPROVEN", "This storage key has no verified workspace upload namespace.");
}
async function verifyFile(selection: Selection, row: Row): Promise<ByteBinding | null> {
  if (selection.kind !== "BrainSource" || row.fileStorageKey == null) return null;
  invariant(typeof row.fileStorageKey === "string", 409, "RECOVERY_STORAGE_UNPROVEN", "File storage identity is invalid.");
  assertRecoveryStorageKey(selection.workspaceId, row.fileStorageKey);
  invariant(Number.isSafeInteger(row.fileSizeBytes) && Number(row.fileSizeBytes) >= 0 && Number(row.fileSizeBytes) <= 100 * 1024 * 1024,
    413, "RECOVERY_FILE_LIMIT", "This file requires a bounded verified storage recovery.");
  const metadata = record(row.metadata) ? row.metadata : {};
  let documentHash: unknown;
  if (metadata.documentId !== undefined || ["DOC", "FILE_UPLOAD"].includes(String(row.sourceType))) {
    invariant(typeof metadata.documentId === "string", 409, "RECOVERY_STORAGE_UNPROVEN", "The file has no original Document binding.");
    const document = await prisma.document.findFirst({where:{id:metadata.documentId,workspaceId:selection.workspaceId,archivedAt:null,accessDomain:"WORKSPACE"}});
    invariant(document && document.storageKey === row.fileStorageKey && document.mimeType === row.fileMimeType,
      409, "RECOVERY_STORAGE_UNPROVEN", "The Document and source do not bind the same original file.");
    const documentMetadata = record(document.metadata) ? document.metadata : {};
    documentHash = documentMetadata.fileContentHash;
    invariant(documentMetadata.size === undefined || documentMetadata.size === row.fileSizeBytes,
      409, "RECOVERY_STORAGE_UNPROVEN", "The original file sizes disagree.");
  }
  const {defaultStorage} = await import("@corgtex/storage");
  const stored = await defaultStorage.getStream(row.fileStorageKey);
  invariant(stored, 404, "RECOVERY_FILE_MISSING", "The original file is not available in storage.");
  const reader = stored.body.getReader(), digest = createHash("sha256"); let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    invariant(size <= Number(row.fileSizeBytes), 409, "RECOVERY_FILE_CHANGED", "Stored file size differs from its original binding.");
    digest.update(next.value);
  } } catch (error) { await reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
  invariant(size === row.fileSizeBytes, 409, "RECOVERY_FILE_CHANGED", "Stored file size differs from its original binding.");
  const sha256 = digest.digest("hex");
  invariant((metadata.fileContentHash === undefined || metadata.fileContentHash === sha256)
    && (documentHash === undefined || documentHash === sha256),
    409, "RECOVERY_FILE_CHANGED", "Stored bytes disagree with the recorded file digest.");
  return { storageKey: row.fileStorageKey, sha256, sizeBytes: size };
}

export async function recoverLegacyArtifact(actor: AppActor, submission: Selection & { expectedFingerprint: string; requestId: string; consent: "RESTORE_SELECTED_HISTORY" }) {
  const request = structuredClone(submission);
  invariant(request.consent === "RESTORE_SELECTED_HISTORY" && /^[a-f0-9]{64}$/.test(request.expectedFingerprint)
    && /^[a-zA-Z0-9_-]{16,128}$/.test(request.requestId), 400, "INVALID_INPUT", "Confirm the exact selected history and recovery request.");
  const row = await selectionForRecovery(actor, request, prisma);
  invariant(actor.kind === "user", 403, "RECOVERY_HUMAN_REQUIRED", "A human recovery session is required.");
  invariant(lineageContentFingerprint(request.kind, row) === request.expectedFingerprint, 409, "RECOVERY_STALE", "The selected record changed.");
  // Goal children retain the parent as a known root, including its private audience.
  // Company capture removes only the recovering operator, never parent restrictions.
  const company = ["Action","Goal","GoalUpdate","KeyResult","Document","BrainSource","Role","Circle"].includes(request.kind) && row.isPrivate !== true;
  const perform = async () => {
  const userId = actor.user.id, requestKey = hash([LEGACY_RECOVERY_OPERATION, request.workspaceId, userId, request.requestId]);
  const requestHash = hash(request);
  const existing = await prisma.conversationOperationOutcome.findUnique({where:{workspaceId_requestKey:{workspaceId:request.workspaceId,requestKey}}});
  if (existing) {
    const capsule = await currentLegacyRecoveryPublication(actor, request.workspaceId, existing, prisma);
    invariant(capsule?.requestHash === requestHash, 409, "RECOVERY_CONFLICT", "This recovery request cannot be reused.");
    await captureArtifactInputProof(actor, request.workspaceId, [{kind:request.kind,id:request.id}]);
    return { id: request.id, kind: request.kind, method: "CURRENT_RECOVERY" as const, basis: capsule.basis, receiptId: existing.id };
  }
  // Reuse genuinely complete evidence instead of introducing a new permission basis.
  const operator = await prisma.member.findFirst({where:{workspaceId:request.workspaceId,userId,isActive:true}});
  const inspection = operator?.role === "ADMIN" ? await inspectSourceLineageBackfill({actor, workspaceId:request.workspaceId, artifacts:[{kind:request.kind,id:request.id}]}) : {entries:[]};
  const evidence = inspection.entries[0];
  invariant(operator,403,"RECOVERY_ADMIN_REQUIRED","Current membership is required.");
  const operationEpochs = await capturePermissionEpochs(prisma,request.workspaceId,[{kind:"Member",id:operator.id},
    {kind:"MemberRolePolicy",id:operator.id},{kind:"MemberUserPolicy",id:userId},{kind:"WorkspaceSupportPolicy",id:userId}]);
  const roots = await knownRoots(actor, request, row, prisma);
  const evidenceRoots = evidence?.status === "RECOVERABLE_SNAPSHOT" && evidence.snapshotId
    ? await captureArtifactInputProof(actor,request.workspaceId,[{kind:"ArtifactInputSnapshot",id:evidence.snapshotId}])
    : evidence?.status === "VERIFIED_CURRENT"
      ? await captureArtifactInputProof(actor,request.workspaceId,[{kind:request.kind,id:request.id,snapshot:row}]) : [];
  const basis = evidenceRoots.length ? "EXISTING_EVIDENCE" as const : "CURRENT_ATTESTATION" as const;
  const inheritedRoots = [...new Map([...roots,...evidenceRoots].map(root=>[hash(root),root])).values()];
  const epochs = await captureArtifactPermissionEpochs(actor, request.workspaceId,
    [{kind:request.kind,id:request.id,fingerprint:request.expectedFingerprint}, ...inheritedRoots], prisma);
  const file = await verifyFile(request, row);
  const content = JSON.parse(JSON.stringify(row)) as Row;
  invariant(Buffer.byteLength(JSON.stringify(content)) <= 1_048_576, 413, "RECOVERY_CONTENT_LIMIT", "Select a bounded historical record.");
  const publish = () => prisma.$transaction(async tx => {
    const write = async () => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},0))`;
    const prior = await tx.conversationOperationOutcome.findUnique({where:{workspaceId_requestKey:{workspaceId:request.workspaceId,requestKey}}});
    if (prior) {
      const capsule = await currentLegacyRecoveryPublication(actor,request.workspaceId,prior,tx);
      invariant(capsule?.requestHash === requestHash && await isArtifactInputProofReadable(actor,request.workspaceId,
        [{kind:request.kind,id:request.id,fingerprint:request.expectedFingerprint}],tx),409,"RECOVERY_CONFLICT","The original recovery is no longer valid.");
      return {id:request.id,kind:request.kind,method:"CURRENT_RECOVERY" as const,basis:capsule.basis,receiptId:prior.id};
    }
    const table = request.kind;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id=${request.id} FOR UPDATE`);
    await tx.$queryRaw`SELECT id FROM "Member" WHERE "workspaceId"=${request.workspaceId} AND "userId"=${userId} FOR SHARE`;
    const current = await selectionForRecovery(actor, request, tx);
    invariant(actor.kind === "user" && actor.user.id === userId && lineageContentFingerprint(request.kind,current) === request.expectedFingerprint
      && await isArtifactPermissionEpochProofCurrent(request.workspaceId,operationEpochs,tx)
      && await isArtifactPermissionEpochProofCurrent(request.workspaceId,epochs,tx)
      && (!inheritedRoots.length || await isArtifactInputProofReadable(actor,request.workspaceId,inheritedRoots,tx)),409,"RECOVERY_STALE","Recovery sources or permissions changed.");
    const freshRoots = await knownRoots(actor,request,current,tx);
    invariant(hash(freshRoots) === hash(roots),409,"RECOVERY_STALE","Historical evidence changed during recovery.");
    let publicationRoots = basis === "EXISTING_EVIDENCE"
      ? [...roots,...await captureImmutableArtifactInputProof(actor,request.workspaceId,evidenceRoots,tx)] : inheritedRoots;
    // Goal progress updates consume their children and then change the parent.
    // Freeze the approved parent content, retaining its live permission envelope.
    if (request.kind === "GoalUpdate" || request.kind === "KeyResult") {
      publicationRoots = await captureImmutableArtifactInputProof(actor, request.workspaceId, publicationRoots, tx);
    }
    const id = randomUUID(), targetManifestId = randomUUID();
    const capsule: Capsule = {version:1,workspaceId:request.workspaceId,userId,targetKind:request.kind,targetId:request.id,
      targetFingerprint:request.expectedFingerprint,targetManifestId,requestHash,basis,content,audience:company?"COMPANY":"OWNER",operationEpochs,epochs,roots:publicationRoots,file};
    const outcome = await tx.conversationOperationOutcome.create({data:{id,workspaceId:request.workspaceId,actorKind:"user",userId,
      operation:LEGACY_RECOVERY_OPERATION,requestKey,requiredScopes:[],controlJson:{version:1,audience:capsule.audience,targetKind:request.kind,targetId:request.id,
        encryptedPayloadJson:encryptSecret(JSON.stringify(capsule))}}});
    const root: LineageRoot = {kind:"ConversationOperationOutcome",id,fingerprint:lineageContentFingerprint("ConversationOperationOutcome",outcome)};
    const receiptEpochs = await captureArtifactPermissionEpochs(actor,request.workspaceId,[root,...roots],tx);
    await tx.artifactInputLineage.create({data:{workspaceId:request.workspaceId,artifactType:root.kind,artifactId:id,revision:1,
      origin:"NATIVE_ORIGINAL",contentHash:root.fingerprint,inputsJson:[],rootsJson:[],epochProofVersion:1,
      permissionEpochsJson:receiptEpochs as unknown as Prisma.InputJsonValue}});
    const scope = {actor,tx,receiptId:id,active:true};
    try { await pending.run(scope,()=>recordArtifactInputLineage({tx,actor,workspaceId:request.workspaceId,
      artifact:{kind:request.kind,id:request.id},manifestId:targetManifestId,content:current,origin:"DERIVED",inputs:[],
      inheritedRoots:[{...root,permissionEpochs:receiptEpochs}]})); } finally {scope.active=false;}
    invariant(await isArtifactInputProofReadable(actor,request.workspaceId,[{kind:request.kind,id:request.id,fingerprint:request.expectedFingerprint}],tx),
      409,"RECOVERY_STALE","Recovered history failed its final current authorization check.");
    await tx.auditLog.create({data:{workspaceId:request.workspaceId,actorUserId:userId,action:"legacy-history.recovered",entityType:request.kind,
      entityId:request.id,meta:{receiptId:id,method:"CURRENT_RECOVERY",originalFingerprint:request.expectedFingerprint}}});
    return {id:request.id,kind:request.kind,method:"CURRENT_RECOVERY" as const,basis,receiptId:id};
    };
    return company ? withCompanyLegacyRecoveryCapture({actor,workspaceId:request.workspaceId,targetKind:request.kind,targetId:request.id,tx},write) : write();
  },{isolationLevel:"Serializable",timeout:60_000});
  for(let attempt=0;;attempt++) {try{return await publish();}catch(error){
    const known = error instanceof Prisma.PrismaClientKnownRequestError;
    const target = known && Array.isArray(error.meta?.target) ? error.meta.target : [];
    const requestRace = known && error.code === "P2002" && target.length === 2 && target.includes("workspaceId") && target.includes("requestKey");
    const serialization = known && (error.code === "P2034" || error.code === "P2010" && error.meta?.code === "40001");
    if(attempt>=2 || !requestRace && !serialization) throw error;
  }}
  };
  return company ? withCompanyLegacyRecoveryCapture({actor,workspaceId:request.workspaceId,targetKind:request.kind,targetId:request.id},perform) : perform();
}

export async function legacyRecoveryFileBinding(actor: AppActor, workspaceId: string, sourceId: string): Promise<ByteBinding | null> {
  let after: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const rows = await prisma.conversationOperationOutcome.findMany({where:{workspaceId,operation:LEGACY_RECOVERY_OPERATION,
      controlJson:{path:["targetId"],equals:sourceId},
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },orderBy:[{createdAt:"desc"},{id:"desc"}],take:100});
    for(const row of rows) {
      const capsule = await currentLegacyRecoveryPublication(actor,workspaceId,row,prisma);
      if(capsule?.targetKind!=="BrainSource" || !capsule.file) continue;
      const source = await prisma.brainSource.findFirst({where:{id:sourceId,workspaceId}});
      if(!source || lineageContentFingerprint("BrainSource",source)!==capsule.targetFingerprint
        || source.fileStorageKey!==capsule.file.storageKey || source.fileSizeBytes!==capsule.file.sizeBytes) continue;
      await captureArtifactInputProof(actor,workspaceId,[{kind:"ConversationOperationOutcome",id:row.id}]);
      return capsule.file;
    }
    if(rows.length < 100) return null;
    const last = rows[rows.length - 1];
    after = { createdAt: last.createdAt, id: last.id };
  }
}

async function assertRecoveryOperatorCurrent(actor:AppActor,workspaceId:string,userId:string,epochs:PermissionEpochProof,db:Db) {
  invariant(actor.kind === "user" && actor.user.id === userId,403,"RECOVERY_HUMAN_REQUIRED","The original current human request is required.");
  await db.$queryRaw`SELECT id FROM "Member" WHERE "workspaceId"=${workspaceId} AND "userId"=${actor.user.id} FOR SHARE`;
  const member=await db.member.findFirst({where:{workspaceId,userId:actor.user.id,isActive:true}});
  invariant(member?.role === "ADMIN" && await isArtifactPermissionEpochProofCurrent(workspaceId,epochs,db),
    409,"RECOVERY_STALE","The original recovery operator authority changed.");
}

/** Rebuilds run only under the actual current human request, never a reconstructed
 * author or serialized background capability. */
export async function assertLegacyRecoveryProjection(actor: AppActor, workspaceId: string, receiptId: string,
  targetKind: "Document" | "BrainSource", targetId: string, db: Db = prisma) {
  const native = await db.conversationOperationOutcome.findFirst({where:{id:receiptId,workspaceId,operation:LEGACY_RECOVERY_OPERATION}});
  const capsule = native && await currentLegacyRecoveryPublication(actor,workspaceId,native,db);
  invariant(actor.kind === "user" && !getMcpOrigin() && capsule?.targetKind === targetKind && capsule.targetId === targetId
    && capsule.userId === actor.user.id,403,"RECOVERY_PROJECTION_FORBIDDEN","Use the original authenticated recovery request to rebuild this source.");
  await selectionForRecovery(actor,{workspaceId,kind:targetKind,id:targetId},db);
  await assertRecoveryOperatorCurrent(actor,workspaceId,capsule.userId,capsule.operationEpochs,db);
  await captureArtifactInputProof(actor,workspaceId,[{kind:targetKind,id:targetId}],db);
  return capsule;
}

type RecoveryDerivation = {actor:AppActor;workspaceId:string;sourceId:string;sourceFingerprint:string;receiptId:string;agentRunId:string;active:boolean};
const derivationScope = new AsyncLocalStorage<RecoveryDerivation>();
/** Internal write-purpose only. This does not authorize any source read. */
export async function withLegacyRecoveryDerivation<T>(binding:Omit<RecoveryDerivation,"active">,tx:Db,work:()=>Promise<T>) {
  await assertLegacyRecoveryProjection(binding.actor,binding.workspaceId,binding.receiptId,"BrainSource",binding.sourceId,tx);
  const scope={...binding,active:true};
  try{return await derivationScope.run(scope,work);}finally{scope.active=false;}
}
export async function isLegacyRecoveryDerivationCurrent(actor:AppActor,workspaceId:string,
  derivation:{sourceId:string;sourceFingerprint:string;agentRunId:string},tx:Db) {
  const scope=derivationScope.getStore();
  if(!scope?.active || scope.actor!==actor || scope.workspaceId!==workspaceId || scope.sourceId!==derivation.sourceId
    || scope.sourceFingerprint!==derivation.sourceFingerprint || scope.agentRunId!==derivation.agentRunId) return false;
  await assertLegacyRecoveryProjection(actor,workspaceId,scope.receiptId,"BrainSource",scope.sourceId,tx);
  return true;
}

/** Real request orchestrator; no serialized principal or background read grant. */
export async function withLegacyRecoveryProjection<T>(actor:AppActor,workspaceId:string,receiptId:string,
  targetKind:"Document"|"BrainSource",targetId:string,work:()=>Promise<T>) {
  const recovery=await assertLegacyRecoveryProjection(actor,workspaceId,receiptId,targetKind,targetId);
  return recovery.audience==="COMPANY" ? withCompanyLegacyRecoveryCapture({actor,workspaceId,targetKind,targetId,receiptId,assertCurrent:tx=>assertRecoveryOperatorCurrent(actor,workspaceId,recovery.userId,recovery.operationEpochs,tx)},work) : work();
}
