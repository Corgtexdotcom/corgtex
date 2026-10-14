-- AlterTable
ALTER TABLE "NativeTranscriptInput" ADD COLUMN     "recorderAttemptId" TEXT,
ADD COLUMN     "recorderBindingId" TEXT,
ADD COLUMN     "recorderMeetingId" TEXT,
ALTER COLUMN "ownerMemberId" DROP NOT NULL,
ALTER COLUMN "submittedByUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "RecorderTranscriptBinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "configurationHash" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecorderTranscriptBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecorderTranscriptClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecorderTranscriptClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecorderTranscriptAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalBotId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "configurationHash" VARCHAR(64) NOT NULL,
    "generation" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "providerEventId" TEXT,
    "originHash" VARCHAR(64) NOT NULL,
    "encryptedOriginJson" TEXT NOT NULL,
    "nativeInputId" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecorderTranscriptAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecorderTranscriptPublication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "nativeInputId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "providerEventId" TEXT,
    "eventId" TEXT NOT NULL,
    "transcriptManifestId" TEXT NOT NULL,
    "meetingManifestId" TEXT NOT NULL,
    "completePlanHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecorderTranscriptPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecorderTranscriptBinding_workspaceId_provider_active_idx" ON "RecorderTranscriptBinding"("workspaceId", "provider", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptClaim_recordingId_key" ON "RecorderTranscriptClaim"("recordingId");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptClaim_attemptId_key" ON "RecorderTranscriptClaim"("attemptId");

-- CreateIndex
CREATE INDEX "RecorderTranscriptClaim_workspaceId_leaseUntil_idx" ON "RecorderTranscriptClaim"("workspaceId", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptAttempt_nativeInputId_key" ON "RecorderTranscriptAttempt"("nativeInputId");

-- CreateIndex
CREATE INDEX "RecorderTranscriptAttempt_workspaceId_recordingId_idx" ON "RecorderTranscriptAttempt"("workspaceId", "recordingId");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptAttempt_claimId_generation_key" ON "RecorderTranscriptAttempt"("claimId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptPublication_attemptId_key" ON "RecorderTranscriptPublication"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptPublication_nativeInputId_key" ON "RecorderTranscriptPublication"("nativeInputId");

-- CreateIndex
CREATE UNIQUE INDEX "RecorderTranscriptPublication_eventId_key" ON "RecorderTranscriptPublication"("eventId");

-- CreateIndex
CREATE INDEX "RecorderTranscriptPublication_workspaceId_recordingId_idx" ON "RecorderTranscriptPublication"("workspaceId", "recordingId");

-- AddForeignKey
ALTER TABLE "RecorderTranscriptBinding" ADD CONSTRAINT "RecorderTranscriptBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecorderTranscriptClaim" ADD CONSTRAINT "RecorderTranscriptClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecorderTranscriptAttempt" ADD CONSTRAINT "RecorderTranscriptAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecorderTranscriptPublication" ADD CONSTRAINT "RecorderTranscriptPublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "NativeTranscriptInput" ADD COLUMN "recorderProvider" TEXT;

-- Human identity is mandatory for both existing modes. Recorder custody cannot
-- impersonate a user, an uploaded audio asset, or an imported source record.
ALTER TABLE "NativeTranscriptInput" ADD CONSTRAINT "NativeTranscriptInput_mode_binding" CHECK (
  ("mode" IN ('DIRECT_MEMBER_UPLOAD','AUDIO_UPLOAD') AND "ownerMemberId" IS NOT NULL AND "submittedByUserId" IS NOT NULL AND "recorderAttemptId" IS NULL AND "recorderMeetingId" IS NULL AND "recorderBindingId" IS NULL AND "recorderProvider" IS NULL)
  OR ("mode"='RECORDER' AND "ownerMemberId" IS NULL AND "submittedByUserId" IS NULL AND "recordingId" IS NOT NULL AND "recorderAttemptId" IS NOT NULL AND "recorderMeetingId" IS NOT NULL AND "recorderBindingId" IS NOT NULL AND "recorderProvider" IN ('RECALL_AI','MEETING_BAAS') AND "meetingAudioAssetId" IS NULL AND "sourceRecordId" IS NULL AND "connectionId" IS NULL)
) NOT VALID;
-- Existing originals remain immutable, including legacy modes that are withheld.
CREATE FUNCTION pun68_recorder_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable recorder/native evidence cannot be updated'; END; $$;
CREATE TRIGGER "pun68_native_transcript_immutable" BEFORE UPDATE ON "NativeTranscriptInput" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_immutable();
CREATE TRIGGER "pun68_recorder_publication_immutable" BEFORE UPDATE ON "RecorderTranscriptPublication" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_immutable();
CREATE FUNCTION pun68_recorder_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'nativeInputId'-'failureCode') IS DISTINCT FROM (to_jsonb(OLD)-'nativeInputId'-'failureCode')
    OR (OLD."nativeInputId" IS NOT NULL AND NEW."nativeInputId" IS DISTINCT FROM OLD."nativeInputId")
    OR (OLD."failureCode" IS NOT NULL AND NEW."failureCode" IS DISTINCT FROM OLD."failureCode") THEN
   RAISE EXCEPTION 'Recorder attempt identity is immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "pun68_recorder_attempt_transition" BEFORE UPDATE ON "RecorderTranscriptAttempt" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_attempt_transition();
CREATE FUNCTION pun68_recorder_binding_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'active'-'revokedAt') IS DISTINCT FROM (to_jsonb(OLD)-'active'-'revokedAt')
    OR (NOT OLD.active AND NEW.active) OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
   RAISE EXCEPTION 'Recorder provider binding cannot be revived or rewritten';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "pun68_recorder_binding_transition" BEFORE UPDATE ON "RecorderTranscriptBinding" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_binding_transition();
CREATE UNIQUE INDEX "RecorderTranscriptBinding_active" ON "RecorderTranscriptBinding" ("workspaceId","provider") WHERE active;
CREATE TRIGGER "pun68_permission_MeetingRecording" AFTER INSERT OR DELETE OR UPDATE ON "MeetingRecording" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingRecording','["workspaceId","meetingId","provider","externalBotId"]');
CREATE FUNCTION pun68_recorder_provider_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; old_image jsonb; workspace_id text; changed boolean;
BEGIN
 image := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 old_image := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 changed := TG_OP<>'UPDATE' OR CASE WHEN TG_TABLE_NAME='RecorderTranscriptBinding' THEN
   old_image->'active' IS DISTINCT FROM image->'active' OR old_image->'revokedAt' IS DISTINCT FROM image->'revokedAt'
 ELSE (old_image->'enabled' IS DISTINCT FROM image->'enabled' OR old_image->'providerSettings' IS DISTINCT FROM image->'providerSettings'
   OR old_image->'defaultProvider' IS DISTINCT FROM image->'defaultProvider' OR old_image->'fallbackProvider' IS DISTINCT FROM image->'fallbackProvider') END;
 IF changed THEN
   workspace_id := image->>'workspaceId';
   PERFORM pun68_bump_permission_epoch(workspace_id,'RecorderProviderPolicy','RECALL_AI');
   PERFORM pun68_bump_permission_epoch(workspace_id,'RecorderProviderPolicy','MEETING_BAAS');
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER "pun68_recorder_config_policy" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceMeetingRecorderConfig" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_provider_policy();
CREATE TRIGGER "pun68_recorder_binding_policy" AFTER INSERT OR DELETE OR UPDATE ON "RecorderTranscriptBinding" FOR EACH ROW EXECUTE FUNCTION pun68_recorder_provider_policy();
