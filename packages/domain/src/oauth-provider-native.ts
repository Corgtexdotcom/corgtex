import { createHash, randomUUID } from "node:crypto";
import { Prisma, type OAuthConnection, type OAuthProviderFetchInput } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { fetchSelectedDocuments, fetchFilteredEmailMessages, type OAuthEmailMessage } from "./integrations";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";

type Db = Prisma.TransactionClient | typeof prisma;
type Kind = "documents" | "email";
type Payload = {id: string; sourceKey: string; title: string; text: string; mimeType: string | null; metadata: Record<string, unknown>};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(Boolean) : [];
const section = (connection: OAuthConnection, kind: Kind) => record(record(connection.syncSettings)[kind]);
function selections(connection: OAuthConnection, kind: Kind) {
  const settings = section(connection, kind);
  return strings(kind === "documents" ? settings.selectedDriveIds ?? settings.selectedDocumentIds : settings.filters ?? settings.queries);
}
function grantHash(connection: OAuthConnection) {
  return hash([connection.id, connection.userId, connection.workspaceId, connection.provider, connection.providerAccountId,
    [...connection.scopes].sort(), connection.syncSettings, connection.status, connection.disconnectedAt]);
}
function scopeAllows(connection: OAuthConnection, kind: Kind) {
  const scopes = connection.scopes.map(scope => scope.toLowerCase());
  return kind === "documents" ? connection.provider === "GOOGLE"
    ? scopes.some(scope => ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.readonly"].includes(scope))
    : scopes.some(scope => ["files.read", "sites.read.all"].includes(scope))
    : scopes.includes(connection.provider === "GOOGLE" ? "https://www.googleapis.com/auth/gmail.readonly" : "mail.read");
}
async function authority(workspaceId: string, connectionId: string, kind: Kind, db: Db) {
  const connection = await db.oAuthConnection.findUnique({where: {id: connectionId}});
  invariant(connection && (!connection.workspaceId || connection.workspaceId === workspaceId)
    && connection.status === "ACTIVE" && !connection.disconnectedAt && connection.providerAccountId
    && ["GOOGLE", "MICROSOFT"].includes(connection.provider) && section(connection, kind).enabled === true
    && scopeAllows(connection, kind), 409, "SOURCE_CHANGED", "OAuth source authority is unavailable.");
  const user = await db.user.findUnique({where: {id: connection.userId}});
  invariant(user, 409, "SOURCE_CHANGED", "OAuth source owner is unavailable.");
  const actor: AppActor = {kind: "user", user};
  const member = await requireWorkspaceMembership({actor, workspaceId, tx: db});
  invariant(member?.isActive, 409, "SOURCE_CHANGED", "OAuth source owner is unavailable.");
  return {connection, actor, member};
}
async function fetchPayloads(connectionId: string, kind: Kind, selected: string[], expectedAccountId: string, authorize: () => Promise<void>): Promise<Array<{payload: Payload; selection: string; message?: OAuthEmailMessage}>> {
  if (kind === "documents") return (await fetchSelectedDocuments(connectionId, selected, {authorizeAttempt: authorize, expectedAccountId})).map(doc => ({selection: doc.sourceKey ?? doc.id,
    payload: {id: doc.id, sourceKey: doc.sourceKey ?? doc.id, title: doc.name, text: doc.contentText, mimeType: doc.mimeType,
      metadata: {provider: doc.provider, webUrl: doc.webUrl, modifiedAt: doc.modifiedAt?.toISOString() ?? null}}}));
  return (await fetchFilteredEmailMessages(connectionId, selected, {authorizeAttempt: authorize, expectedAccountId})).map(message => ({selection: message.filter, message,
    payload: {id: message.id, sourceKey: message.id, title: `Email: ${message.subject}`,
      text: [message.subject, message.from ? `From: ${message.from}` : null, message.snippet].filter(Boolean).join("\n\n"), mimeType: "text/plain",
      metadata: {provider: message.provider, webUrl: message.webUrl, from: message.from, receivedAt: message.receivedAt?.toISOString() ?? null}}}));
}

/** Local checks never confer provider authority. The shared preflight performs the remote pass before its final local transaction. */
export async function isOAuthProviderFetchInputLocallyCurrent(actor: AppActor, workspaceId: string, input: OAuthProviderFetchInput, db: Db = prisma) {
  try {
    if (input.workspaceId !== workspaceId || !["documents", "email"].includes(input.sourceKind)) return false;
    await requireWorkspaceMembership({actor, workspaceId, tx: db});
    const current = await authority(workspaceId, input.connectionId, input.sourceKind as Kind, db);
    if (current.connection.userId !== input.localUserId || current.member.id !== input.ownerMemberId
      || current.connection.provider !== input.provider || current.connection.providerAccountId !== input.providerAccountId
      || grantHash(current.connection) !== input.grantHash || !selections(current.connection, input.sourceKind as Kind).includes(input.selection)
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, input.permissionEpochsJson, db)) return false;
    const payload = JSON.parse(decryptSecret(input.encryptedPayload)) as Payload;
    const stored = await db.oAuthProviderFetchInput.findFirst({where: {id: input.id, workspaceId}});
    return !!stored && hash(stored) === hash(input) && hash(payload) === input.payloadHash
      && payload.id === input.externalId && payload.sourceKey === input.sourceKey;
  } catch { return false; }
}
export async function isOAuthProviderFetchInputCurrent(actor: AppActor, workspaceId: string, input: OAuthProviderFetchInput, db: Db = prisma) {
  if (!await isOAuthProviderFetchInputLocallyCurrent(actor, workspaceId, input, db)) return false;
  if (db !== prisma) return (await import("./oauth-provider-read-preflight")).hasOAuthProviderReadCommitAuthority(actor, workspaceId, input, db);
  (await import("./artifact-native-commit-phase")).assertOutsideArtifactNativeCommitPhase();
  const authorize = async () => { invariant(await isOAuthProviderFetchInputLocallyCurrent(actor, workspaceId, input),
    409, "SOURCE_CHANGED", "OAuth source changed before provider access."); };
  try {
    const entries = await fetchPayloads(input.connectionId, input.sourceKind as Kind, [input.selection], input.providerAccountId, authorize);
    const exact = entries.find(entry => entry.payload.id === input.externalId && entry.payload.sourceKey === input.sourceKey
      && entry.selection === input.selection && hash(entry.payload) === input.payloadHash);
    return !!exact && await isOAuthProviderFetchInputLocallyCurrent(actor, workspaceId, input);
  } catch { return false; }
}

/** Only this trusted server path mints native captures; callers never supply a body or receipt id. */
export async function beginOAuthKnowledgeSync(params: {workspaceId: string; connectionId: string; workflowJobId: string; kind: Kind}) {
  const {workspaceId, connectionId, workflowJobId, kind} = params;
  const original = await authority(workspaceId, connectionId, kind, prisma);
  const originalGrant = grantHash(original.connection);
  const originalJob = await prisma.workflowJob.findFirst({where: {id: workflowJobId, workspaceId, type: `oauth.${kind}.sync`, status: "RUNNING"}});
  invariant(originalJob?.lockedAt && originalJob.lockedBy && record(originalJob.payload).connectionId === connectionId,
    409, "SOURCE_CHANGED", "OAuth ingestion requires its active claimed job.");
  const jobStamp = (job: typeof originalJob | null) => job && hash([job.id, job.workspaceId, job.type, job.payload, job.status, job.attempts, job.lockedBy, job.lockedAt, job.startedAt]);
  const originalEpochs = await prisma.$transaction(tx => capturePermissionEpochs(tx, workspaceId, [
    {kind: "Workspace", id: workspaceId}, {kind: "OAuthConnectionPolicy", id: connectionId},
    {kind: "Member", id: original.member.id}, {kind: "MemberUserPolicy", id: original.connection.userId},
    {kind: "WorkspaceSupportPolicy", id: original.connection.userId},
  ]));
  const assertCurrent = async (db: Db = prisma) => {
    if (db !== prisma) {
      await db.$queryRaw`SELECT id FROM "OAuthConnection" WHERE id=${connectionId} FOR SHARE`;
      await db.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id=${workflowJobId} FOR SHARE`;
    }
    const current = await authority(workspaceId, connectionId, kind, db);
    const job = await db.workflowJob.findFirst({where: {id: workflowJobId, workspaceId}});
    invariant(grantHash(current.connection) === originalGrant && current.member.id === original.member.id
      && jobStamp(job) === jobStamp(originalJob) && await isArtifactPermissionEpochProofCurrent(workspaceId, originalEpochs, db),
    409, "SOURCE_CHANGED", "OAuth ingestion authority changed.");
  };
  await assertCurrent();
  const entries = await fetchPayloads(connectionId, kind, selections(original.connection, kind), original.connection.providerAccountId, () => assertCurrent());
  await assertCurrent();
  const documents = [];
  const {captureArtifactInputProof, recordArtifactInputLineage,
    assertArtifactInputWriteFence} = await import("./source-lineage");
  const {prepareArtifactCommitPreflight, withArtifactCommitPreflight} = await import("./artifact-commit-preflight");
  const seen = new Set<string>();
  for (const {payload, selection} of entries) {
    invariant(selections(original.connection, kind).includes(selection), 409, "SOURCE_CHANGED", "OAuth response escaped its selection.");
    if (!payload.text.trim() || seen.has(payload.sourceKey)) continue;
    seen.add(payload.sourceKey);
    const input = await prisma.$transaction(async tx => {
      await assertCurrent(tx);
      return tx.oAuthProviderFetchInput.create({data: {id: randomUUID(), workspaceId, connectionId,
        localUserId: original.connection.userId, ownerMemberId: original.member.id, provider: original.connection.provider,
        providerAccountId: original.connection.providerAccountId, sourceKind: kind, externalId: payload.id, sourceKey: payload.sourceKey,
        selection, grantHash: originalGrant, encryptedPayload: encryptSecret(JSON.stringify(payload)), payloadHash: hash(payload),
        permissionEpochsJson: originalEpochs as unknown as Prisma.InputJsonValue}});
    });
    const proof = await captureArtifactInputProof(original.actor, workspaceId, [{kind: "OAuthProviderFetchInput", id: input.id, snapshot: input}]);
    const preflight = await prepareArtifactCommitPreflight(original.actor, workspaceId, proof);
    const id = `oauth-${hash([workspaceId, connectionId, original.connection.provider, kind, payload.sourceKey])}`;
    const document = await prisma.$transaction(async tx => {
      await assertArtifactInputWriteFence(tx);
      await assertCurrent(tx);
      return withArtifactCommitPreflight(original.actor, workspaceId, tx, proof, preflight, async () => {
        const data = {title: payload.title, textContent: payload.text, source: `OAUTH_${original.connection.provider}_${kind.toUpperCase()}`,
          storageKey: id, mimeType: payload.mimeType, accessDomain: "WORKSPACE" as const,
          metadata: {...payload.metadata, connectionId, nativeInputId: input.id, sourceKind: kind} as Prisma.InputJsonValue};
        const row = await tx.document.upsert({where: {id}, create: {id, workspaceId, ...data}, update: data});
        invariant(row.workspaceId === workspaceId && !row.archivedAt, 409, "SOURCE_CHANGED", "OAuth canonical source is unavailable.");
        await recordArtifactInputLineage({tx, actor: original.actor, workspaceId, artifact: {kind: "Document", id}, content: row,
          origin: "DERIVED", inputs: [], inheritedRoots: proof});
        return row;
      });
    });
    documents.push(document);
  }
  return {actor: original.actor, documents, messages: entries.flatMap(entry => entry.message ? [entry.message] : []), assertCurrent,
    async checkpoint() {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "OAuthConnection" WHERE id=${connectionId} FOR UPDATE`;
        await assertCurrent(tx);
        await tx.oAuthConnection.update({where: {id: connectionId}, data: {lastSyncAt: new Date(), lastSyncError: null}});
      });
    },
  };
}
