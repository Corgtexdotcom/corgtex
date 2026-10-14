import { Prisma } from "@prisma/client";
import { decryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { bindCompanyTranscriptPublicationHooks, captureCompanyMemberTranscriptInput, nativeTranscriptPayloadHash } from "./native-transcript-input";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";
import { normalizeMeetingTranscriptSourceArtifact, type MeetingTranscriptSourceArtifact } from "./meeting-transcript-sources";
import { isArtifactInputProofReadable, captureArtifactInputProof } from "./source-lineage";

const originals = new WeakMap<MeetingTranscriptSourceArtifact, { actor: AppActor; workspaceId: string; provider: string; hash: string;
  submission: Parameters<typeof intakeMeetingTranscript>[1]; receipt: Awaited<ReturnType<typeof captureCompanyMemberTranscriptInput>> }>();

/** Only the authenticated standalone upload adapter invokes this constructor.
 * Provider labels describe a file format; custody remains the actual member's. */
export async function captureManualTranscriptSourceArtifact(actor: AppActor, params: { workspaceId: string; provider: string; artifact: MeetingTranscriptSourceArtifact }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "Manual transcript imports require an authenticated member.");
  const { normalizeMeetingTranscriptSourceProvider } = await import("./meeting-transcript-sources");
  const provider = normalizeMeetingTranscriptSourceProvider(params.provider);
  let artifact;
  try { artifact = normalizeMeetingTranscriptSourceArtifact(provider, params.artifact); }
  catch (error) {
    // Let the batch retain the invalid original as its own failed diagnostic while
    // valid sibling files continue. An invalid item receives no native authority.
    if (error instanceof AppError && ["INVALID_INPUT", "RECORDED_AT_REQUIRED"].includes(error.code)) return;
    throw error;
  }
  const submission = { workspaceId: params.workspaceId, transcript: artifact.transcript,
    title: artifact.title, recordedAt: artifact.recordedAt, source: "manual-transcript-export",
    externalId: `manual-transcript:${artifact.provider}:${artifact.externalId}`,
    meetingUrl: artifact.meetingUrl, calendarExternalId: artifact.calendarExternalId,
    summaryMd: artifact.provider === "READ_AI" ? null : artifact.summaryMd,
    ingestionGuidanceMd: artifact.ingestionGuidanceMd, participantEmails: artifact.participantEmails,
    originalExport: structuredClone(params.artifact) };
  const receipt = await captureCompanyMemberTranscriptInput(actor, { workspaceId: params.workspaceId, submission });
  originals.set(params.artifact, { actor, workspaceId: params.workspaceId, provider: params.provider,
    hash: nativeTranscriptPayloadHash(params.artifact), submission, receipt });
}
export function hasManualTranscriptSourceArtifact(artifact: MeetingTranscriptSourceArtifact) { return originals.has(artifact); }

export async function publishManualTranscriptSourceArtifact(actor: AppActor, params: { workspaceId: string; batchId: string | null;
  original: MeetingTranscriptSourceArtifact; sourceKind: string }) {
  const selected = originals.get(params.original);
  invariant(selected && selected.actor === actor && selected.workspaceId === params.workspaceId
    && selected.hash === nativeTranscriptPayloadHash(params.original), 409, "UNKNOWN_LINEAGE", "Manual transcript has no exact authenticated member receipt.");
  const { normalizeMeetingTranscriptSourceProvider } = await import("./meeting-transcript-sources");
  const artifact = normalizeMeetingTranscriptSourceArtifact(normalizeMeetingTranscriptSourceProvider(selected.provider), params.original);
  const identity = { workspaceId: params.workspaceId, provider: artifact.provider, externalId: artifact.externalId };
  const previous = await prisma.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  const duplicate = await prisma.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, contentHash: artifact.contentHash, status: { not: "FAILED" } } });
  if (duplicate) {
    const meta = duplicate.rawMetadataJson as { memberNativeInputId?: string } | null;
    const input = meta?.memberNativeInputId ? await prisma.nativeTranscriptInput.findFirst({ where: { id: meta.memberNativeInputId, workspaceId: params.workspaceId, mode: "COMPANY_MEMBER_UPLOAD" } }) : null;
    const binding = input && await prisma.nativeTranscriptPublication.findFirst({ where: { workspaceId: params.workspaceId, nativeInputId: input.id, meetingId: duplicate.meetingId ?? "" } });
    invariant(input && binding && nativeTranscriptPayloadHash(JSON.parse(decryptSecret(input.encryptedPayloadJson)).originalExport) === selected.hash,
      409, "UNKNOWN_LINEAGE", "Existing import has no exact original member publication.");
    const roots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "NativeTranscriptInput", id: input.id }]);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Existing import authority changed.");
    return { status: "skipped" as const, record: duplicate, meeting: null, reason: "duplicate_content" };
  }
  const previousRoots = previous?.meetingId ? await captureArtifactInputProof(actor, params.workspaceId,
    [{ kind: "MeetingTranscript", id: previous.meetingId }]) : [];
  let record: Awaited<ReturnType<typeof prisma.meetingTranscriptSourceRecord.create>> | undefined;
  bindCompanyTranscriptPublicationHooks(actor, selected.receipt, {
    before: async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(identity)},0))`;
      const current = await tx.meetingTranscriptSourceRecord.findFirst({ where: { ...identity, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
      invariant(nativeTranscriptPayloadHash(current) === nativeTranscriptPayloadHash(previous), 409, "SOURCE_CHANGED", "Manual import source changed during preparation.");
      invariant(!previousRoots.length || await isArtifactInputProofReadable(actor, params.workspaceId, previousRoots, tx), 409, "SOURCE_CHANGED", "Previous import authority changed.");
    },
    after: async (tx, meetingId) => {
      record = await tx.meetingTranscriptSourceRecord.create({ data: { ...identity, batchId: params.batchId, meetingId,
        externalRevisionId: artifact.sourceUpdatedAt?.toISOString() ?? artifact.contentHash.slice(0,16),
        title: artifact.title, recordedAt: artifact.recordedAt, sourceUpdatedAt: artifact.sourceUpdatedAt,
        sourceUrl: artifact.sourceUrl, contentHash: artifact.contentHash, transcriptText: artifact.transcript,
        summaryMd: artifact.summaryMd, segmentsJson: artifact.segments as Prisma.InputJsonValue,
        participantsJson: { participants: artifact.participants, participantEmails: artifact.participantEmails } as Prisma.InputJsonValue,
        rawMetadataJson: { ...artifact.rawMetadata, memberNativeInputId: selected.receipt.inputId } as Prisma.InputJsonValue,
        status: "ACTIVE", processedAt: new Date() } });
      if (previous) await tx.meetingTranscriptSourceRecord.update({ where: { id: previous.id }, data: { status: "SUPERSEDED", supersededByRecordId: record.id } });
      await tx.auditLog.create({ data: { workspaceId: params.workspaceId, actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting-transcript-source.imported", entityType: "MeetingTranscriptSourceRecord", entityId: record.id,
        meta: { provider: artifact.provider, externalId: artifact.externalId, meetingId, sourceKind: params.sourceKind } } });
    },
  });
  const result = await intakeMeetingTranscript(actor, { ...selected.submission, nativeReceipt: selected.receipt });
  invariant(result.status !== "needs_clarification" && record, 409, "TRANSCRIPT_CLARIFICATION_REQUIRED", result.message);
  return { status: "imported" as const, record, meeting: result.meeting, reason: null };
}
