import { currentCompanyTranscriptPublicationScope } from "./native-transcript-publication-context";
import { getMeetingTranscriptWorkerPurpose, isMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";
import type { ArtifactInputLineage, NativeTranscriptInput, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { nativeTranscriptPayloadHash } from "./native-transcript-payload";
import { lineageContentFingerprint } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";
import { canReadInformationCategory } from "./information-category-policy";
import { hasActiveSourceCommitLockPlan, assertSourceCommitRowCovered } from "./source-commit-lock-plan";

/** Legacy meeting writers have a real interactive transaction, not a complete
 * source lock plan. Lock their native receipt, uploader and chosen target here. */
export async function lockCompanyTranscriptPublication(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, meetingId?: string) {
  const scope = currentCompanyTranscriptPublicationScope(actor, workspaceId);
  if (!scope) return;
  await scope.hooks?.before(tx);
  invariant(!hasActiveSourceCommitLockPlan(tx), 409, "SOURCE_LOCK_UNSUPPORTED", "Company transcript publication requires its declared writer transaction.");
  await tx.$queryRaw`SELECT "id" FROM "NativeTranscriptInput" WHERE "id"=${scope.inputId} AND "workspaceId"=${workspaceId} FOR SHARE`;
  const input = await tx.nativeTranscriptInput.findFirst({ where: { id: scope.inputId, workspaceId } });
  invariant(input && input.mode === "COMPANY_MEMBER_UPLOAD" && actor.kind === "user"
    && input.submittedByUserId === actor.user.id && lineageContentFingerprint("NativeTranscriptInput", input) === scope.fingerprint,
  409, "SOURCE_CHANGED", "Company transcript source changed.");
  await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id"=${input.ownerMemberId} AND "workspaceId"=${workspaceId} FOR SHARE`;
  if (meetingId) await tx.$queryRaw`SELECT "id" FROM "Meeting" WHERE "id"=${meetingId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
  invariant(!await tx.nativeTranscriptPublication.findFirst({ where: { workspaceId, nativeInputId: input.id } }),
    409, "SOURCE_CHANGED", "Transcript receipt was already published.");
  invariant(await isArtifactPermissionEpochProofCurrent(workspaceId, scope.callerEpochs, tx), 409, "SOURCE_CHANGED", "Transcript uploader authority changed.");
  invariant((await Promise.all(scope.roots.map(root => isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, tx)))).every(Boolean),
    409, "SOURCE_CHANGED", "Transcript uploader authority changed.");
}

export async function finishCompanyTranscriptPublication(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string, manifest: ArtifactInputLineage | boolean | null | undefined) {
  const scope = currentCompanyTranscriptPublicationScope(actor, workspaceId);
  if (!scope) return;
  invariant(manifest && typeof manifest === "object" && manifest.workspaceId === workspaceId && manifest.artifactType === "MeetingTranscript"
    && manifest.origin === "DERIVED" && manifest.epochProofVersion === 1
    && Array.isArray(manifest.rootsJson) && manifest.rootsJson.some(root => root && typeof root === "object" && !Array.isArray(root)
      && root.kind === "NativeTranscriptInput" && root.id === scope.inputId && root.fingerprint === scope.fingerprint),
  409, "UNKNOWN_LINEAGE", "Company transcript publication lacks its original native proof.");
  await tx.nativeTranscriptPublication.create({ data: { workspaceId, nativeInputId: scope.inputId,
    nativeFingerprint: scope.fingerprint, meetingId: manifest.artifactId, transcriptManifestId: manifest.id,
    manifestHash: nativeTranscriptPayloadHash(manifest), transcriptFingerprint: manifest.contentHash,
    permissionEpochsJson: manifest.permissionEpochsJson as Prisma.InputJsonValue } });
  await scope.hooks?.after(tx, manifest.artifactId);
  scope.published = true;
  const input = await tx.nativeTranscriptInput.findFirstOrThrow({ where: { workspaceId, id: scope.inputId } });
  invariant(await isCompanyTranscriptInputCurrent(actor, workspaceId, input, tx), 409, "SOURCE_CHANGED", "Company transcript publication authority changed.");
}

export async function isCompanyTranscriptInputCurrent(actor: AppActor, workspaceId: string, input: NativeTranscriptInput, db: Prisma.TransactionClient = prisma) {
  if (input.mode !== "COMPANY_MEMBER_UPLOAD" || input.workspaceId !== workspaceId || !input.ownerMemberId || !input.submittedByUserId
    || input.sourceRecordId || input.connectionId || input.recordingId || input.meetingAudioAssetId || input.grantHash
    || input.storageKey || input.fileHash || input.fileSizeBytes) return false;
  const binding = await db.nativeTranscriptPublication.findFirst({ where: { workspaceId, nativeInputId: input.id } });
  const scope = currentCompanyTranscriptPublicationScope(actor, workspaceId, input.id);
  if (!binding) return Boolean(scope && !scope.published && actor.kind === "user" && actor.user.id === input.submittedByUserId
    && scope.fingerprint === lineageContentFingerprint("NativeTranscriptInput", input)
    && await db.member.findFirst({ where: { id: input.ownerMemberId, workspaceId, userId: input.submittedByUserId, isActive: true } })
    && await isArtifactPermissionEpochProofCurrent(workspaceId, scope.callerEpochs, db));
  if (getMeetingTranscriptWorkerPurpose(actor, workspaceId) && !await isMeetingTranscriptWorkerCurrent(actor, workspaceId,
    { meetingId: binding.meetingId, inputId: input.id }, db === prisma ? undefined : db)) return false;
  if (hasActiveSourceCommitLockPlan(db)) assertSourceCommitRowCovered(db, "NativeTranscriptPublication", binding.id);
  const [manifest, meeting] = await Promise.all([
    db.artifactInputLineage.findFirst({ where: { workspaceId, id: binding.transcriptManifestId, artifactType: "MeetingTranscript", artifactId: binding.meetingId } }),
    db.meeting.findFirst({ where: { workspaceId, id: binding.meetingId, archivedAt: null } }),
  ]);
  return Boolean(binding.nativeFingerprint === lineageContentFingerprint("NativeTranscriptInput", input)
    && manifest && nativeTranscriptPayloadHash(manifest) === binding.manifestHash && manifest.contentHash === binding.transcriptFingerprint
    && meeting && await canReadInformationCategory(actor, workspaceId, meeting.informationCategory, db)
    && await isArtifactPermissionEpochProofCurrent(workspaceId, binding.permissionEpochsJson, db));
}
