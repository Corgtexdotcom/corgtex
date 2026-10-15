import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./errors";
import { Prisma, type MeetingRecording, type RecorderTranscriptAttempt } from "@prisma/client";
import { encryptSecret, env, prisma, type AppActor } from "@corgtex/shared";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";
import { invariant } from "./errors";
import { requireRecallWorkspaceBinding } from "./recall-workspace-bindings";
import { nativeTranscriptPayloadHash } from "./native-transcript-input";
import { getRecorderTranscriptWorkerPurpose, registerRecorderTranscriptWorker, revokeRecorderTranscriptWorker } from "./native-transcript-principal";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint,
  recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { prepareArtifactSourceCommit, withArtifactSourceCommit, type ArtifactSourceCommit } from "./artifact-source-commit";
import type { SourceCommitControlWriteTarget, SourceCommitWriteTarget } from "./source-commit-lock-plan";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import { mergeMeetingTranscript } from "./meetings";
import { prepareMeetingTranscriptProcessingReset } from "./meeting-transcript-processing";

const LEASE_MS = 5 * 60_000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
type Db = Prisma.TransactionClient;
type Origin = { rawBody: string; headers: Headers | Record<string, string>; providerEventId: string; workspaceId?: string } | null;
type Wire = { ordinal: number; url: string; status: number; text: string; authenticated: boolean };
type AttemptState = { actor: AppActor; attempt: RecorderTranscriptAttempt; recording: MeetingRecording; origin: Record<string, unknown>;
  terminal?: { kind: "PUBLICATION" | "EMPTY"; id: string; processedAt: Date | null; failureCode: string | null }; wireOrdinal: number; wires: Wire[]; wireBytes: number; transportBytes: number; streamedOrdinals: Set<number>; apiKey: string; region: string };
declare const attemptBrand: unique symbol;
export type RecorderTranscriptAttemptReceipt = { readonly [attemptBrand]: true };
const attempts = new WeakMap<object, AttemptState>();
const transport = new AsyncLocalStorage<AttemptState>();
const hash = (value: unknown) => nativeTranscriptPayloadHash(value);

function providerBinding(workspaceId: string, provider: string) {
  if (provider === "RECALL_AI") return requireRecallWorkspaceBinding(workspaceId);
  invariant(provider === "MEETING_BAAS" && env.MEETING_BAAS_API_KEY, 503, "RECORDER_VENDOR_NOT_CONFIGURED", "Recorder provider credentials are unavailable.");
  return { apiKey: env.MEETING_BAAS_API_KEY, webhookSecret: env.MEETING_BAAS_WEBHOOK_SECRET,
    providerWorkspaceId: null, region: "meetingbaas" };
}

function bindingHash(workspaceId: string, provider: string, config: { enabled: boolean; defaultProvider: string; fallbackProvider: string | null; providerSettings: unknown }) {
  const binding = providerBinding(workspaceId, provider);
  return hash({ workspaceId, provider, apiKey: binding.apiKey, webhookSecret: binding.webhookSecret,
    providerWorkspaceId: binding.providerWorkspaceId ?? null, region: binding.region,
    config: { enabled: config.enabled, defaultProvider: config.defaultProvider,
      fallbackProvider: config.fallbackProvider, providerSettings: config.providerSettings } });
}

/** Called only by the native HTTP adapter. No response, credential, URL or body is
 * exposed through a model-facing receipt or application log. */
export function reserveRecorderProviderWire() { const state = transport.getStore(); return state ? state.wireOrdinal++ : undefined; }
export function captureRecorderProviderWire(url: string, init: RequestInit, status: number, text: string, ordinal?: number) {
  const state = transport.getStore();
  if (!state) return;
  const bytes = Buffer.byteLength(text);
  state.wireBytes += bytes;
  if (ordinal === undefined || !state.streamedOrdinals.has(ordinal)) state.transportBytes += bytes;
  invariant(state.transportBytes <= MAX_ARTIFACT_BYTES && state.wireBytes <= MAX_ARTIFACT_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Recorder artifact exceeds its native payload bound.");
  const headers = new Headers(init.headers);
  const authenticated = state.attempt.provider === "MEETING_BAAS"
    ? new URL(url).origin === "https://api.meetingbaas.com" && headers.get("x-meeting-baas-api-key") === state.apiKey
    : new URL(url).origin === `https://${state.region}.recall.ai`
      && headers.get("Authorization") === (/^(Token|Bearer)\s+/i.test(state.apiKey) ? state.apiKey : `Token ${state.apiKey}`);
  state.wires.push({ ordinal: ordinal ?? state.wireOrdinal++, url, status, text, authenticated });
}

/** Bound the complete attempt, including parallel/error/discarded responses,
 * before constructing full text. Ordinary provider requests retain their reader. */
export async function readRecorderProviderResponse(response: Response, ordinal?: number): Promise<string> {
  const state = transport.getStore();
  if (!state) return response.text();
  invariant(ordinal !== undefined, 409, "UNKNOWN_LINEAGE", "Recorder transport has no declared request identity.");
  state.streamedOrdinals.add(ordinal);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.transportBytes += value.byteLength;
      invariant(state.transportBytes <= MAX_ARTIFACT_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Recorder artifact exceeds its native transport bound.");
      text.push(decoder.decode(value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

// The trusted adapter seals the exact response branch; discarded/failing wires
// remain immutable custody but do not contribute semantic transcript bytes.
const selectedArtifacts = new WeakMap<object, { state: AttemptState; ordinals: number[] }>();
export function bindRecorderTranscriptArtifact<T extends { transcriptPayload: unknown; metadata: unknown }>(artifact: T, ordinals: Array<number | undefined>): T {
  const state = transport.getStore();
  if (state) {
    invariant(ordinals.length > 0 && ordinals.every(ordinal => typeof ordinal === "number"), 409, "UNKNOWN_LINEAGE", "Recorder response selection is unavailable.");
    selectedArtifacts.set(artifact, { state, ordinals: ordinals as number[] });
  }
  return artifact;
}

async function committedRecorderOccurrence(db: Db, recording: MeetingRecording, own: boolean) {
  const receipts = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT r."id" FROM "MeetingRecording" r
    JOIN "RecorderTranscriptPublication" p ON p."recordingId"=r."id" AND p."workspaceId"=r."workspaceId" AND p."meetingId"=r."meetingId"
    JOIN "RecorderTranscriptAttempt" a ON a."id"=p."attemptId" AND a."workspaceId"=p."workspaceId"
      AND a."recordingId"=r."id" AND a."meetingId"=r."meetingId" AND a."provider"=r."provider"::text
      AND a."externalBotId"=r."externalBotId" AND a."nativeInputId"=p."nativeInputId" AND a."failureCode" IS NULL
    JOIN "NativeTranscriptInput" n ON n."id"=p."nativeInputId" AND n."workspaceId"=p."workspaceId" AND n."mode"='RECORDER'
      AND n."recorderAttemptId"=a."id" AND n."recordingId"=r."id" AND n."recorderMeetingId"=r."meetingId"
      AND n."recorderBindingId"=a."bindingId" AND n."recorderProvider"=a."provider"
    WHERE r."workspaceId"=${recording.workspaceId} AND r."meetingId"=${recording.meetingId} AND r."provider"::text=${recording.provider}
      AND ${own ? Prisma.sql`r."id"=${recording.id}` : Prisma.sql`r."id"<>${recording.id}`}
      AND r."transcriptProcessedAt" IS NOT NULL AND r."failureCode" IS NULL
      ${!own && recording.joinAt ? Prisma.sql`AND r."joinAt"=${recording.joinAt}` : Prisma.empty}
    ORDER BY r."id" LIMIT 1`);
  return receipts[0] ?? null;
}

async function hasVerifiedEmptyReceipt(db: Db, recording: MeetingRecording) {
  if (!recording.transcriptProcessedAt || recording.failureCode !== "RECORDER_TRANSCRIPT_EMPTY") return false;
  const receipts = await db.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "RecorderTranscriptAttempt" a JOIN "NativeTranscriptInput" n ON n."id"=a."nativeInputId"
    WHERE a."workspaceId"=${recording.workspaceId} AND a."recordingId"=${recording.id} AND a."meetingId"=${recording.meetingId}
      AND a."provider"=${recording.provider} AND a."externalBotId"=${recording.externalBotId} AND a."failureCode"='RECORDER_EMPTY'
      AND n."workspaceId"=a."workspaceId" AND n."mode"='RECORDER' AND n."recorderAttemptId"=a."id"
      AND n."recordingId"=a."recordingId" AND n."recorderMeetingId"=a."meetingId" AND n."recorderBindingId"=a."bindingId"
      AND n."recorderProvider"=a."provider" LIMIT 1`;
  return receipts.length > 0;
}

async function configCurrent(workspaceId: string, db: Db) {
  const [config, feature] = await Promise.all([
    db.workspaceMeetingRecorderConfig.findUnique({ where: { workspaceId } }),
    db.workspaceFeatureFlag.findUnique({ where: { workspaceId_flag: { workspaceId, flag: "MEETING_RECORDERS" } } }),
  ]);
  invariant(config?.enabled && feature?.enabled !== false, 409, "SOURCE_RESTRICTED", "Recorder provider authority is disabled.");
  return config;
}

async function assertOwner(state: AttemptState, db: Db) {
  const { attempt } = state;
  await db.$queryRaw`SELECT "id" FROM "RecorderTranscriptClaim" WHERE "id"=${attempt.claimId} FOR UPDATE`;
  const [claim, recording, binding, config, event] = await Promise.all([
    db.recorderTranscriptClaim.findUnique({ where: { id: attempt.claimId } }),
    db.meetingRecording.findUnique({ where: { id: attempt.recordingId } }),
    db.recorderTranscriptBinding.findUnique({ where: { id: attempt.bindingId } }),
    configCurrent(attempt.workspaceId, db),
    attempt.providerEventId ? db.meetingRecorderProviderEvent.findUnique({ where: { id: attempt.providerEventId } }) : null,
  ]);
  const canonical = await committedRecorderOccurrence(db, state.recording, false);
  invariant(!canonical, 409, "SOURCE_CHANGED", "A canonical recorder generation already published this meeting occurrence.");
  const committed = state.terminal?.kind === "PUBLICATION" ? await db.recorderTranscriptPublication.findUnique({ where: { id: state.terminal.id } }) : null;
  const terminalAttempt = state.terminal?.kind === "EMPTY" ? await db.recorderTranscriptAttempt.findUnique({ where: { id: attempt.id } }) : null;
  const ownsTerminal = (committed && committed.attemptId === attempt.id && committed.nativeInputId === state.attempt.nativeInputId
    && committed.recordingId === attempt.recordingId && committed.meetingId === attempt.meetingId && committed.workspaceId === attempt.workspaceId)
    || (terminalAttempt?.failureCode === "RECORDER_EMPTY" && terminalAttempt.nativeInputId === state.attempt.nativeInputId);
  const sameMarkers = recording && ((recording.transcriptProcessedAt?.getTime() ?? null) === (state.recording.transcriptProcessedAt?.getTime() ?? null)
    && recording.failureCode === state.recording.failureCode);
  const exactTerminalMarkers = ownsTerminal && recording && state.terminal
    && (recording.transcriptProcessedAt?.getTime() ?? null) === (state.terminal.processedAt?.getTime() ?? null)
    && recording.failureCode === state.terminal.failureCode;
  invariant(claim && claim.workspaceId === attempt.workspaceId && claim.attemptId === attempt.id
    && claim.generation === attempt.generation && claim.nonce === attempt.nonce && claim.leaseUntil.getTime() > Date.now()
    && recording && recording.workspaceId === attempt.workspaceId && recording.meetingId === attempt.meetingId
    && recording.provider === attempt.provider && recording.externalBotId === attempt.externalBotId
    && (recording.startedAt?.getTime() ?? null) === (state.recording.startedAt?.getTime() ?? null)
    && (recording.joinAt?.getTime() ?? null) === (state.recording.joinAt?.getTime() ?? null)
    && recording.createdAt.getTime() === state.recording.createdAt.getTime()
    && (sameMarkers || exactTerminalMarkers)
    && binding?.provider === attempt.provider && binding.workspaceId === attempt.workspaceId && binding.active && !binding.revokedAt && binding.configurationHash === attempt.configurationHash
    && bindingHash(attempt.workspaceId, attempt.provider, config) === attempt.configurationHash
    && await isArtifactPermissionEpochProofCurrent(attempt.workspaceId, state.origin.permissionEpochs, db)
    && (!attempt.providerEventId || (event && event.workspaceId === attempt.workspaceId && event.recordingId === attempt.recordingId
      && event.provider === attempt.provider && (!event.externalBotId || event.externalBotId === attempt.externalBotId)
      && event.externalEventId === (state.origin.eventIdentity as Record<string, unknown>)?.externalEventId
      && event.eventType === (state.origin.eventIdentity as Record<string, unknown>)?.eventType
      && event.dedupeKey === (state.origin.eventIdentity as Record<string, unknown>)?.dedupeKey
      && hash(event.payload) === (state.origin.eventIdentity as Record<string, unknown>)?.payloadHash)),
  409, "SOURCE_CHANGED", "Recorder claim, target, provider or authenticated event changed.");
}

/** The trusted webhook/recovery adapter claims before fetching. The opaque
 * receipt cannot be minted from a provider label, copied actor or raw payload. */
export async function withRecorderTranscriptAttempt<T>(recording: MeetingRecording, origin: Origin,
  work: (receipt: RecorderTranscriptAttemptReceipt) => Promise<T>): Promise<T | null> {
  invariant(["RECALL_AI", "MEETING_BAAS"].includes(recording.provider) && recording.externalBotId, 409, "UNKNOWN_LINEAGE", "Recorder provider intake is unsupported.");
  let eventIdentity: Record<string, unknown> | null = null;
  if (origin) {
    const { verifyRecallWebhookSignature, normalizeRecallWebhook, verifyMeetingBaasWebhookSignature, normalizeMeetingBaasWebhook, redactProviderArtifactUrls } = await import("./meeting-recorders");
    invariant(recording.provider === "RECALL_AI"
      ? verifyRecallWebhookSignature({ headers: origin.headers, payload: origin.rawBody, workspaceId: origin.workspaceId })
      : verifyMeetingBaasWebhookSignature({ headers: origin.headers, payload: origin.rawBody }),
      401, "INVALID_SIGNATURE", "Recorder intake has no authenticated webhook origin.");
    const event = (recording.provider === "RECALL_AI" ? normalizeRecallWebhook : normalizeMeetingBaasWebhook)(JSON.parse(origin.rawBody));
    invariant(event.externalBotId === recording.externalBotId && (!event.recordingId || event.recordingId === recording.id)
      && (!event.workspaceId || event.workspaceId === recording.workspaceId) && (!event.meetingId || event.meetingId === recording.meetingId)
      && (!origin.workspaceId || origin.workspaceId === recording.workspaceId),
      403, "RECORDER_WEBHOOK_RECORDING_MISMATCH", "Authenticated recorder origin does not bind this exact target.");
    const issuer = recording.provider === "RECALL_AI" && origin.workspaceId ? `RECALL_AI:${origin.workspaceId}` : recording.provider;
    eventIdentity = { externalEventId: event.eventId, eventType: event.eventType,
      dedupeKey: `${issuer}:${event.eventId ?? createHash("sha256").update(origin.rawBody).digest("hex")}`,
      payloadHash: hash(redactProviderArtifactUrls(JSON.parse(origin.rawBody))) };
  }
  const ingress = origin ? { kind: "SIGNED_WEBHOOK", rawBody: origin.rawBody,
    headers: Object.fromEntries([...new Headers(origin.headers).entries()].filter(([key]) => ["svix-id", "svix-timestamp", "svix-signature", "webhook-id", "webhook-timestamp", "webhook-signature", "x-mb-secret"].includes(key))), providerEventId: origin.providerEventId, eventIdentity }
    : { kind: "AUTHENTICATED_RECOVERY", recordingId: recording.id, externalBotId: recording.externalBotId };
  const claimed = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`recorder-claim:${recording.workspaceId}:${recording.id}`},0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`recorder-provider:${recording.workspaceId}:${recording.provider}`},0))`;
    const old = await tx.recorderTranscriptClaim.findUnique({ where: { recordingId: recording.id } });
    if (old) await tx.$queryRaw`SELECT "id" FROM "RecorderTranscriptClaim" WHERE "id"=${old.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "MeetingRecording" WHERE "id"=${recording.id} FOR SHARE`;
    const current = await tx.meetingRecording.findUnique({ where: { id: recording.id } });
    invariant(current && current.workspaceId === recording.workspaceId && current.meetingId === recording.meetingId
      && current.provider === recording.provider && current.externalBotId === recording.externalBotId,
      409, "SOURCE_CHANGED", "Recorder target changed before claim.");
    const target = await tx.meeting.findFirst({ where: { id: current.meetingId, workspaceId: current.workspaceId, archivedAt: null } });
    invariant(target, 409, "RECORDER_WORKSPACE_MISMATCH", "Recorder target does not belong to the recording workspace.");
    if (origin) {
      const event = await tx.meetingRecorderProviderEvent.findUnique({ where: { id: origin.providerEventId } });
      invariant(event && event.workspaceId === current.workspaceId && event.recordingId === current.id && event.provider === current.provider
        && (!event.externalBotId || event.externalBotId === current.externalBotId)
        && event.externalEventId === eventIdentity?.externalEventId && event.eventType === eventIdentity?.eventType
        && event.dedupeKey === eventIdentity?.dedupeKey && hash(event.payload) === eventIdentity?.payloadHash,
        409, "SOURCE_CHANGED", "Authenticated recorder event changed before claim.");
    }
    if (await committedRecorderOccurrence(tx, current, true) || await hasVerifiedEmptyReceipt(tx, current)) return null;
    const canonical = await committedRecorderOccurrence(tx, current, false);
    if (canonical) {
      await tx.meetingRecording.update({ where: { id: current.id }, data: { status: "SKIPPED", activeDedupeKey: null,
        failureCode: "DUPLICATE_RECORDER", failureMessage: `Another recorder already published this meeting occurrence (${canonical.id}).` } });
      return null;
    }
    const config = await configCurrent(recording.workspaceId, tx);
    const configurationHash = bindingHash(recording.workspaceId, recording.provider, config);
    let binding = await tx.recorderTranscriptBinding.findFirst({ where: { workspaceId: recording.workspaceId, provider: recording.provider, active: true } });
    if (binding && binding.configurationHash !== configurationHash) {
      await tx.recorderTranscriptBinding.update({ where: { id: binding.id }, data: { active: false, revokedAt: new Date() } });
      binding = null;
    }
    binding ??= await tx.recorderTranscriptBinding.create({ data: { workspaceId: recording.workspaceId, provider: recording.provider, configurationHash } });
    if (old && old.leaseUntil.getTime() > Date.now()) {
      const published = await tx.recorderTranscriptPublication.findUnique({ where: { attemptId: old.attemptId } });
      if (!published) return { busy: true as const };
    }
    const id = randomUUID(), claimId = old?.id ?? randomUUID(), generation = (old?.generation ?? 0) + 1, nonce = randomUUID();
    await tx.recorderTranscriptClaim.upsert({ where: { recordingId: recording.id },
      create: { id: claimId, workspaceId: recording.workspaceId, recordingId: recording.id, attemptId: id, generation, nonce, leaseUntil: new Date(Date.now()+LEASE_MS) },
      update: { attemptId: id, generation, nonce, leaseUntil: new Date(Date.now()+LEASE_MS) } });
    const originalPolicy = await capturePermissionEpochs(tx, recording.workspaceId, [
      { kind: "Workspace", id: recording.workspaceId }, { kind: "Meeting", id: recording.meetingId },
      { kind: "MeetingRecording", id: recording.id }, { kind: "FeaturePolicy", id: "MEETING_RECORDERS" },
      { kind: "RecorderProviderPolicy", id: recording.provider },
    ]);
    const authenticatedOrigin = { ...ingress, permissionEpochs: originalPolicy };
    const attempt = await tx.recorderTranscriptAttempt.create({ data: { id, workspaceId: recording.workspaceId, claimId,
      recordingId: recording.id, meetingId: recording.meetingId, provider: recording.provider, externalBotId: recording.externalBotId!,
      bindingId: binding.id, configurationHash, generation, nonce, providerEventId: origin?.providerEventId,
      originHash: hash(authenticatedOrigin), encryptedOriginJson: encryptSecret(JSON.stringify(authenticatedOrigin)) } });
    return { attempt, recording: current, origin: authenticatedOrigin };
  });
  if (!claimed) return null;
  if ("busy" in claimed) {
    if (origin) throw new AppError(503, "RECORDER_TRANSCRIPT_BUSY", "Recorder transcript generation is active; retry this event.");
    return null;
  }
  const { attempt } = claimed;
  const binding = providerBinding(recording.workspaceId, recording.provider);
  const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap", label: "native-recorder-transcript-worker",
    workspaceIds: [recording.workspaceId], scopes: ["meetings:write", "support:write"] });
  registerRecorderTranscriptWorker(actor, { workspaceId: attempt.workspaceId, recordingId: attempt.recordingId, meetingId: attempt.meetingId,
    attemptId: attempt.id, claimId: attempt.claimId, generation: attempt.generation, nonce: attempt.nonce, bindingId: attempt.bindingId });
  const state: AttemptState = { actor, attempt, recording: claimed.recording, origin: claimed.origin, wireOrdinal: 0, wires: [], wireBytes: 0, transportBytes: 0, streamedOrdinals: new Set(), apiKey: binding.apiKey, region: binding.region };
  const token = Object.freeze({}) as RecorderTranscriptAttemptReceipt;
  attempts.set(token, state);
  try { return await transport.run(state, () => work(token)); }
  catch (error) {
    const failureCode = error && typeof error === "object" && "code" in error ? String(error.code).slice(0, 100) : "RECORDER_INTAKE_FAILED";
    await prisma.recorderTranscriptAttempt.updateMany({ where: { id: attempt.id, failureCode: null }, data: { failureCode } });
    throw error;
  }
  finally {
    attempts.delete(token); revokeRecorderTranscriptWorker(actor);
    // Release only our exact generation. A crash is recovered by lease expiry.
    await prisma.recorderTranscriptClaim.updateMany({ where: { id: attempt.claimId, attemptId: attempt.id, generation: attempt.generation, nonce: attempt.nonce }, data: { leaseUntil: new Date() } });
  }
}

type PreparedState = { state: AttemptState; roots: LineageRoot[]; source: ArtifactSourceCommit; targets: SourceCommitWriteTarget[];
  controls: SourceCommitControlWriteTarget[]; before: Awaited<ReturnType<typeof prisma.meeting.findFirst>> & {}; transcript: string;
  event: Prisma.EventUncheckedCreateInput; audit: Prisma.AuditLogUncheckedCreateInput;
  progress: ReturnType<typeof prepareMeetingTranscriptProcessingReset>; progressId: string;
  insightIds: string[]; smokeIds: string[]; recordedAt: Date; now: Date; publication: Prisma.RecorderTranscriptPublicationUncheckedCreateInput };
declare const preparedBrand: unique symbol;
export type PreparedRecorderTranscript = { readonly [preparedBrand]: true };
const prepared = new WeakMap<object, PreparedState>();

function control(table: SourceCommitControlWriteTarget["table"], before: Record<string, unknown> | null, after: Record<string, unknown>): SourceCommitControlWriteTarget {
  after = Object.fromEntries(Object.entries(after).filter(([key]) => key !== "updatedAt"));
  return { table, id: String(after.id), before: before && Object.fromEntries(Object.keys(after).map(key => [key, before[key] ?? null])), after };
}

async function captureRecorderOriginal(receipt: RecorderTranscriptAttemptReceipt,
  artifact: { transcriptPayload: unknown; metadata: unknown }) {
  const state = attempts.get(receipt);
  invariant(state, 409, "UNKNOWN_LINEAGE", "Recorder capture receipt is unavailable.");
  const { attempt } = state;
  invariant(!attempt.nativeInputId, 409, "UNKNOWN_LINEAGE", "Recorder attempt already captured its immutable original.");
  const successful = [...state.wires].sort((a,b)=>a.ordinal-b.ordinal).filter(wire => wire.status >= 200 && wire.status < 300);
  const canonicalBot = attempt.provider === "MEETING_BAAS"
    ? `https://api.meetingbaas.com/v2/bots/${encodeURIComponent(attempt.externalBotId)}`
    : `https://${state.region}.recall.ai/api/v1/bot/${attempt.externalBotId}/`;
  invariant(successful.length > 0 && (state.origin.kind === "SIGNED_WEBHOOK" || successful.some(wire => wire.authenticated && (attempt.provider === "MEETING_BAAS" ? wire.url === canonicalBot : wire.url.startsWith(canonicalBot)))),
    409, "UNKNOWN_LINEAGE", "Recorder recovery has no authenticated canonical provider response.");
  for (const wire of successful) if (!wire.authenticated) invariant(
    String(state.origin.rawBody ?? "").includes(wire.url) || successful.some(parent => parent.authenticated && parent.text.includes(wire.url)),
    409, "UNKNOWN_LINEAGE", "Recorder download is not bound to its authenticated origin.");
  const { normalizeProviderTranscript, meetingBaasTranscriptPayload } = await import("./meeting-recorders");
  const incoming = normalizeProviderTranscript(artifact.transcriptPayload).trim();
  const selection = selectedArtifacts.get(artifact);
  invariant(!selection || selection.state === state, 409, "UNKNOWN_LINEAGE", "Recorder artifact belongs to another native attempt.");
  const selected = selection ? selection.ordinals.map(ordinal => {
    const wire = successful.find(candidate => candidate.ordinal === ordinal);
    invariant(wire, 409, "SOURCE_CHANGED", "Selected recorder response is unavailable or failed.");
    return wire;
  }) : successful;
  const responseTranscripts = selected.map(wire => {
    try {
      const body: unknown = JSON.parse(wire.text.replace(/^\uFEFF/, ""));
      if (attempt.provider === "MEETING_BAAS") return normalizeProviderTranscript(meetingBaasTranscriptPayload(body)).trim();
      const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
      return typeof body === "string" || Array.isArray(body) || [record?.segments, record?.transcript, record?.words].some(Array.isArray)
        ? normalizeProviderTranscript(body).trim() : "";
    } catch { return ""; }
  }).filter(Boolean);
  invariant(responseTranscripts.join("\n") === incoming || responseTranscripts.join("\n\n") === incoming,
    409, "SOURCE_CHANGED", "Recorder transcript differs from its exact authenticated provider responses.");
  invariant(incoming.length <= 1_000_000, 413, "TRANSCRIPT_TOO_LARGE", "Recorder transcript is too large.");
  const payload = { workspaceId: attempt.workspaceId, recordingId: attempt.recordingId, meetingId: attempt.meetingId,
    provider: attempt.provider, externalBotId: attempt.externalBotId, attemptId: attempt.id, bindingId: attempt.bindingId,
    origin: state.origin, responses: [...state.wires].sort((a,b)=>a.ordinal-b.ordinal), selectedResponseOrdinals: selected.map(wire => wire.ordinal), artifact, normalizedTranscript: incoming };
  const plaintext = JSON.stringify(payload);
  invariant(Buffer.byteLength(plaintext) <= MAX_ARTIFACT_BYTES, 413, "TRANSCRIPT_TOO_LARGE", "Recorder original exceeds its native payload bound.");
  const input = await prisma.$transaction(async tx => {
    const input = await tx.nativeTranscriptInput.create({ data: { workspaceId: attempt.workspaceId, mode: "RECORDER",
      recordingId: attempt.recordingId, recorderAttemptId: attempt.id, recorderMeetingId: attempt.meetingId,
      recorderBindingId: attempt.bindingId, recorderProvider: attempt.provider,
      encryptedPayloadJson: encryptSecret(plaintext), payloadHash: hash(payload), grantHash: attempt.configurationHash } });
    await tx.recorderTranscriptAttempt.update({ where: { id: attempt.id }, data: { nativeInputId: input.id } });
    return input;
  });
  state.attempt = { ...attempt, nativeInputId: input.id };
  return { state, input, incoming };
}

export async function prepareRecorderTranscript(receipt: RecorderTranscriptAttemptReceipt,
  artifact: { transcriptPayload: unknown; metadata: unknown }, metadata: Prisma.InputJsonValue): Promise<PreparedRecorderTranscript> {
  const { state, input, incoming } = await captureRecorderOriginal(receipt, artifact);
  invariant(incoming.length > 0, 409, "UNKNOWN_LINEAGE", "Empty recorder custody is not a transcript publication.");
  const { actor, attempt } = state;
  // The claimed pre-transport recording is the original timestamp observation.
  const recordedAt = new Date((state.recording.startedAt ?? state.recording.joinAt ?? state.recording.createdAt).getTime());
  const before = await prisma.meeting.findFirst({ where: { id: attempt.meetingId, workspaceId: attempt.workspaceId, archivedAt: null } });
  invariant(before, 409, "SOURCE_CHANGED", "Recorder target meeting is unavailable.");
  const roots = await prisma.$transaction(async tx => {
    await assertOwner(state, tx);
    const native = await captureArtifactInputProof(actor, attempt.workspaceId, [{ kind: "NativeTranscriptInput", id: input.id, snapshot: input }], tx);
    const prior = await captureArtifactInputProof(actor, attempt.workspaceId, [
      { kind: "Meeting", id: before.id, snapshot: before as unknown as Record<string, unknown> },
      ...(before.transcript?.trim() ? [{ kind: "MeetingTranscript" as const, id: before.id }] : []),
    ], tx);
    return [...native, ...await captureImmutableArtifactInputProof(actor, attempt.workspaceId, prior, tx)];
  });
  const now = new Date(), eventId = randomUUID(), auditId = randomUUID();
  const [progressBefore, insights, smokes, providerEvent] = await Promise.all([
    prisma.meetingTranscriptProcessingProgress.findUnique({ where: { meetingId: before.id } }),
    prisma.meetingInsight.findMany({ where: { meetingId: before.id, workspaceId: attempt.workspaceId, status: "SUGGESTED", sourceRecordId: null }, take: 10001 }),
    prisma.meetingRecorderSmokeRun.findMany({ where: { recordingId: attempt.recordingId, workspaceId: attempt.workspaceId, status: { in: ["PENDING", "SCHEDULED", "FAILED"] } }, take: 10001 }),
    attempt.providerEventId ? prisma.meetingRecorderProviderEvent.findUnique({ where: { id: attempt.providerEventId } }) : null,
  ]);
  invariant(insights.length + smokes.length <= 10000, 409, "SOURCE_LOCK_LIMIT", "Recorder publication controls exceed their bounded plan.");
  const transcript = mergeMeetingTranscript(before.transcript, incoming), progressId = progressBefore?.id ?? randomUUID();
  const progress = prepareMeetingTranscriptProcessingReset({ workspaceId: attempt.workspaceId, meetingId: before.id, id: progressId, now });
  const event: Prisma.EventUncheckedCreateInput = { id: eventId, workspaceId: attempt.workspaceId, type: "meeting.transcript-uploaded",
    aggregateType: "Meeting", aggregateId: before.id, payload: { meetingId: before.id, title: before.title, source: `recorder:${attempt.provider.toLowerCase()}`,
      status: "COMPLETED", recordedAt: recordedAt.toISOString(), nativeInputId: state.attempt.nativeInputId, hasTranscript: true, hasIngestionGuidance: Boolean(before.ingestionGuidanceMd), sourceRecordId: null }, availableAt: now, createdAt: now, status: "PENDING", attempts: 0, mcpOrigin: Prisma.JsonNull, supportOriginUserId: null, supportGrantVersion: null, lockedAt: null, lockedBy: null, dispatchedAt: null, error: null };
  const audit: Prisma.AuditLogUncheckedCreateInput = { id: auditId, workspaceId: attempt.workspaceId, actorUserId: null,
    action: "meeting.transcript-uploaded", entityType: "Meeting", entityId: before.id,
    meta: { title: before.title, recordedAt: recordedAt.toISOString(), hasIngestionGuidance: Boolean(before.ingestionGuidanceMd) }, createdAt: now };
  const publication = { id: randomUUID(), workspaceId: attempt.workspaceId, attemptId: attempt.id, nativeInputId: state.attempt.nativeInputId!,
    recordingId: attempt.recordingId, meetingId: attempt.meetingId, providerEventId: attempt.providerEventId,
    eventId, transcriptManifestId: randomUUID(), meetingManifestId: randomUUID(), completePlanHash: "", createdAt: now };
  const currentRecording = await prisma.meetingRecording.findUnique({ where: { id: attempt.recordingId } });
  invariant(currentRecording, 409, "SOURCE_CHANGED", "Recorder target disappeared during preparation.");
  const controls: SourceCommitControlWriteTarget[] = [
    control("MeetingRecording", currentRecording as unknown as Record<string, unknown>, { id: attempt.recordingId, workspaceId: attempt.workspaceId,
      meetingId: attempt.meetingId, provider: attempt.provider, externalBotId: attempt.externalBotId,
      status: "COMPLETED", activeDedupeKey: null, transcriptProcessedAt: now, failureCode: null, failureMessage: null, providerMetadata: metadata }),
    control("MeetingTranscriptProcessingProgress", progressBefore as unknown as Record<string, unknown> | null, { id: progressId, workspaceId: attempt.workspaceId, meetingId: before.id,
      currentStage: "SUMMARIZING", stageStatuses: progress.update.stageStatuses, currentWorkflowJobId: null, currentWorkflowJobType: null,
      currentWorkflowJobStatus: null, attemptCount: 0, safeErrorCode: null, safeErrorMessage: null, startedAt: now, completedAt: null, failedAt: null }),
    control("Event", null, { ...event, mcpOrigin: null } as Record<string, unknown>), control("AuditLog", null, audit as Record<string, unknown>),
    ...smokes.map(smoke => control("MeetingRecorderSmokeRun", smoke as unknown as Record<string, unknown>, { id: smoke.id, workspaceId: attempt.workspaceId,
      recordingId: attempt.recordingId, status: "COMPLETED", completedAt: now, failureMessage: null })),
    ...(providerEvent ? [control("MeetingRecorderProviderEvent", providerEvent as unknown as Record<string, unknown>, { id: providerEvent.id,
      workspaceId: attempt.workspaceId, recordingId: attempt.recordingId, provider: providerEvent.provider, externalEventId: providerEvent.externalEventId, externalBotId: providerEvent.externalBotId, eventType: providerEvent.eventType, dedupeKey: providerEvent.dedupeKey, payload: providerEvent.payload, redactedAt: providerEvent.redactedAt, processedAt: now, error: null })] : []),
  ];
  const targets: SourceCommitWriteTarget[] = [{ kind: "Meeting", id: before.id, projectedAuthority: { status: "COMPLETED" } }, { kind: "MeetingTranscript", id: before.id },
    ...insights.map(insight => ({ kind: "MeetingInsight" as const, id: insight.id, projectedAuthority: insight as unknown as Record<string, unknown> }))];
  publication.completePlanHash = hash({ roots, targets, controls, publication: { ...publication, completePlanHash: undefined }, transcript, recordedAt });
  controls.push(control("RecorderTranscriptPublication", null, publication));
  state.terminal = { kind: "PUBLICATION", id: publication.id, processedAt: now, failureCode: null };
  const source = await prepareArtifactSourceCommit(actor, attempt.workspaceId, roots, { writeTargets: targets, controlWriteTargets: controls,
    ownerBinding: { kind: "RECORDER_TRANSCRIPT", id: attempt.claimId, generation: attempt.generation, attemptId: attempt.id, nonce: attempt.nonce } });
  const token = Object.freeze({}) as PreparedRecorderTranscript;
  prepared.set(token, { state, roots, source, targets, controls, before, transcript, event, audit, progress, progressId,
    insightIds: insights.map(row=>row.id).sort(), smokeIds: smokes.map(row=>row.id).sort(), recordedAt, now, publication });
  return token;
}

export async function publishRecorderTranscript(token: PreparedRecorderTranscript) {
  const value = prepared.get(token);
  invariant(value, 409, "UNKNOWN_LINEAGE", "Recorder publication preparation is unavailable.");
  prepared.delete(token);
  const { state, before, roots, source, targets, controls, publication, now } = value;
  const { actor, attempt } = state;
  const result = await prisma.$transaction(async tx => withArtifactSourceCommit(actor, attempt.workspaceId, tx, roots,
    { writeTargets: targets, controlWriteTargets: controls, ownerBinding: { kind: "RECORDER_TRANSCRIPT", id: attempt.claimId,
      generation: attempt.generation, attemptId: attempt.id, nonce: attempt.nonce } }, source, () => assertOwner(state, tx), async () => {
    const current = await tx.meeting.findUnique({ where: { id: before.id } });
    invariant(current && lineageContentFingerprint("Meeting", current) === lineageContentFingerprint("Meeting", before),
      409, "SOURCE_CHANGED", "Recorder selected meeting changed before publication.");
    const [insights, smokes] = await Promise.all([
      tx.meetingInsight.findMany({ where: { meetingId: before.id, workspaceId: attempt.workspaceId, status: "SUGGESTED", sourceRecordId: null }, select: { id: true }, take: 10001 }),
      tx.meetingRecorderSmokeRun.findMany({ where: { recordingId: attempt.recordingId, workspaceId: attempt.workspaceId, status: { in: ["PENDING", "SCHEDULED", "FAILED"] } }, select: { id: true }, take: 10001 }),
    ]);
    invariant(hash(insights.map(row=>row.id).sort()) === hash(value.insightIds) && hash(smokes.map(row=>row.id).sort()) === hash(value.smokeIds),
      409, "SOURCE_CHANGED", "Recorder publication control membership changed.");
    const meeting = await tx.meeting.update({ where: { id: before.id }, data: { status: "COMPLETED", source: `recorder:${attempt.provider.toLowerCase()}`, transcript: value.transcript, recordedAt: value.recordedAt, aiProcessedAt: null } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: attempt.workspaceId, artifact: { kind: "MeetingTranscript", id: before.id }, content: meetingTranscriptInputProjection(meeting),
      manifestId: publication.transcriptManifestId, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    await recordArtifactInputLineage({ tx, actor, workspaceId: attempt.workspaceId, artifact: { kind: "Meeting", id: before.id }, content: meeting,
      manifestId: publication.meetingManifestId, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    if (value.insightIds.length) await tx.meetingInsight.deleteMany({ where: { id: { in: value.insightIds }, workspaceId: attempt.workspaceId, meetingId: before.id, status: "SUGGESTED", sourceRecordId: null } });
    await tx.meetingTranscriptProcessingProgress.upsert(value.progress);
    await tx.auditLog.create({ data: value.audit });
    await tx.event.create({ data: value.event });
    const recordingControl = controls.find(row=>row.table === "MeetingRecording")!.after!;
    await tx.meetingRecording.update({ where: { id: attempt.recordingId }, data: { status: "COMPLETED", activeDedupeKey: null,
      transcriptProcessedAt: now, failureCode: null, failureMessage: null, providerMetadata: recordingControl.providerMetadata as Prisma.InputJsonValue } });
    if (value.smokeIds.length) await tx.meetingRecorderSmokeRun.updateMany({ where: { id: { in: value.smokeIds }, recordingId: attempt.recordingId, workspaceId: attempt.workspaceId },
      data: { status: "COMPLETED", completedAt: now, failureMessage: null } });
    if (attempt.providerEventId) await tx.meetingRecorderProviderEvent.update({ where: { id: attempt.providerEventId },
      data: { processedAt: now, recordingId: attempt.recordingId, workspaceId: attempt.workspaceId, error: null } });
    const [remainingInsights, remainingSmokes] = await Promise.all([
      tx.meetingInsight.findMany({ where: { meetingId: before.id, workspaceId: attempt.workspaceId, status: "SUGGESTED", sourceRecordId: null }, select: { id: true }, take: 1 }),
      tx.meetingRecorderSmokeRun.findMany({ where: { recordingId: attempt.recordingId, workspaceId: attempt.workspaceId, status: { in: ["PENDING", "SCHEDULED", "FAILED"] } }, select: { id: true }, take: 1 }),
    ]);
    invariant(!remainingInsights.length && !remainingSmokes.length, 409, "SOURCE_CHANGED", "Recorder publication introduced unplanned pending controls.");
    await tx.recorderTranscriptPublication.create({ data: publication });
    const [actualMeeting, meetingManifest, transcriptManifest, latestMeeting, latestTranscript] = await Promise.all([
      tx.meeting.findUnique({ where: { id: before.id } }),
      tx.artifactInputLineage.findUnique({ where: { id: publication.meetingManifestId } }),
      tx.artifactInputLineage.findUnique({ where: { id: publication.transcriptManifestId } }),
      tx.artifactInputLineage.findFirst({ where: { workspaceId: attempt.workspaceId, artifactType: "Meeting", artifactId: before.id }, orderBy: { revision: "desc" } }),
      tx.artifactInputLineage.findFirst({ where: { workspaceId: attempt.workspaceId, artifactType: "MeetingTranscript", artifactId: before.id }, orderBy: { revision: "desc" } }),
    ]);
    const sortedRoots = (value: unknown) => Array.isArray(value) ? [...value].sort((a,b)=>hash([a.kind,a.id]).localeCompare(hash([b.kind,b.id]))) : null;
    const { isArtifactPermissionEpochProofCurrent } = await import("./source-permission-epochs");
    const { isArtifactInputPermissionEpochCoverageComplete } = await import("./source-permission-coverage");
    for (const [kind, manifest, latest] of [["Meeting", meetingManifest, latestMeeting], ["MeetingTranscript", transcriptManifest, latestTranscript]] as const) {
      invariant(manifest && manifest.id === latest?.id && manifest.workspaceId === attempt.workspaceId && manifest.artifactType === kind
        && manifest.artifactId === before.id && manifest.origin === "DERIVED" && manifest.epochProofVersion === 1
        && hash(manifest.inputsJson) === hash([]) && hash(sortedRoots(manifest.rootsJson)) === hash(sortedRoots(roots))
        && await isArtifactPermissionEpochProofCurrent(attempt.workspaceId, manifest.permissionEpochsJson, tx)
        && await isArtifactInputPermissionEpochCoverageComplete({ workspaceId: attempt.workspaceId, artifact: { kind, id: before.id },
          content: kind === "MeetingTranscript" ? meetingTranscriptInputProjection(actualMeeting!) : actualMeeting as unknown as Record<string, unknown>,
          roots, permissionEpochs: manifest.permissionEpochsJson, db: tx }),
        409, "SOURCE_CHANGED", "Recorder complete manifest or its original permissions differ from the prepared plan.");
    }
    const expected = { ...before, status: "COMPLETED", source: `recorder:${attempt.provider.toLowerCase()}`, transcript: value.transcript, recordedAt: value.recordedAt, aiProcessedAt: null };
    invariant(actualMeeting && lineageContentFingerprint("Meeting", actualMeeting) === lineageContentFingerprint("Meeting", expected)
      && meetingManifest?.contentHash === lineageContentFingerprint("Meeting", expected)
      && transcriptManifest?.contentHash === lineageContentFingerprint("MeetingTranscript", meetingTranscriptInputProjection(expected)),
      409, "SOURCE_CHANGED", "Recorder complete published outputs differ from the prepared plan.");
    invariant(await isArtifactInputProofReadable(actor, attempt.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Recorder native input changed after publication.");
    return { committed: true as const, meetingId: before.id, nativeInputId: publication.nativeInputId, eventId: publication.eventId };
  }), { timeout: 120_000 });
  return result;
}

export async function publishEmptyRecorderTranscript(receipt: RecorderTranscriptAttemptReceipt,
  artifact: { transcriptPayload: unknown; metadata: unknown }, metadata: Prisma.InputJsonValue) {
  const { state, input, incoming } = await captureRecorderOriginal(receipt, artifact);
  invariant(!incoming, 409, "SOURCE_CHANGED", "Nonempty provider content cannot be acknowledged as empty.");
  const { actor, attempt } = state;
  const roots = await prisma.$transaction(async tx => {
    await assertOwner(state, tx);
    return captureArtifactInputProof(actor, attempt.workspaceId, [{ kind: "NativeTranscriptInput", id: input.id, snapshot: input }], tx);
  });
  const now = new Date();
  const [recording, storedAttempt, smokes, event] = await Promise.all([
    prisma.meetingRecording.findUniqueOrThrow({ where: { id: attempt.recordingId } }),
    prisma.recorderTranscriptAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    prisma.meetingRecorderSmokeRun.findMany({ where: { workspaceId: attempt.workspaceId, recordingId: attempt.recordingId, status: { in: ["PENDING", "SCHEDULED"] } }, take: 10001 }),
    attempt.providerEventId ? prisma.meetingRecorderProviderEvent.findUniqueOrThrow({ where: { id: attempt.providerEventId } }) : null,
  ]);
  invariant(smokes.length <= 10000, 409, "SOURCE_LOCK_LIMIT", "Empty recorder controls exceed the bounded plan.");
  const late = ["RECORDER_TRANSCRIPT_RECOVERY_EXPIRED", "RECORDER_TRANSCRIPT_FETCH_FAILED", "STALE_RECORDER"].includes(state.recording.failureCode ?? "");
  const after = { id: recording.id, workspaceId: recording.workspaceId, meetingId: recording.meetingId,
    provider: recording.provider, externalBotId: recording.externalBotId, status: late ? "FAILED" : "COMPLETED",
    activeDedupeKey: null, transcriptProcessedAt: late ? recording.transcriptProcessedAt : now,
    failureCode: late ? recording.failureCode : "RECORDER_TRANSCRIPT_EMPTY",
    failureMessage: late ? recording.failureMessage : "Provider transcript was empty.", providerMetadata: metadata };
  const controls: SourceCommitControlWriteTarget[] = [control("MeetingRecording", recording as unknown as Record<string, unknown>, after),
    control("RecorderTranscriptAttempt", storedAttempt as unknown as Record<string, unknown>, { ...storedAttempt, failureCode: "RECORDER_EMPTY" }),
    ...smokes.map(smoke => control("MeetingRecorderSmokeRun", smoke as unknown as Record<string, unknown>, { ...smoke, status: "FAILED", failureMessage: "Provider transcript was empty.", completedAt: now })),
    ...(event ? [control("MeetingRecorderProviderEvent", event as unknown as Record<string, unknown>, { ...event, processedAt: now, error: null })] : [])];
  state.terminal = { kind: "EMPTY", id: attempt.id, processedAt: after.transcriptProcessedAt, failureCode: after.failureCode };
  const options = { writeTargets: [] as SourceCommitWriteTarget[], controlWriteTargets: controls,
    ownerBinding: { kind: "RECORDER_TRANSCRIPT" as const, id: attempt.claimId, generation: attempt.generation, attemptId: attempt.id, nonce: attempt.nonce } };
  const source = await prepareArtifactSourceCommit(actor, attempt.workspaceId, roots, options);
  return prisma.$transaction(async tx => withArtifactSourceCommit(actor, attempt.workspaceId, tx, roots, options, source, () => assertOwner(state, tx), async () => {
    const pending = await tx.meetingRecorderSmokeRun.findMany({ where: { workspaceId: attempt.workspaceId, recordingId: attempt.recordingId, status: { in: ["PENDING", "SCHEDULED"] } }, select: { id: true }, take: 10001 });
    invariant(hash(pending.map(row=>row.id).sort()) === hash(smokes.map(row=>row.id).sort()), 409, "SOURCE_CHANGED", "Empty recorder controls changed.");
    const { id: _id, workspaceId: _workspaceId, meetingId: _meetingId, provider: _provider, externalBotId: _externalBotId, ...data } = after;
    await tx.meetingRecording.update({ where: { id: recording.id }, data: { ...data, status: late ? "FAILED" : "COMPLETED" } });
    await tx.recorderTranscriptAttempt.update({ where: { id: attempt.id }, data: { failureCode: "RECORDER_EMPTY" } });
    if (smokes.length) await tx.meetingRecorderSmokeRun.updateMany({ where: { id: { in: smokes.map(row=>row.id) }, workspaceId: attempt.workspaceId, recordingId: attempt.recordingId }, data: { status: "FAILED", failureMessage: "Provider transcript was empty.", completedAt: now } });
    if (event) await tx.meetingRecorderProviderEvent.update({ where: { id: event.id }, data: { processedAt: now, error: null } });
    return { committed: true as const, empty: true as const, meetingId: attempt.meetingId };
  }), { timeout: 120_000 });
}

/** Committed custody remains eligible independently of worker lease and later
 * ordinary ingestion generations. Original source vectors still govern reads. */
export async function isRecorderTranscriptInputCurrent(actor: AppActor, workspaceId: string,
  input: { id?: string; ownerMemberId: string | null; submittedByUserId: string | null; recordingId: string | null;
    recorderAttemptId?: string | null; recorderMeetingId?: string | null; recorderBindingId?: string | null;
    recorderProvider?: string | null; payloadHash: string; grantHash: string | null }, payload: Record<string, unknown>, db: Db) {
  try {
    if (input.ownerMemberId || input.submittedByUserId || !["RECALL_AI", "MEETING_BAAS"].includes(input.recorderProvider ?? "")) return false;
    const [attempt, binding, recording, config] = await Promise.all([
      db.recorderTranscriptAttempt.findFirst({ where: { id: input.recorderAttemptId ?? "", workspaceId } }),
      db.recorderTranscriptBinding.findFirst({ where: { id: input.recorderBindingId ?? "", workspaceId } }),
      db.meetingRecording.findFirst({ where: { id: input.recordingId ?? "", workspaceId } }), configCurrent(workspaceId, db),
    ]);
    const purpose = getRecorderTranscriptWorkerPurpose(actor, workspaceId);
    if (!attempt || !binding?.active || binding.revokedAt || !recording || (attempt.failureCode && !(attempt.failureCode === "RECORDER_EMPTY" && purpose?.attemptId === attempt.id))
      || attempt.nativeInputId == null || attempt.nativeInputId !== input.id || attempt.bindingId !== input.recorderBindingId || binding.configurationHash !== input.grantHash
      || binding.provider !== attempt.provider || input.recorderProvider !== attempt.provider || payload.provider !== attempt.provider
      || bindingHash(workspaceId, attempt.provider, config) !== input.grantHash || attempt.configurationHash !== input.grantHash
      || attempt.recordingId !== input.recordingId || attempt.meetingId !== input.recorderMeetingId
      || recording.meetingId !== attempt.meetingId || recording.provider !== attempt.provider || recording.externalBotId !== attempt.externalBotId
      || payload.workspaceId !== workspaceId || payload.attemptId !== attempt.id || payload.bindingId !== attempt.bindingId
      || payload.recordingId !== attempt.recordingId || payload.meetingId !== attempt.meetingId || payload.externalBotId !== attempt.externalBotId
      || hash(payload.origin) !== attempt.originHash || !payload.origin || typeof payload.origin !== "object" || Array.isArray(payload.origin)
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, (payload.origin as Record<string, unknown>).permissionEpochs, db)) return false;
    const publication = await db.recorderTranscriptPublication.findUnique({ where: { attemptId: attempt.id } });
    if (publication) {
      if (publication.workspaceId !== workspaceId || publication.nativeInputId !== attempt.nativeInputId
        || publication.recordingId !== attempt.recordingId || publication.meetingId !== attempt.meetingId) return false;
      const original = await db.artifactInputLineage.findUnique({ where: { id: publication.transcriptManifestId } });
      const originalRoots = original?.rootsJson;
      if (!original || original.workspaceId !== workspaceId || original.artifactType !== "MeetingTranscript"
        || original.artifactId !== attempt.meetingId || original.origin !== "DERIVED" || original.epochProofVersion !== 1 || !Array.isArray(originalRoots)) return false;
      const native = originalRoots.find(root => root && typeof root === "object" && !Array.isArray(root)
        && root.kind === "NativeTranscriptInput" && root.id === input.id) as Record<string, unknown> | undefined;
      return Boolean(native && native.fingerprint === lineageContentFingerprint("NativeTranscriptInput", input)
        && await isArtifactPermissionEpochProofCurrent(workspaceId, native.permissionEpochs, db));
    }
    if (!purpose || purpose.attemptId !== attempt.id || purpose.nonce !== attempt.nonce || purpose.generation !== attempt.generation) return false;
    const claim = await db.recorderTranscriptClaim.findUnique({ where: { id: attempt.claimId } });
    return Boolean(claim && claim.workspaceId === workspaceId && claim.attemptId === attempt.id
      && claim.generation === attempt.generation && claim.nonce === attempt.nonce && claim.leaseUntil.getTime() > Date.now());
  } catch { return false; }
}

/** Existing recorder custody may capture its exact restricted meeting; this
 * process-local active attempt conveys no ordinary reader or agent permission. */
export async function isRecorderCategoryCaptureCurrent(actor: AppActor, workspaceId: string, meetingId: string, db: Db) {
  const purpose = getRecorderTranscriptWorkerPurpose(actor, workspaceId);
  if (!purpose || purpose.meetingId !== meetingId) return false;
  const [claim, attempt, binding] = await Promise.all([
    db.recorderTranscriptClaim.findFirst({where: {id: purpose.claimId, workspaceId}}),
    db.recorderTranscriptAttempt.findFirst({where: {id: purpose.attemptId, workspaceId}}),
    db.recorderTranscriptBinding.findFirst({where: {id: purpose.bindingId, workspaceId}}),
  ]);
  if (!claim || !attempt || !binding?.active || binding.revokedAt || claim.attemptId !== purpose.attemptId
    || claim.generation !== purpose.generation || claim.nonce !== purpose.nonce || claim.leaseUntil.getTime() <= Date.now()
    || attempt.meetingId !== meetingId || attempt.recordingId !== purpose.recordingId || attempt.bindingId !== binding.id
    || attempt.generation !== purpose.generation || attempt.nonce !== purpose.nonce || binding.provider !== attempt.provider) return false;
  try { return binding.configurationHash === bindingHash(workspaceId, attempt.provider, await configCurrent(workspaceId, db)); } catch { return false; }
}
