-- Preserve authenticated import authority across revoke/restore and source deletion.
-- This migration does not adopt or backfill existing transcript content.
CREATE FUNCTION pun68_transcript_connection_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_image jsonb; after_image jsonb; image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    (before_image - ARRAY['displayName','cursorJson','lastSyncAt','lastBackfillAt','lastError','createdAt','updatedAt'])
      IS NOT DISTINCT FROM
    (after_image - ARRAY['displayName','cursorJson','lastSyncAt','lastBackfillAt','lastError','createdAt','updatedAt'])
  THEN RETURN NEW; END IF;
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image,after_image)) WHERE value <> 'null'::jsonb LOOP
    PERFORM pun68_bump_permission_epoch(image->>'workspaceId','TranscriptConnectionPolicy',image->>'id');
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER "pun68_transcript_connection_policy" AFTER INSERT OR DELETE OR UPDATE
  ON "MeetingTranscriptSourceConnection" FOR EACH ROW EXECUTE FUNCTION pun68_transcript_connection_policy();

CREATE FUNCTION pun68_transcript_record_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_image jsonb; after_image jsonb; image jsonb;
BEGIN
  -- A trusted importer allocates an absent record ID and captures its epoch before
  -- inference. Its exact first INSERT is verified by the atomic publication plan.
  -- INSERT must not refresh or invalidate that original absence observation.
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  before_image := to_jsonb(OLD);
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('ACTIVE','SUPERSEDED') AND NEW.status IN ('ACTIVE','SUPERSEDED')
    AND (before_image - ARRAY['status','supersededByRecordId','updatedAt'])
      IS NOT DISTINCT FROM (after_image - ARRAY['status','supersededByRecordId','updatedAt'])
  THEN RETURN NEW; END IF;
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image,after_image)) WHERE value <> 'null'::jsonb LOOP
    PERFORM pun68_bump_permission_epoch(image->>'workspaceId','TranscriptSourceRecordPolicy',image->>'id');
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER "pun68_transcript_record_policy" AFTER DELETE OR UPDATE
  ON "MeetingTranscriptSourceRecord" FOR EACH ROW EXECUTE FUNCTION pun68_transcript_record_policy();

ALTER TABLE "NativeTranscriptInput" ADD COLUMN "transportArchiveId" TEXT;
ALTER TABLE "NativeTranscriptInput" DROP CONSTRAINT "NativeTranscriptInput_mode_binding";
ALTER TABLE "NativeTranscriptInput" ADD CONSTRAINT "NativeTranscriptInput_mode_binding" CHECK (
  ("mode" IN ('DIRECT_MEMBER_UPLOAD','COMPANY_MEMBER_UPLOAD','AUDIO_UPLOAD') AND "ownerMemberId" IS NOT NULL AND "submittedByUserId" IS NOT NULL AND "recorderAttemptId" IS NULL AND "recorderMeetingId" IS NULL AND "recorderBindingId" IS NULL AND "recorderProvider" IS NULL)
  OR ("mode"='RECORDER' AND "ownerMemberId" IS NULL AND "submittedByUserId" IS NULL AND "recordingId" IS NOT NULL AND "recorderAttemptId" IS NOT NULL AND "recorderMeetingId" IS NOT NULL AND "recorderBindingId" IS NOT NULL AND "recorderProvider" IN ('RECALL_AI','MEETING_BAAS') AND "meetingAudioAssetId" IS NULL AND "sourceRecordId" IS NULL AND "connectionId" IS NULL)
  OR ("mode"='PROVIDER_IMPORT' AND "ownerMemberId" IS NULL AND "submittedByUserId" IS NULL AND "recordingId" IS NULL AND "recorderAttemptId" IS NULL AND "recorderMeetingId" IS NULL AND "recorderBindingId" IS NULL AND "recorderProvider" IS NULL AND "meetingAudioAssetId" IS NULL AND "sourceRecordId" IS NOT NULL AND "connectionId" IS NOT NULL AND "grantHash" IS NOT NULL)
) NOT VALID;

-- ROLLOUT PRECONDITION: drain/fence ALL old importer writers before applying.
-- Old compound reads/upserts require the former universal uniqueness contract.
-- Keep FAILED originals unchanged; retries append new successful publications.
-- Rollback must preserve this schema/index: the universal unique index cannot
-- be restored after duplicate FAILED identities exist without reconciliation.
DROP INDEX "MeetingTranscriptSourceRecord_workspaceId_provider_external_key";
CREATE UNIQUE INDEX "MeetingTranscriptSourceRecord_published_content_key"
  ON "MeetingTranscriptSourceRecord" ("workspaceId", "provider", "externalId", "contentHash")
  WHERE status <> 'FAILED';

CREATE TABLE "NativeTranscriptPublication" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL,
  "nativeInputId" TEXT NOT NULL, "nativeFingerprint" VARCHAR(64) NOT NULL,
  "meetingId" TEXT NOT NULL, "transcriptManifestId" TEXT NOT NULL,
  "manifestHash" VARCHAR(64) NOT NULL, "transcriptFingerprint" VARCHAR(64) NOT NULL,
  "permissionEpochsJson" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NativeTranscriptPublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NativeTranscriptPublication_workspaceId_nativeInputId_key" ON "NativeTranscriptPublication"("workspaceId","nativeInputId");
CREATE INDEX "NativeTranscriptPublication_workspaceId_meetingId_idx" ON "NativeTranscriptPublication"("workspaceId","meetingId");
CREATE FUNCTION pun68_native_transcript_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Native transcript publications are immutable'; END IF;
  PERFORM pun68_bump_permission_epoch(OLD."workspaceId",'NativeTranscriptInput',OLD."nativeInputId");
  RETURN OLD;
END; $$;
CREATE TRIGGER "pun68_native_transcript_publication_guard" BEFORE UPDATE OR DELETE ON "NativeTranscriptPublication" FOR EACH ROW EXECUTE FUNCTION pun68_native_transcript_publication_guard();

CREATE TABLE "TranscriptTransportArchive" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL, "connectionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "configurationHash" VARCHAR(64) NOT NULL, "wireHash" VARCHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL CHECK ("byteSize">0 AND "byteSize"<=67108864),
  "encryptedWiresJson" TEXT NOT NULL,
  "cipherHash" TEXT GENERATED ALWAYS AS (encode(sha256(decode("encryptedWiresJson",'escape')),'hex')) STORED NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TranscriptTransportArchive_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TranscriptTransportArchive_workspaceId_connectionId_idx" ON "TranscriptTransportArchive"("workspaceId","connectionId");
CREATE FUNCTION pun68_transcript_transport_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Authenticated transcript transport is immutable'; END IF;
  PERFORM pun68_bump_permission_epoch(OLD."workspaceId",'TranscriptTransportArchive',OLD."id");
  RETURN OLD;
END; $$;
CREATE TRIGGER "pun68_transcript_transport_guard" BEFORE UPDATE OR DELETE ON "TranscriptTransportArchive" FOR EACH ROW EXECUTE FUNCTION pun68_transcript_transport_guard();
