import { createVariantModelControls } from "./variant-model-attempt";
import { getMeetingTranscriptWorkerPurpose, isMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";
import { randomUUID } from "node:crypto";
import { Prisma, type MeetingTranscriptSourceConnection, type NativeTranscriptInput } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { nativeTranscriptPayloadHash } from "./native-transcript-payload";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, mergePermissionEpochProofs,
  parsePermissionEpochProof, type PermissionEpochProof } from "./source-permission-epochs";
import { getTranscriptSourceImportPurpose, registerTranscriptSourceImport, revokeTranscriptSourceImport } from "./native-transcript-principal";
import { normalizeMeetingUrl, meetingUrlHash } from "./meeting-urls";
import { canReadInformationCategory } from "./information-category-policy";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint } from "./source-lineage";
import type { MeetingTranscriptSourceArtifact, NormalizedMeetingTranscriptSourceArtifact } from "./meeting-transcript-sources";

const FLAGS = ["MEETING_TRANSCRIPT_SOURCES", "MEETING_RECORDERS"];
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const hash = nativeTranscriptPayloadHash;
/** Early bounded walk avoids serializing a whole duplicated response-page payload
 * after the operation has exhausted its durable-custody budget. JSON escaping
 * is conservatively counted; the actual serialization is also checked below. */
function assertPayloadBudget(value: unknown, remaining: number) {
  const stack = [value]; let used = 0;
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === "string") {
      used += Buffer.byteLength(item) + 2;
      for (let index = 0; index < item.length && used <= remaining; index += 1) {
        const code = item.charCodeAt(index); if (code < 32 || code === 34 || code === 92) used += 5;
      }
    }
    else if (item instanceof Date) used += 26;
    else if (Array.isArray(item)) { used += item.length + 2; for (const child of item) stack.push(child); }
    else if (item && typeof item === "object") { const entries = Object.entries(item); used += entries.length * 2 + 2; for (const [key, child] of entries) stack.push(key, child); }
    else used += 24;
    invariant(used <= remaining, 413, "TRANSCRIPT_TOO_LARGE", "Transcript operation exceeds its aggregate native custody budget.");
  }
  return used;
}

type Db = Prisma.TransactionClient;
type Wire = { url: string; text: string; status: number; kind: "WEBHOOK" | "API" };
type Transport = { connection: MeetingTranscriptSourceConnection; configHash: string; epochs: PermissionEpochProof;
  wires: Wire[]; archives: Map<Wire[], Promise<TransportArchiveHeader>>; bytes: number; capturedBytes: number; active: boolean; caller?: { memberId: string; userId: string; epochs: PermissionEpochProof } };
declare const transportBrand: unique symbol;
export type TranscriptSourceTransport = { readonly [transportBrand]: true };
const transports = new WeakMap<object, Transport>();
const originals = new WeakMap<object, { transport: Transport; artifact: MeetingTranscriptSourceArtifact; wires: Wire[] }>();

export function transcriptConnectionHash(connection: MeetingTranscriptSourceConnection) {
  return hash({ id: connection.id, workspaceId: connection.workspaceId, provider: connection.provider,
    status: connection.status, authMode: connection.authMode, apiKeyEnc: connection.apiKeyEnc,
    accessTokenEnc: connection.accessTokenEnc, refreshTokenEnc: connection.refreshTokenEnc,
    webhookSecretEnc: connection.webhookSecretEnc });
}
async function featureEnabled(workspaceId: string, db: Db) {
  return (await db.workspaceFeatureFlag.findMany({ where: { workspaceId, flag: { in: FLAGS } },
    select: { enabled: true } })).some(row => row.enabled);
}
async function currentTransport(state: Transport, db: Db = prisma) {
  const row = await db.meetingTranscriptSourceConnection.findFirst({ where: { id: state.connection.id,
    workspaceId: state.connection.workspaceId, provider: state.connection.provider, status: "ACTIVE" } });
  const callerCurrent = !state.caller || Boolean(await db.member.findFirst({ where: { id: state.caller.memberId, workspaceId: state.connection.workspaceId, userId: state.caller.userId, isActive: true, role: { in: ["ADMIN", "FACILITATOR"] } } }))
    && await isArtifactPermissionEpochProofCurrent(state.connection.workspaceId, state.caller.epochs, db);
  return state.active && callerCurrent && row && transcriptConnectionHash(row) === state.configHash
    && await featureEnabled(row.workspaceId, db)
    && await isArtifactPermissionEpochProofCurrent(row.workspaceId, state.epochs, db);
}

/** Authentication happens here, before the adapter receives a transport token.
 * The token never crosses a route/model boundary or grants a human identity. */
export async function withTranscriptSourceTransport<T>(actor: AppActor | null, params: {
  workspaceId: string; provider: string;
  webhook?: { rawBody: string; headers: Headers | Record<string, string | string[] | undefined> };
}, work: (token: TranscriptSourceTransport, connection: MeetingTranscriptSourceConnection) => Promise<T>): Promise<T> {
  invariant(["FIREFLIES", "FATHOM", "READ_AI"].includes(params.provider), 400, "UNSUPPORTED_PROVIDER_WEBHOOK", "Transcript provider is unavailable.");
  let caller: Transport["caller"];
  if (!params.webhook) {
    invariant(actor, 403, "SOURCE_RESTRICTED", "Provider backfill requires its authenticated administrator.");
    const member = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN", "FACILITATOR"] });
    invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "Provider backfill requires its authenticated administrator.");
    invariant(member, 403, "SOURCE_RESTRICTED", "Provider backfill requires current workspace membership.");
    caller = { memberId: member.id, userId: actor.user.id, epochs: await prisma.$transaction(tx => capturePermissionEpochs(tx, params.workspaceId, [
      { kind: "Member", id: member.id }, { kind: "MemberUserPolicy", id: actor.user.id }, { kind: "WorkspaceSupportPolicy", id: actor.user.id },
    ])) };
  }
  const connection = await prisma.meetingTranscriptSourceConnection.findFirst({ where: {
    workspaceId: params.workspaceId, provider: params.provider as MeetingTranscriptSourceConnection["provider"], status: "ACTIVE" } });
  invariant(connection && await featureEnabled(params.workspaceId, prisma), 409, "SOURCE_CHANGED", "Transcript connection is unavailable.");
  const wires: Wire[] = [];
  if (params.webhook) {
    invariant(Buffer.byteLength(params.webhook.rawBody) <= MAX_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Transcript webhook exceeds its byte limit.");
    const { verifyMeetingTranscriptWebhookSignature } = await import("./meeting-transcript-sources");
    invariant(connection.webhookSecretEnc && verifyMeetingTranscriptWebhookSignature({ provider: connection.provider,
      rawBody: params.webhook.rawBody, headers: params.webhook.headers, secret: decryptSecret(connection.webhookSecretEnc) }),
    401, "INVALID_SIGNATURE", "Invalid meeting transcript webhook signature.");
    wires.push({ kind: "WEBHOOK", url: `webhook:${connection.provider}`, status: 200, text: params.webhook.rawBody });
  } else invariant(connection.apiKeyEnc, 400, "CREDENTIAL_REQUIRED", "Provider credentials are required.");
  const configHash = transcriptConnectionHash(connection);
  const epochs = await prisma.$transaction(tx => capturePermissionEpochs(tx, params.workspaceId, [
    { kind: "TranscriptConnectionPolicy", id: connection.id }, ...FLAGS.map(id => ({ kind: "FeaturePolicy", id })),
  ]));
  const state: Transport = { connection, configHash, epochs, caller, wires: Object.freeze(wires.map(wire => Object.freeze(wire))) as unknown as Wire[], bytes: wires.reduce((sum, wire) => sum + Buffer.byteLength(wire.text), 0), archives: new Map(), capturedBytes: 0, active: true };
  invariant(await currentTransport(state), 409, "SOURCE_CHANGED", "Transcript authority changed before transport.");
  const token = Object.freeze({}) as TranscriptSourceTransport;
  transports.set(token, state);
  try { return await work(token, connection); }
  finally { state.active = false; transports.delete(token); }
}

/** Canonical authenticated transport; callers cannot supply a fetched response. */
export async function fetchTranscriptSourceJson(token: TranscriptSourceTransport, url: string, options: RequestInit = {}) {
  const state = transports.get(token);
  invariant(state && await currentTransport(state), 409, "SOURCE_CHANGED", "Transcript transport authority changed.");
  const expectedOrigin = state.connection.provider === "FIREFLIES" ? "https://api.fireflies.ai" : "https://api.fathom.ai";
  invariant(["FIREFLIES", "FATHOM"].includes(state.connection.provider) && new URL(url).origin === expectedOrigin
    && state.connection.apiKeyEnc, 409, "UNKNOWN_LINEAGE", "Transcript transport is not a configured provider origin.");
  const headers = new Headers(options.headers);
  const key = decryptSecret(state.connection.apiKeyEnc);
  if (state.connection.provider === "FIREFLIES") headers.set("authorization", `Bearer ${key}`);
  else headers.set("X-Api-Key", key);
  const response = await fetch(url, { ...options, headers, redirect: "error" });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  try {
    if (reader) for (;;) {
      const item = await reader.read();
      if (item.done) break;
      state.bytes += item.value.byteLength;
      invariant(state.bytes <= MAX_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Transcript provider response exceeds its byte limit.");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
  finally { reader?.releaseLock(); }
  const text = parts.join("");
  invariant(await currentTransport(state), 409, "SOURCE_CHANGED", "Transcript authority changed during transport.");
  invariant(response.ok, 502, "PROVIDER_BACKFILL_FAILED", "Transcript provider request failed.");
  // Keep only the current page's selected response alongside its authenticated callback.
  state.wires = Object.freeze([...state.wires.filter(wire => wire.kind === "WEBHOOK"), Object.freeze({ kind: "API" as const, url, status: response.status, text })]) as unknown as Wire[];

  return JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

/** Called by the deterministic adapter immediately after selecting a native
 * response item. Later normalization cannot substitute another caller object. */
export function bindTranscriptSourceArtifact(token: TranscriptSourceTransport, artifact: MeetingTranscriptSourceArtifact) {
  const state = transports.get(token);
  invariant(state?.active && state.wires.length > 0, 409, "UNKNOWN_LINEAGE", "Transcript artifact has no authenticated transport.");
  originals.set(artifact, { transport: state, artifact: structuredClone(artifact), wires: state.wires });
  return artifact;
}

export function hasAuthenticatedTranscriptSourceArtifact(artifact: MeetingTranscriptSourceArtifact) {
  return originals.get(artifact)?.transport.active === true;
}

/** Failed diagnostics consume the same durable-custody budget. No rejected
 * original is copied after admission is exhausted. Existing rows are untouched. */
export function admitTranscriptSourceFailure(artifact: MeetingTranscriptSourceArtifact) {
  const selected = originals.get(artifact);
  if (!selected) return true;
  try {
    selected.transport.capturedBytes += assertPayloadBudget([artifact, artifact, artifact], MAX_CAPTURE_BYTES - selected.transport.capturedBytes);
    return true;
  } catch { return false; }
}

type TransportArchiveHeader = { id: string; wireHash: string; cipherHash: string; byteSize: number; epochs: PermissionEpochProof };
async function archiveWires(state: Transport, wires: Wire[]): Promise<TransportArchiveHeader> {
  const previous = state.archives.get(wires);
  if (previous) return previous;
  const create = async () => {
    assertPayloadBudget(wires, Math.floor((MAX_CAPTURE_BYTES - state.capturedBytes - 64) * 0.75));
    const plaintext = JSON.stringify(wires), byteSize = Buffer.byteLength(plaintext);
    const encryptedWiresJson = encryptSecret(plaintext), wireHash = hash(wires);
    state.capturedBytes += Buffer.byteLength(encryptedWiresJson);
    return prisma.$transaction(async tx => {
      invariant(await currentTransport(state, tx), 409, "SOURCE_CHANGED", "Transcript archive authority changed.");
      const row = await tx.transcriptTransportArchive.create({ data: { workspaceId: state.connection.workspaceId,
        connectionId: state.connection.id, provider: state.connection.provider, configurationHash: state.configHash,
        wireHash, byteSize, encryptedWiresJson }, select: { id: true, wireHash: true, cipherHash: true, byteSize: true } });
      const epochs = await capturePermissionEpochs(tx, state.connection.workspaceId, [{ kind: "TranscriptTransportArchive", id: row.id }]);
      return { ...row, epochs };
    });
  };
  const promise = create(); state.archives.set(wires, promise); return promise;
}

export type ProviderTranscriptPayload = {
  version: 1; connectionId: string; provider: string; externalId: string; workspaceId: string;
  recordId: string; meetingId: string; manifestId: string; configHash: string; epochs: PermissionEpochProof;
  archive: TransportArchiveHeader; artifact: NormalizedMeetingTranscriptSourceArtifact; record: Record<string, unknown>;
};
export function decodeProviderTranscriptInput(input: { encryptedPayloadJson?: unknown; payloadHash?: unknown }) {
  try {
    if (typeof input.encryptedPayloadJson !== "string") return null;
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson)) as ProviderTranscriptPayload;
    if (payload.version !== 1 || hash(payload) !== input.payloadHash || !parsePermissionEpochProof(payload.epochs)
      || ![payload.connectionId, payload.workspaceId, payload.recordId, payload.meetingId, payload.manifestId].every(value => typeof value === "string" && value.length > 0)) return null;
    return payload;
  } catch { return null; }
}
const pending = new WeakMap<AppActor, { inputId: string; payloadHash: string; transport: Transport; published: boolean }>();

export async function isProviderTranscriptInputCurrent(actor: AppActor, workspaceId: string,
  input: NativeTranscriptInput, db: Db) {
  const payload = decodeProviderTranscriptInput(input);
  if (!payload || input.workspaceId !== workspaceId || payload.workspaceId !== workspaceId || input.mode !== "PROVIDER_IMPORT"
    || input.ownerMemberId != null || input.submittedByUserId != null || input.recordingId != null || input.meetingAudioAssetId != null
    || input.connectionId !== payload.connectionId || input.sourceRecordId !== payload.recordId || input.grantHash !== payload.configHash) return false;
  if (!payload.archive || input.transportArchiveId !== payload.archive.id) return false;
  const archive = await db.transcriptTransportArchive.findFirst({ where: { id: payload.archive.id, workspaceId,
    connectionId: payload.connectionId, provider: payload.provider, configurationHash: payload.configHash },
    select: { id: true, wireHash: true, cipherHash: true, byteSize: true } });
  if (!archive || hash(archive) !== hash({ id: payload.archive.id, wireHash: payload.archive.wireHash,
    cipherHash: payload.archive.cipherHash, byteSize: payload.archive.byteSize })
    || !await isArtifactPermissionEpochProofCurrent(workspaceId, payload.archive.epochs, db)) return false;
  const connection = await db.meetingTranscriptSourceConnection.findFirst({ where: { id: payload.connectionId, workspaceId, status: "ACTIVE" } });
  if (!connection || connection.provider !== payload.provider || transcriptConnectionHash(connection) !== payload.configHash
    || !await featureEnabled(workspaceId, db) || !await isArtifactPermissionEpochProofCurrent(workspaceId, payload.epochs, db)) return false;
  const purpose = getTranscriptSourceImportPurpose(actor, workspaceId), preparing = pending.get(actor);
  if (purpose?.inputId === input.id && purpose.recordId === payload.recordId && purpose.meetingId === payload.meetingId
    && preparing?.published === false && preparing.inputId === input.id && preparing.payloadHash === input.payloadHash && preparing.transport.active) return true;
  if (getMeetingTranscriptWorkerPurpose(actor, workspaceId) && !await isMeetingTranscriptWorkerCurrent(actor, workspaceId,
    { meetingId: payload.meetingId, inputId: input.id }, db === prisma ? undefined : db)) return false;
  const [record, manifest, meeting] = await Promise.all([
    db.meetingTranscriptSourceRecord.findFirst({ where: { id: payload.recordId, workspaceId } }),
    db.artifactInputLineage.findFirst({ where: { id: payload.manifestId, workspaceId, artifactType: "MeetingTranscript", artifactId: payload.meetingId } }),
    db.meeting.findFirst({ where: { id: payload.meetingId, workspaceId, archivedAt: null } }),
  ]);
  if (!record || !["ACTIVE", "SUPERSEDED"].includes(record.status) || !meeting
    || hash(Object.fromEntries(Object.keys(payload.record).map(key => [key, (record as unknown as Record<string, unknown>)[key] ?? null]))) !== hash(payload.record)
    || !await canReadInformationCategory(actor, workspaceId, meeting.informationCategory, db)
    || !manifest || manifest.origin !== "DERIVED" || manifest.epochProofVersion !== 1
    || !await isArtifactPermissionEpochProofCurrent(workspaceId, manifest.permissionEpochsJson, db)) return false;
  const vector = parsePermissionEpochProof(manifest.permissionEpochsJson);
  if (!vector?.entries.some(entry => entry.kind === "Meeting" && entry.id === payload.meetingId)
    || !payload.epochs.entries.every(entry => vector.entries.some(current => current.kind === entry.kind && current.id === entry.id && current.epoch === entry.epoch))) return false;
  const roots = manifest.rootsJson as unknown;
  return Array.isArray(roots) && roots.some(root => root && typeof root === "object" && root.kind === "NativeTranscriptInput"
    && root.id === input.id && root.fingerprint === lineageContentFingerprint("NativeTranscriptInput", input)
    && parsePermissionEpochProof(root.permissionEpochs));
}

/** Authenticated adapters enter here; arbitrary artifact arrays have no entry
 * in originals and cannot construct native provider authority. */
export async function publishTranscriptSourceArtifact(params: {
  original: MeetingTranscriptSourceArtifact; artifact: NormalizedMeetingTranscriptSourceArtifact;
  workspaceId: string; connectionId: string; batchId: string; sourceKind: string; meetingId: string | null;
}) {
  const selected = originals.get(params.original);
  invariant(selected && selected.transport.active && hash(selected.artifact) === hash(params.original)
    && selected.transport.connection.id === params.connectionId && selected.transport.connection.workspaceId === params.workspaceId,
  409, "UNKNOWN_LINEAGE", "Transcript import has no exact authenticated provider selection.");
  const { normalizeMeetingTranscriptSourceArtifact } = await import("./meeting-transcript-sources");
  invariant(hash(normalizeMeetingTranscriptSourceArtifact(selected.transport.connection.provider, selected.artifact)) === hash(params.artifact)
    && await currentTransport(selected.transport), 409, "SOURCE_CHANGED", "Transcript normalization or authority changed.");
  assertPayloadBudget([selected.artifact, params.artifact], MAX_CAPTURE_BYTES - selected.transport.capturedBytes);
  const artifact = structuredClone(params.artifact), workspaceId = params.workspaceId;
  const identity = { workspaceId, provider: artifact.provider, externalId: artifact.externalId };
  const active = await prisma.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, status: "ACTIVE" }, orderBy: [{ sourceUpdatedAt: "desc" }, { createdAt: "desc" }] });
  const duplicate = await prisma.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, contentHash: artifact.contentHash, status: { not: "FAILED" } } });
  const validateDuplicate = async (duplicate: import("@prisma/client").MeetingTranscriptSourceRecord, db: Db) => {
    const native = await db.nativeTranscriptInput.findFirst({ where: { workspaceId, mode: "PROVIDER_IMPORT", sourceRecordId: duplicate.id, connectionId: params.connectionId } });
    const reader: AppActor = { kind: "agent", authProvider: "bootstrap", label: "authenticated-transcript-deduplication", workspaceIds: [workspaceId] };
    invariant(native && duplicate.processedAt && await isProviderTranscriptInputCurrent(reader, workspaceId, native, db),
      409, "UNKNOWN_LINEAGE", "Existing transcript content has no current native publication; it cannot be adopted by deduplication.");
    invariant(await currentTransport(selected.transport, db), 409, "SOURCE_CHANGED", "Transcript operation authority changed during duplicate validation.");
    return { status: "skipped" as const, record: duplicate, meeting: null, reason: "duplicate_content" };
  };
  if (duplicate) return validateDuplicate(duplicate, prisma);
  const incomingTime = (artifact.sourceUpdatedAt ?? artifact.recordedAt).getTime();
  const activeTime = active && (active.sourceUpdatedAt ?? active.recordedAt).getTime();
  invariant(activeTime == null || incomingTime >= activeTime, 409, "SOURCE_CHANGED", "An older provider revision cannot replace the current transcript.");
  const meetingId = active?.meetingId ?? params.meetingId ?? randomUUID();
  const before = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId, archivedAt: null } });
  invariant(!active?.meetingId || before, 409, "SOURCE_CHANGED", "The provider's current meeting is unavailable.");
  const recordId = randomUUID(), inputId = randomUUID(), manifestId = randomUUID(), operationId = randomUUID();
  const now = new Date();
  const record = { id: recordId, workspaceId, connectionId: params.connectionId, meetingId,
    provider: artifact.provider, externalId: artifact.externalId, externalRevisionId: artifact.sourceUpdatedAt?.toISOString() ?? artifact.contentHash.slice(0, 16),
    title: artifact.title, recordedAt: artifact.recordedAt, sourceUpdatedAt: artifact.sourceUpdatedAt,
    sourceUrl: artifact.sourceUrl, contentHash: artifact.contentHash, transcriptText: artifact.transcript,
    summaryMd: artifact.summaryMd, segmentsJson: artifact.segments.length ? artifact.segments : null,
    participantsJson: { participants: artifact.participants, participantEmails: artifact.participantEmails }, rawMetadataJson: artifact.rawMetadata,
    createdAt: now };
  const recordEpoch = await prisma.$transaction(tx => capturePermissionEpochs(tx, workspaceId,
    [{ kind: "TranscriptSourceRecordPolicy", id: recordId }]));
  const archive = await archiveWires(selected.transport, selected.wires);
  const payload: ProviderTranscriptPayload = { version: 1, workspaceId, provider: artifact.provider, externalId: artifact.externalId,
    connectionId: params.connectionId, recordId, meetingId, manifestId, configHash: selected.transport.configHash,
    epochs: mergePermissionEpochProofs(selected.transport.epochs, recordEpoch, archive.epochs)!, archive, artifact, record };
  invariant(await currentTransport(selected.transport), 409, "SOURCE_CHANGED", "Transcript authority changed before capture.");
  const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap", label: "native-transcript-source-import",
    workspaceIds: Object.freeze([workspaceId]) as unknown as string[], scopes: Object.freeze(["meetings:write"]) as unknown as string[] });
  registerTranscriptSourceImport(actor, { workspaceId, connectionId: params.connectionId, inputId, recordId, meetingId, operationId, callerMemberId: selected.transport.caller?.memberId, callerUserId: selected.transport.caller?.userId });
  try {
    // The source record persists another projection beside the sealed native
    // ciphertext. Charge it too, including its small operational field envelope.
    const recordBytes = assertPayloadBudget(record, MAX_CAPTURE_BYTES - selected.transport.capturedBytes) + 2048;
    assertPayloadBudget(payload, Math.floor((MAX_CAPTURE_BYTES - selected.transport.capturedBytes - recordBytes - 64) * 0.75));
    const plaintext = JSON.stringify(payload);
    const encryptedPayloadJson = encryptSecret(plaintext);
    selected.transport.capturedBytes += Buffer.byteLength(encryptedPayloadJson) + recordBytes;
    invariant(selected.transport.capturedBytes <= MAX_CAPTURE_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Transcript operation exceeds its aggregate native custody budget.");
    pending.set(actor, { inputId, payloadHash: hash(payload), transport: selected.transport, published: false });
    const input = await prisma.nativeTranscriptInput.create({ data: { id: inputId, workspaceId, mode: "PROVIDER_IMPORT",
      sourceRecordId: recordId, connectionId: params.connectionId, transportArchiveId: archive.id, encryptedPayloadJson,
      payloadHash: hash(payload), grantHash: payload.configHash } });
    const { captureImmutableArtifactInputProof, recordArtifactInputLineage } = await import("./source-lineage");
    const { prepareArtifactSourceCommit, withArtifactSourceCommit } = await import("./artifact-source-commit");
    const { meetingTranscriptInputProjection } = await import("./meeting-intelligence-context");
    const { prepareMeetingTranscriptProcessingReset } = await import("./meeting-transcript-processing");
    const { inferMeetingTranscriptMetadata } = await import("./meeting-transcript-intake");
    const roots = await prisma.$transaction(async tx => {
      const native = await captureArtifactInputProof(actor, workspaceId, [{ kind: "NativeTranscriptInput", id: inputId, snapshot: input }], tx);
      const prior = before ? await captureArtifactInputProof(actor, workspaceId, [{ kind: "Meeting", id: meetingId, snapshot: before }], tx) : [];
      return [...native, ...(prior.length ? await captureImmutableArtifactInputProof(actor, workspaceId, prior, tx) : [])];
    });
    const modelRoots = structuredClone(roots);
    const modelAttempt = createVariantModelControls(async () => {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, modelRoots),
        409, "SOURCE_CHANGED", "Provider transcript metadata authority changed.");
    });
    const inferred = await inferMeetingTranscriptMetadata({ modelControls: modelAttempt.controls, workspaceId, transcript: artifact.transcript,
      title: before?.title ?? artifact.title, recordedAt: before?.recordedAt ?? artifact.recordedAt,
      participantEmails: [...(before?.participantEmails ?? []), ...artifact.participantEmails], source: `meeting-transcript:${artifact.provider.toLowerCase()}` });
    invariant(inferred.recordedAt && await isArtifactInputProofReadable(actor, workspaceId, roots), 409, "SOURCE_CHANGED", "Transcript sources changed during metadata preparation.");
    const [progressBefore, staleInsights] = await Promise.all([
      prisma.meetingTranscriptProcessingProgress.findUnique({ where: { meetingId } }),
      prisma.meetingInsight.findMany({ where: { workspaceId, meetingId, status: "SUGGESTED", sourceRecordId: null }, take: 10001 }),
    ]);
    invariant(staleInsights.length <= 10000, 409, "SOURCE_LOCK_LIMIT", "Transcript publication exceeds its bounded control plan.");
    const progressId = progressBefore?.id ?? randomUUID();
    const progress = prepareMeetingTranscriptProcessingReset({ workspaceId, meetingId, id: progressId, now });
    const normalizedUrl = before?.meetingUrl ?? (artifact.meetingUrl ? normalizeMeetingUrl(artifact.meetingUrl) : null);
    const meetingData = { status: "COMPLETED" as const, title: inferred.title, source: inferred.source,
      recordedAt: inferred.recordedAt, transcript: artifact.transcript.trim(),
      summaryMd: artifact.provider === "READ_AI" ? null : artifact.summaryMd,
      ingestionGuidanceMd: artifact.ingestionGuidanceMd ?? before?.ingestionGuidanceMd ?? null,
      participantIds: before?.participantIds ?? [], participantEmails: inferred.participantEmails,
      externalId: before?.externalId ?? `workspace:${workspaceId}:meeting-transcript:${artifact.provider}:${artifact.externalId}`,
      calendarExternalId: before?.calendarExternalId ?? artifact.calendarExternalId,
      meetingUrl: normalizedUrl, meetingUrlHash: normalizedUrl ? meetingUrlHash(normalizedUrl) : null, aiProcessedAt: null };
    const event = { id: randomUUID(), workspaceId, type: before ? "meeting.transcript-uploaded" : "meeting.created",
      aggregateType: "Meeting", aggregateId: meetingId, payload: { meetingId, title: meetingData.title, source: meetingData.source,
        status: "COMPLETED", hasTranscript: true, hasIngestionGuidance: Boolean(meetingData.ingestionGuidanceMd), sourceRecordId: recordId },
      status: "PENDING" as const, attempts: 0, availableAt: now, createdAt: now,
      mcpOrigin: null, supportOriginUserId: null, supportGrantVersion: null, lockedAt: null, lockedBy: null, dispatchedAt: null, error: null };
    const audit = { id: randomUUID(), workspaceId, actorUserId: null, action: "meeting-transcript-source.imported",
      entityType: "MeetingTranscriptSourceRecord", entityId: recordId, createdAt: now,
      meta: { provider: artifact.provider, externalId: artifact.externalId, meetingId, sourceKind: params.sourceKind, supersededRecordId: active?.id ?? null } };
    const withoutUpdatedAt = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "updatedAt"));
    const recordAfter = { ...record, batchId: params.batchId, status: "ACTIVE", supersededByRecordId: null, processedAt: now, error: null };
    const controls: import("./source-commit-lock-plan").SourceCommitControlWriteTarget[] = [
      { table: "MeetingTranscriptSourceRecord", id: recordId, before: null, after: recordAfter },
      ...(active ? [{ table: "MeetingTranscriptSourceRecord" as const, id: active.id, before: withoutUpdatedAt(active),
        after: { ...withoutUpdatedAt(active), status: "SUPERSEDED", supersededByRecordId: recordId } }] : []),
      { table: "MeetingTranscriptProcessingProgress", id: progressId, before: progressBefore && withoutUpdatedAt(progressBefore),
        after: { id: progressId, workspaceId, meetingId, currentStage: "SUMMARIZING", stageStatuses: progress.update.stageStatuses,
          currentWorkflowJobId: null, currentWorkflowJobType: null, currentWorkflowJobStatus: null, attemptCount: 0,
          safeErrorCode: null, safeErrorMessage: null, startedAt: now, completedAt: null, failedAt: null } },
      { table: "Event", id: event.id, before: null, after: event }, { table: "AuditLog", id: audit.id, before: null, after: audit },
    ];
    const targets: import("./source-commit-lock-plan").SourceCommitWriteTarget[] = [
      { kind: "Meeting", id: meetingId, projectedAuthority: { ...before, ...meetingData, workspaceId, informationCategory: before?.informationCategory ?? "GENERAL" } },
      { kind: "MeetingTranscript", id: meetingId, projectedAuthority: { ...meetingData, status: undefined, workspaceId, informationCategory: before?.informationCategory ?? "GENERAL", archivedAt: before?.archivedAt ?? null } },
      ...staleInsights.map(row => ({ kind: "MeetingInsight" as const, id: row.id, projectedAuthority: row })),
    ];
    const ownerBinding = { kind: "TRANSCRIPT_SOURCE_IMPORT" as const, id: operationId, generation: 1, inputId, recordId, connectionId: params.connectionId };
    const options = { writeTargets: targets, controlWriteTargets: controls, ownerBinding };
    const source = await prepareArtifactSourceCommit(actor, workspaceId, roots, options);
    const assertOwner = async (tx: Db) => {
      invariant(pending.get(actor)?.inputId === inputId && await currentTransport(selected.transport, tx), 409, "SOURCE_CHANGED", "Transcript operation authority expired.");
    };
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["transcript-source", workspaceId, artifact.provider, artifact.externalId])}, 0))`;
      const committedDuplicate = await tx.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, contentHash: artifact.contentHash, status: { not: "FAILED" } } });
      if (committedDuplicate) return validateDuplicate(committedDuplicate, tx);
      const live = await tx.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, status: "ACTIVE" }, orderBy: [{ sourceUpdatedAt: "desc" }, { createdAt: "desc" }] });
      invariant(hash(live) === hash(active), 409, "SOURCE_CHANGED", "A concurrent provider revision changed the active source.");
      const result = await withArtifactSourceCommit(actor, workspaceId, tx, roots, options, source, assertOwner, async () => {
        const current = await tx.meeting.findFirst({ where: { id: meetingId, workspaceId } });
        invariant(hash(current) === hash(before), 409, "SOURCE_CHANGED", "The selected meeting changed before transcript publication.");
        const meeting = before
          ? await tx.meeting.update({ where: { id: meetingId }, data: meetingData })
          : await tx.meeting.create({ data: { id: meetingId, workspaceId, ...meetingData } });
        const createdRecord = await tx.meetingTranscriptSourceRecord.create({ data: {
          ...recordAfter, provider: artifact.provider, status: "ACTIVE", segmentsJson: record.segmentsJson ?? Prisma.JsonNull,
          participantsJson: record.participantsJson as Prisma.InputJsonValue, rawMetadataJson: record.rawMetadataJson as Prisma.InputJsonValue,
        } });
        if (active) await tx.meetingTranscriptSourceRecord.update({ where: { id: active.id }, data: { status: "SUPERSEDED", supersededByRecordId: recordId } });
        await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "MeetingTranscript", id: meetingId },
          content: meetingTranscriptInputProjection(meeting), manifestId, origin: "DERIVED", inputs: [], inheritedRoots: roots });
        await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "Meeting", id: meetingId },
          content: meeting, origin: "DERIVED", inputs: [], inheritedRoots: roots });
        if (staleInsights.length) await tx.meetingInsight.deleteMany({ where: { workspaceId, id: { in: staleInsights.map(row => row.id) }, status: "SUGGESTED", sourceRecordId: null } });
        await tx.meetingTranscriptProcessingProgress.upsert(progress);
        await tx.event.create({ data: { ...event, mcpOrigin: Prisma.JsonNull } });
        await tx.auditLog.create({ data: audit });
        invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Transcript input authority changed during publication.");
        return { status: "imported" as const, record: createdRecord, meeting, reason: null };
      });
      pending.get(actor)!.published = true;
      invariant(await isProviderTranscriptInputCurrent(actor, workspaceId, input, tx), 409, "SOURCE_CHANGED", "The committed native publication is incomplete or no longer authorized.");
      return result;
    });
  } finally { pending.delete(actor); revokeTranscriptSourceImport(actor); }
}
