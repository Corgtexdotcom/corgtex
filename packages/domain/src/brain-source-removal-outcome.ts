import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { assertMcpOriginActive, getMcpOrigin } from "../../shared/src/mcp-context";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { lockBrainSourceLink } from "./brain-source-links";
import { captureConversationInputReceipt, validateConversationInputReceipt, type ConversationInputReceipt } from "./conversation-lineage";
import { AppError, invariant } from "./errors";
import { lockFinanceImportArtifactOwnership } from "./finance-import-artifact-ownership";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureArtifactPermissionEpochs,
  lineageContentFingerprint, sealArtifactInputActor } from "./source-lineage";

export const BRAIN_SOURCE_REMOVAL_COMPLETED = "BRAIN_SOURCE_REMOVAL_COMPLETED";
type Db = typeof prisma | Prisma.TransactionClient;
type Mode = "DIRECT" | "REVIEWED";
type SourceEnvelope = { id: string; workspaceId: string; accessDomain: string; authorMemberId: string | null;
  archivedAt: Date | null; archivedByUserId: string | null; sourceType: string; bindingMalformed: boolean; documentId: string | null };
type DocumentEnvelope = Pick<SourceEnvelope, "id" | "workspaceId" | "accessDomain" | "archivedAt" | "archivedByUserId">;
type ArchiveGeneration = { id: string; archivedAt: Date };
type JobControl = { id: string; type: string; status: string; sourceId: string | null; phase: string | null;
  completionPlanIdentityHash: string | null; archiveLinkedDocumentRequested: boolean };
export type BrainSourceRemovalControl = { version: 1; sourceId: string; sourceArchiveRecordId: string; sourceArchivedAt: string;
  sourceControlHash: string; documentId: string | null; documentArchiveRecordId: string | null; documentControlHash: string | null;
  mode: Mode; jobId: string | null; planIdentityHash: string; pendingSourceId: string | null; archiveLinkedDocumentRequested: boolean };
type Principal = { actorKind: "user" | "agent"; userId: string | null; credentialId: string | null;
  credentialVersion: string | null; scopeHash: string | null };
type Prepared = { actor: AppActor; tx: Prisma.TransactionClient; workspaceId: string; sourceId: string;
  mode: Mode; jobId: string | null; planIdentityHash: string; priorSourceGeneration: string | null;
  sourceIdentityHash: string; principal: Principal; originIdentity: string | null; archiveLinkedDocumentRequested: boolean };
export type BrainSourceRemovalControlToken = Readonly<{ readonly purpose: "BRAIN_SOURCE_REMOVAL_CONTROL" }>;
type BrainSourceRemovalOutcome = { id: string; status: "archived" }
  | { status: "applied"; sourceId: string; pendingSourceId: string | null };
const tokens = new WeakMap<BrainSourceRemovalControlToken, Prepared>();
export type ArchivedBrainSourceRetirementToken = Readonly<{ purpose: "ARCHIVED_SOURCE_EXCLUSION" }>;
type RetirementControl = { actor: AppActor; tx: Prisma.TransactionClient; workspaceId: string; sourceId: string;
  sourceControlHash: string; archiveRecordId: string; principal: Principal; originIdentity: string | null;
  documentControlHash: string | null; documentArchiveRecordId: string | null };
const retirementTokens = new WeakMap<ArchivedBrainSourceRetirementToken, RetirementControl>();
const receipts = new WeakMap<object, ConversationInputReceipt>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const CONTROL_FIELDS = ["version", "sourceId", "sourceArchiveRecordId", "sourceArchivedAt", "sourceControlHash", "documentId",
  "documentArchiveRecordId", "documentControlHash", "mode", "jobId", "planIdentityHash", "pendingSourceId", "archiveLinkedDocumentRequested"] as const;
function controlIdentity(control: BrainSourceRemovalControl) {
  // This native key has a defined scalar order; JSONB field order is immaterial.
  return CONTROL_FIELDS.map(field => control[field]);
}
function ambientOriginIdentity() {
  const origin = getMcpOrigin();
  return origin ? hash([origin.kind, origin.id, origin.workspaceId, origin.scopeHash, origin.credentialVersion ?? null, origin.grantEpoch ?? null]) : null;
}

function principal(actor: AppActor): Principal {
  return actor.kind === "user" ? { actorKind: "user", userId: actor.user.id, credentialId: null, credentialVersion: null, scopeHash: null }
    : { actorKind: "agent", userId: null, credentialId: actor.credentialId ?? null,
      credentialVersion: actor.credentialVersion ?? null, scopeHash: mcpScopesHash(actor.scopes ?? []) };
}
function parseControl(value: unknown): BrainSourceRemovalControl | null {
  if (!isRecord(value)) return null;
  const fields = CONTROL_FIELDS;
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || value.version !== 1
    || !["DIRECT", "REVIEWED"].includes(String(value.mode)) || typeof value.archiveLinkedDocumentRequested !== "boolean") return null;
  for (const field of ["sourceId", "sourceArchiveRecordId", "sourceArchivedAt"]) if (typeof value[field] !== "string" || !value[field]) return null;
  if (!Number.isFinite(Date.parse(String(value.sourceArchivedAt)))) return null;
  for (const field of ["sourceControlHash", "planIdentityHash"]) if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/.test(value[field])) return null;
  for (const field of ["documentId", "documentArchiveRecordId", "jobId", "pendingSourceId"]) if (value[field] !== null
    && (typeof value[field] !== "string" || !value[field])) return null;
  if (value.documentControlHash !== null && (typeof value.documentControlHash !== "string" || !/^[a-f0-9]{64}$/.test(value.documentControlHash))) return null;
  if ((value.documentId === null) !== (value.documentControlHash === null)
    || (value.documentId === null && value.documentArchiveRecordId !== null)
    || (value.archiveLinkedDocumentRequested && value.documentId === null)
    || (value.mode === "DIRECT" && (value.jobId !== null || value.pendingSourceId !== null))
    || (value.mode === "REVIEWED" && value.jobId === null)) return null;
  return value as BrainSourceRemovalControl;
}
async function sourceEnvelope(db: Db, workspaceId: string, sourceId: string): Promise<SourceEnvelope | null> {
  // No archived body, title, arbitrary metadata, or archive previousState is read.
  const rows = await db.$queryRaw<SourceEnvelope[]>`SELECT id, "workspaceId", "accessDomain", "authorMemberId", "archivedAt",
    "archivedByUserId", "sourceType"::text,
    CASE WHEN "sourceType" IN ('DOC', 'FILE_UPLOAD') AND jsonb_typeof(metadata->'documentId') = 'string'
      THEN metadata->>'documentId' ELSE NULL END AS "documentId",
    CASE WHEN metadata ? 'documentId' AND ("sourceType" NOT IN ('DOC', 'FILE_UPLOAD')
      OR jsonb_typeof(metadata->'documentId') IS DISTINCT FROM 'string') THEN true ELSE false END AS "bindingMalformed"
    FROM "BrainSource" WHERE id = ${sourceId} AND "workspaceId" = ${workspaceId}`;
  return rows[0] ?? null;
}
async function documentEnvelope(db: Db, workspaceId: string, documentId: string) {
  return db.document.findFirst({ where: { id: documentId, workspaceId }, select: {
    id: true, workspaceId: true, accessDomain: true, archivedAt: true, archivedByUserId: true,
  } });
}
function sourceIdentity(source: SourceEnvelope) {
  return hash([source.id, source.workspaceId, source.sourceType, source.accessDomain, source.authorMemberId, source.documentId]);
}
function sourceControlHash(source: SourceEnvelope) {
  return hash([sourceIdentity(source), source.archivedAt?.toISOString() ?? null, source.archivedByUserId]);
}
function documentControlHash(document: DocumentEnvelope) {
  return hash([document.id, document.workspaceId, document.accessDomain,
    document.archivedAt?.toISOString() ?? null, document.archivedByUserId]);
}
async function generation(db: Db, workspaceId: string, kind: "BrainSource" | "Document", id: string): Promise<ArchiveGeneration | null> {
  return db.workspaceArchiveRecord.findFirst({ where: { workspaceId, entityType: kind, entityId: id,
    restoredAt: null, purgedAt: null }, select: { id: true, archivedAt: true }, orderBy: [{ archivedAt: "desc" }, { id: "desc" }] });
}
async function jobControl(db: Db, workspaceId: string, jobId: string) {
  const rows = await db.$queryRaw<JobControl[]>`SELECT id, type, status::text,
    payload->>'sourceId' AS "sourceId", payload->>'phase' AS phase,
    payload->>'completionPlanIdentityHash' AS "completionPlanIdentityHash",
    (jsonb_typeof(payload->'archiveDocumentId') = 'string') IS TRUE AS "archiveLinkedDocumentRequested"
    FROM "WorkflowJob" WHERE id = ${jobId} AND "workspaceId" = ${workspaceId}`;
  return rows[0] ?? null;
}
async function requireControl(actor: AppActor, workspaceId: string, source: SourceEnvelope, mode: Mode, db: Db) {
  invariant(!source.bindingMalformed, 409, "SOURCE_CHANGED", "The source control binding is malformed.");
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
  const origin = getMcpOrigin();
  if (origin) {
    await assertMcpOriginActive(db as Prisma.TransactionClient, origin, workspaceId);
    if (actor.kind === "user") {
      const token = origin.kind === "oauth" ? await db.mcpOAuthAccessToken.findUnique({ where: { id: origin.id },
        select: { userId: true, workspaceId: true, scopes: true } }) : null;
      const required = [mode === "DIRECT" ? "brain:write" : "support:write", ...(source.accessDomain === "FINANCE" ? ["finance:write"] : [])];
      invariant(token?.userId === actor.user.id && token.workspaceId === workspaceId && required.every(scope => token.scopes.includes(scope)),
        403, "MCP_AUTHORIZATION_REVOKED", "Current user consent does not permit this control operation.");
    } else invariant(origin.kind === "agent" && origin.id === actor.credentialId && origin.credentialVersion === actor.credentialVersion
      && origin.scopeHash === mcpScopesHash(actor.scopes ?? []), 403, "MCP_AUTHORIZATION_REVOKED", "Control principal does not match the bearer.");
  }
  if (actor.kind === "user") {
    invariant(membership && (membership.role === "ADMIN" || (mode === "DIRECT" && membership.id === source.authorMemberId)),
      403, "FORBIDDEN", "Current source control authority is required.");
    if (source.accessDomain === "FINANCE") invariant((await resolveKnowledgeAccessDomains(actor, workspaceId, db)).includes("FINANCE"),
      403, "FORBIDDEN", "Current Finance authority is required.");
    return [];
  }
  const credential = actor.authProvider === "credential" && actor.credentialId && actor.credentialVersion
    ? await db.agentCredential.findFirst({ where: { id: actor.credentialId, workspaceId, isActive: true },
      select: { id: true, tokenHash: true, scopes: true } }) : null;
  invariant(credential && mcpCredentialVersion(credential.tokenHash) === actor.credentialVersion
    && mcpScopesHash(credential.scopes) === mcpScopesHash(actor.scopes ?? []), 403, "MCP_AUTHORIZATION_REVOKED", "Current authenticated control authority is required.");
  const scopes = credential.scopes;
  const required = mode === "REVIEWED" || !scopes.includes("brain:write") ? ["support:write"] : ["brain:write"];
  if (source.accessDomain === "FINANCE" && !required.includes("support:write")) required.push("finance:write");
  invariant(required.every(scope => scopes.includes(scope)), 403, "FORBIDDEN", "Current source write scopes are required.");
  return required;
}
async function unlinkedFinanceArtifact(tx: Prisma.TransactionClient, workspaceId: string, kind: "BRAIN_SOURCE" | "DOCUMENT", id: string) {
  await lockFinanceImportArtifactOwnership(tx, { workspaceId, kind, id });
  invariant(!await tx.financeImportBatch.findFirst({ where: { workspaceId, [kind === "DOCUMENT" ? "documentId" : "brainSourceId"]: id },
    select: { id: true } }), 409, "FINANCE_IMPORT_ARTIFACT_MANAGED", "Finance import artifacts use their own control path.");
}

/** A current administrative exclusion capability, never a grant to the archived
 * body. Only an actual native archive generation may seed a fresh retirement. */
export async function prepareArchivedBrainSourceRetirement(actor: AppActor, params: { workspaceId: string; sourceId: string },
  tx: Prisma.TransactionClient): Promise<ArchivedBrainSourceRetirementToken> {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  const originIdentity = ambientOriginIdentity();
  await assertArtifactInputWriteFence(tx);
  await lockBrainSourceLink(tx, params.sourceId);
  await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const source = await sourceEnvelope(tx, params.workspaceId, params.sourceId);
  invariant(source?.archivedAt, 409, "SOURCE_CHANGED", "The archived exclusion is unavailable.");
  await requireControl(actor, params.workspaceId, source, "REVIEWED", tx);
  await unlinkedFinanceArtifact(tx, params.workspaceId, "BRAIN_SOURCE", source.id);
  const archive = await generation(tx, params.workspaceId, "BrainSource", source.id);
  invariant(archive && archive.archivedAt.getTime() === source.archivedAt.getTime(),
    409, "OPERATION_NOT_COMMITTED", "The exclusion has no current native archive generation.");
  let document: DocumentEnvelope | null = null;
  let documentArchive: ArchiveGeneration | null = null;
  if (source.documentId) {
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${source.documentId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    document = await documentEnvelope(tx, params.workspaceId, source.documentId);
    invariant(document, 409, "SOURCE_CHANGED", "The exclusion document is unavailable.");
    documentArchive = document.archivedAt ? await generation(tx, params.workspaceId, "Document", document.id) : null;
    invariant(!document.archivedAt || documentArchive?.archivedAt.getTime() === document.archivedAt.getTime(),
      409, "OPERATION_NOT_COMMITTED", "The document has no current native archive generation.");
    if (document.accessDomain === "FINANCE") await requireControl(actor, params.workspaceId, { ...source, accessDomain: "FINANCE" }, "REVIEWED", tx);
    await unlinkedFinanceArtifact(tx, params.workspaceId, "DOCUMENT", document.id);
  }
  const token = Object.freeze({ purpose: "ARCHIVED_SOURCE_EXCLUSION" as const });
  retirementTokens.set(token, { actor, tx, workspaceId: params.workspaceId, sourceId: source.id,
    sourceControlHash: sourceControlHash(source), archiveRecordId: archive.id, principal: principal(actor), originIdentity,
    documentControlHash: document ? documentControlHash(document) : null, documentArchiveRecordId: documentArchive?.id ?? null });
  await assertArtifactInputWriteFence(tx);
  return token;
}

export async function consumeArchivedBrainSourceRetirement(token: ArchivedBrainSourceRetirementToken, actor: AppActor,
  params: { workspaceId: string; sourceId: string }, tx: Prisma.TransactionClient) {
  const control = retirementTokens.get(token);
  invariant(control && control.actor === actor && control.tx === tx && control.workspaceId === params.workspaceId
    && control.sourceId === params.sourceId && hash(control.principal) === hash(principal(actor))
    && control.originIdentity === ambientOriginIdentity(),
  409, "INVALID_INPUT_RECEIPT", "The native exclusion capability does not belong to this request.");
  retirementTokens.delete(token);
  await assertArtifactInputWriteFence(tx);
  const source = await sourceEnvelope(tx, params.workspaceId, params.sourceId);
  const archive = await generation(tx, params.workspaceId, "BrainSource", params.sourceId);
  invariant(source?.archivedAt && sourceControlHash(source) === control.sourceControlHash
    && archive?.id === control.archiveRecordId && archive.archivedAt.getTime() === source.archivedAt.getTime(),
  409, "SOURCE_CHANGED", "The native exclusion generation changed.");
  await requireControl(actor, params.workspaceId, source, "REVIEWED", tx);
  if (source.documentId) {
    const document = await documentEnvelope(tx, params.workspaceId, source.documentId);
    const documentArchive = document?.archivedAt ? await generation(tx, params.workspaceId, "Document", source.documentId) : null;
    invariant(document && documentControlHash(document) === control.documentControlHash
      && (documentArchive?.id ?? null) === control.documentArchiveRecordId
      && (!document.archivedAt || documentArchive?.archivedAt.getTime() === document.archivedAt.getTime()),
    409, "SOURCE_CHANGED", "The exclusion document generation changed.");
    if (document.accessDomain === "FINANCE") await requireControl(actor, params.workspaceId, { ...source, accessDomain: "FINANCE" }, "REVIEWED", tx);
  }
}

/** Root source gate for this exact native operational fact. It confers no body grant. */
export async function isBrainSourceRemovalOutcomeReadable(actor: AppActor, workspaceId: string, row: unknown, db: Db = prisma) {
  if (!isRecord(row) || row.workspaceId !== workspaceId || row.operation !== BRAIN_SOURCE_REMOVAL_COMPLETED
    || typeof row.requestKey !== "string" || !/^[a-f0-9]{64}$/.test(row.requestKey)) return false;
  const control = parseControl(row.controlJson);
  if (!control || Object.entries(principal(actor)).some(([field, value]) => row[field] !== value)) return false;
  try {
    const source = await sourceEnvelope(db, workspaceId, control.sourceId);
    if (!source?.archivedAt || source.archivedAt.toISOString() !== control.sourceArchivedAt
      || sourceControlHash(source) !== control.sourceControlHash || source.documentId !== control.documentId) return false;
    const current = await generation(db, workspaceId, "BrainSource", source.id);
    if (current?.id !== control.sourceArchiveRecordId || current.archivedAt.getTime() !== source.archivedAt.getTime()) return false;
    const scopes = await requireControl(actor, workspaceId, source, control.mode, db);
    if (!Array.isArray(row.requiredScopes) || hash(row.requiredScopes) !== hash(scopes)) return false;
    if (control.documentId) {
      const document = await documentEnvelope(db, workspaceId, control.documentId);
      if (!document || documentControlHash(document) !== control.documentControlHash) return false;
      const archive = await generation(db, workspaceId, "Document", document.id);
      if ((document.archivedAt ? archive?.id ?? null : null) !== control.documentArchiveRecordId
        || (document.archivedAt && archive?.archivedAt.getTime() !== document.archivedAt.getTime())) return false;
      if (document.accessDomain === "FINANCE") await requireControl(actor, workspaceId, { ...source, accessDomain: "FINANCE" }, control.mode, db);
    }
    if (control.pendingSourceId) {
      const pending = await sourceEnvelope(db, workspaceId, control.pendingSourceId);
      if (!pending) return false;
      await requireControl(actor, workspaceId, pending, "REVIEWED", db);
    }
    if (control.jobId) {
      const job = await jobControl(db, workspaceId, control.jobId);
      if (job?.type !== "agent.brain-source-regenerate" || job.status !== "COMPLETED" || job.phase !== "APPLIED"
        || job.sourceId !== source.id || job.completionPlanIdentityHash !== control.planIdentityHash
        || job.archiveLinkedDocumentRequested !== control.archiveLinkedDocumentRequested) return false;
    }
    return row.requestKey === hash([1, workspaceId, principal(actor), BRAIN_SOURCE_REMOVAL_COMPLETED, controlIdentity(control)]);
  } catch (error) {
    if (error instanceof AppError || (error instanceof Error && error.message === "MCP_AUTHORIZATION_REVOKED")
      || (isRecord(error) && ["NOT_A_MEMBER", "FORBIDDEN", "MCP_AUTHORIZATION_REVOKED"].includes(String(error.code)))) return false;
    throw error;
  }
}

/** Internal preparation: the token cannot be reconstructed from JSON or another transaction. */
export async function prepareBrainSourceRemovalControl(actor: AppActor, params: { workspaceId: string; sourceId: string;
  mode: Mode; jobId?: string; planIdentityHash: string; archiveLinkedDocument?: boolean }, tx: Prisma.TransactionClient): Promise<BrainSourceRemovalControlToken> {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  const originIdentity = ambientOriginIdentity();
  invariant(/^[a-f0-9]{64}$/.test(params.planIdentityHash) && (params.mode === "DIRECT" ? !params.jobId : Boolean(params.jobId)),
    409, "INVALID_REMOVAL_REQUEST", "Control plan identity is invalid.");
  await lockBrainSourceLink(tx, params.sourceId);
  await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const source = await sourceEnvelope(tx, params.workspaceId, params.sourceId);
  invariant(source, 404, "NOT_FOUND", "Source not found.");
  invariant(!params.archiveLinkedDocument || source.documentId, 409, "SOURCE_CHANGED", "The control document is unavailable.");
  await requireControl(actor, params.workspaceId, source, params.mode, tx);
  if (params.jobId) {
    const job = await jobControl(tx, params.workspaceId, params.jobId);
    invariant(job?.type === "agent.brain-source-regenerate" && job.status === "COMPLETED" && job.phase === "READY"
      && job.sourceId === source.id && job.archiveLinkedDocumentRequested === Boolean(params.archiveLinkedDocument),
    409, "INVALID_REMOVAL_REQUEST", "The reviewed control operation is not ready.");
  }
  invariant(!source.archivedAt || params.mode === "REVIEWED", 409, "OPERATION_ALREADY_COMMITTED", "A completed source requires its canonical outcome.");
  await unlinkedFinanceArtifact(tx, params.workspaceId, "BRAIN_SOURCE", source.id);
  const prior = await generation(tx, params.workspaceId, "BrainSource", source.id);
  await assertArtifactInputWriteFence(tx);
  const token = Object.freeze({ purpose: "BRAIN_SOURCE_REMOVAL_CONTROL" as const });
  tokens.set(token, { actor, tx, workspaceId: params.workspaceId, sourceId: source.id, mode: params.mode, jobId: params.jobId ?? null,
    planIdentityHash: params.planIdentityHash, principal: principal(actor), originIdentity,
    archiveLinkedDocumentRequested: Boolean(params.archiveLinkedDocument),
    sourceIdentityHash: sourceIdentity(source), priorSourceGeneration: prior?.id ?? null });
  return token;
}

async function bind(actor: AppActor, workspaceId: string, row: { id: string; controlJson: unknown }, tx: Prisma.TransactionClient,
  output: "archived" | "applied" = parseControl(row.controlJson)?.mode === "DIRECT" ? "archived" : "applied") {
  const control = parseControl(row.controlJson);
  invariant(control, 409, "INVALID_REMOVAL_REQUEST", "Native control fact is invalid.");
  const value: BrainSourceRemovalOutcome = output === "archived" ? { id: control.sourceId, status: "archived" }
    : { status: "applied", sourceId: control.sourceId, pendingSourceId: control.pendingSourceId };
  const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "ConversationOperationOutcome", id: row.id }], tx);
  receipts.set(value, await captureConversationInputReceipt({ actor, workspaceId, value, trustedRoots: roots, db: tx }));
  return value;
}

/** Construct only the final SQL operational fact; source bodies are never recertified. */
export async function commitBrainSourceRemovalCompletion(token: BrainSourceRemovalControlToken,
  params: { actor: AppActor; workspaceId: string; pendingSourceId?: string | null }, tx: Prisma.TransactionClient) {
  const prepared = tokens.get(token);
  invariant(prepared && prepared.actor === params.actor && prepared.tx === tx && prepared.workspaceId === params.workspaceId
    && hash(prepared.principal) === hash(principal(params.actor)) && prepared.originIdentity === ambientOriginIdentity(),
    409, "INVALID_INPUT_RECEIPT", "Native control token is not valid for this operation.");
  tokens.delete(token);
  await assertArtifactInputWriteFence(tx);
  const source = await sourceEnvelope(tx, prepared.workspaceId, prepared.sourceId);
  const archive = await generation(tx, prepared.workspaceId, "BrainSource", prepared.sourceId);
  invariant(source?.archivedAt && sourceIdentity(source) === prepared.sourceIdentityHash && archive
    && archive.archivedAt.getTime() === source.archivedAt.getTime()
    && (prepared.mode === "REVIEWED" || archive.id !== prepared.priorSourceGeneration),
  409, "OPERATION_NOT_COMMITTED", "The exact source archive did not complete.");
  const scopes = await requireControl(prepared.actor, prepared.workspaceId, source, prepared.mode, tx);
  const document = source.documentId ? await documentEnvelope(tx, prepared.workspaceId, source.documentId) : null;
  invariant(!source.documentId || document, 409, "SOURCE_CHANGED", "The control document changed.");
  if (document) await unlinkedFinanceArtifact(tx, prepared.workspaceId, "DOCUMENT", document.id);
  const documentArchive = document?.archivedAt ? await generation(tx, prepared.workspaceId, "Document", document.id) : null;
  const control: BrainSourceRemovalControl = { version: 1, sourceId: source.id, sourceArchiveRecordId: archive.id,
    sourceArchivedAt: source.archivedAt.toISOString(), sourceControlHash: sourceControlHash(source), documentId: source.documentId,
    documentArchiveRecordId: documentArchive?.id ?? null, documentControlHash: document ? documentControlHash(document) : null,
    mode: prepared.mode, jobId: prepared.jobId, planIdentityHash: prepared.planIdentityHash, pendingSourceId: params.pendingSourceId ?? null,
    archiveLinkedDocumentRequested: prepared.archiveLinkedDocumentRequested };
  const requestKey = hash([1, prepared.workspaceId, prepared.principal, BRAIN_SOURCE_REMOVAL_COMPLETED, controlIdentity(control)]);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`source-removal-outcome:${prepared.workspaceId}:${requestKey}`}, 0))`;
  invariant(!await tx.conversationOperationOutcome.findFirst({ where: { workspaceId: prepared.workspaceId, requestKey }, select: { id: true } }),
    409, "OPERATION_ALREADY_COMMITTED", "This exact completion already has its native fact.");
  const row = await tx.conversationOperationOutcome.create({ data: { workspaceId: prepared.workspaceId, ...prepared.principal,
    operation: BRAIN_SOURCE_REMOVAL_COMPLETED, requestKey, requiredScopes: scopes, controlJson: control as unknown as Prisma.InputJsonObject } });
  invariant(await isBrainSourceRemovalOutcomeReadable(prepared.actor, prepared.workspaceId, row, tx),
    409, "SOURCE_CHANGED", "Native completion control authority changed.");
  const permissionEpochs = await captureArtifactPermissionEpochs(prepared.actor, prepared.workspaceId,
    [{ kind: "ConversationOperationOutcome", id: row.id, fingerprint: lineageContentFingerprint("ConversationOperationOutcome", row) }], tx);
  await tx.artifactInputLineage.create({ data: { workspaceId: prepared.workspaceId, artifactType: "ConversationOperationOutcome", artifactId: row.id,
    revision: 1, origin: "NATIVE_ORIGINAL", contentHash: lineageContentFingerprint("ConversationOperationOutcome", row), inputsJson: [], rootsJson: [],
    epochProofVersion: 1, permissionEpochsJson: permissionEpochs as unknown as Prisma.InputJsonObject } });
  await assertArtifactInputWriteFence(tx);
  return bind(prepared.actor, prepared.workspaceId, row, tx);
}

/** Exact replay before any archived semantic record/job payload can be consulted. */
export async function findBrainSourceRemovalCompletion(actor: AppActor, params: { workspaceId: string; sourceId?: string; jobId?: string;
  archiveLinkedDocument?: boolean },
  tx: Prisma.TransactionClient) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
  invariant(Boolean(params.sourceId) !== Boolean(params.jobId), 409, "INVALID_REMOVAL_REQUEST", "Choose one canonical completion identity.");
  const rows = await tx.conversationOperationOutcome.findMany({ where: { workspaceId: params.workspaceId, ...principal(actor),
    operation: BRAIN_SOURCE_REMOVAL_COMPLETED, controlJson: { path: [params.sourceId ? "sourceId" : "jobId"], equals: params.sourceId ?? params.jobId } },
    orderBy: { createdAt: "desc" }, take: 2 });
  for (const row of rows) {
    const control = parseControl(row.controlJson);
    if (!control) continue;
    if (params.sourceId && control.archiveLinkedDocumentRequested !== Boolean(params.archiveLinkedDocument)) continue;
    await lockBrainSourceLink(tx, control.sourceId);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${control.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    if (!await isBrainSourceRemovalOutcomeReadable(actor, params.workspaceId, row, tx)) continue;
    await assertArtifactInputWriteFence(tx);
    return bind(actor, params.workspaceId, row, tx, params.sourceId ? "archived" : "applied");
  }
  return null;
}
export function getBrainSourceRemovalOutcomeInputReceipt(value: unknown) {
  return isRecord(value) ? receipts.get(value) : undefined;
}
export async function getBrainSourceRemovalOutcomeInputRoots(actor: AppActor, workspaceId: string, value: object) {
  const receipt = receipts.get(value);
  invariant(receipt, 409, "UNKNOWN_LINEAGE", "Canonical control output has no native fact receipt.");
  return validateConversationInputReceipt({ actor, workspaceId, value, receipt });
}
