-- CreateTable
CREATE TABLE "NativeTranscriptInput" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "ownerMemberId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "meetingAudioAssetId" TEXT,
    "sourceRecordId" TEXT,
    "connectionId" TEXT,
    "recordingId" TEXT,
    "storageKey" TEXT,
    "fileHash" VARCHAR(64),
    "fileSizeBytes" INTEGER,
    "mimeType" TEXT,
    "encryptedPayloadJson" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "grantHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeTranscriptInput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NativeTranscriptInput_workspaceId_ownerMemberId_idx" ON "NativeTranscriptInput"("workspaceId", "ownerMemberId");

-- CreateIndex
CREATE INDEX "NativeTranscriptInput_workspaceId_sourceRecordId_idx" ON "NativeTranscriptInput"("workspaceId", "sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeTranscriptInput_workspaceId_mode_meetingAudioAssetId_key" ON "NativeTranscriptInput"("workspaceId", "mode", "meetingAudioAssetId");

-- AddForeignKey
ALTER TABLE "NativeTranscriptInput" ADD CONSTRAINT "NativeTranscriptInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "pun68_permission_NativeTranscriptInput" AFTER INSERT OR DELETE OR UPDATE ON "NativeTranscriptInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('NativeTranscriptInput', '["workspaceId","ownerMemberId","submittedByUserId","mode","meetingAudioAssetId","sourceRecordId","connectionId","recordingId","storageKey","fileHash","grantHash"]');
CREATE TRIGGER "pun68_permission_MeetingAudioAsset" AFTER INSERT OR DELETE OR UPDATE ON "MeetingAudioAsset" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingAudioAsset', '["workspaceId","uploadedByUserId","storageKey"]');
