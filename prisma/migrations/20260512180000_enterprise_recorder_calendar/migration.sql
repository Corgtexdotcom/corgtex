-- Enterprise meeting recorder rollout foundations for customer-scoped master calendars and smoke evidence.

CREATE TYPE "RecorderCalendarSourceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

CREATE TYPE "MeetingRecorderSmokeRunStatus" AS ENUM ('PENDING', 'DRY_RUN_READY', 'SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "WorkspaceRecorderCalendarSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL DEFAULT 'MICROSOFT',
    "providerAccountId" TEXT NOT NULL,
    "providerAccountEmail" TEXT,
    "displayName" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "RecorderCalendarSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncJobId" TEXT,
    "lastSyncError" TEXT,
    "lastDryRunAt" TIMESTAMP(3),
    "lastUpcomingEventCount" INTEGER NOT NULL DEFAULT 0,
    "lastSchedulableEventCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceRecorderCalendarSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MeetingRecorderSmokeRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "meetingId" TEXT,
    "recordingId" TEXT,
    "provider" "MeetingRecorderProvider" NOT NULL DEFAULT 'RECALL_AI',
    "status" "MeetingRecorderSmokeRunStatus" NOT NULL DEFAULT 'PENDING',
    "meetingUrlHash" TEXT,
    "joinAt" TIMESTAMP(3),
    "liveVendorCall" BOOLEAN NOT NULL DEFAULT false,
    "checks" JSONB,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MeetingRecorderSmokeRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceRecorderCalendarSource_workspaceId_provider_key" ON "WorkspaceRecorderCalendarSource"("workspaceId", "provider");
CREATE INDEX "WorkspaceRecorderCalendarSource_workspaceId_status_idx" ON "WorkspaceRecorderCalendarSource"("workspaceId", "status");
CREATE INDEX "WorkspaceRecorderCalendarSource_provider_providerAccountId_idx" ON "WorkspaceRecorderCalendarSource"("provider", "providerAccountId");

CREATE INDEX "MeetingRecorderSmokeRun_workspaceId_createdAt_idx" ON "MeetingRecorderSmokeRun"("workspaceId", "createdAt");
CREATE INDEX "MeetingRecorderSmokeRun_deploymentId_createdAt_idx" ON "MeetingRecorderSmokeRun"("deploymentId", "createdAt");
CREATE INDEX "MeetingRecorderSmokeRun_workspaceId_status_idx" ON "MeetingRecorderSmokeRun"("workspaceId", "status");
CREATE INDEX "MeetingRecorderSmokeRun_recordingId_idx" ON "MeetingRecorderSmokeRun"("recordingId");

ALTER TABLE "WorkspaceRecorderCalendarSource" ADD CONSTRAINT "WorkspaceRecorderCalendarSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MeetingRecorderSmokeRun" ADD CONSTRAINT "MeetingRecorderSmokeRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingRecorderSmokeRun" ADD CONSTRAINT "MeetingRecorderSmokeRun_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CustomerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MeetingRecorderSmokeRun" ADD CONSTRAINT "MeetingRecorderSmokeRun_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MeetingRecorderSmokeRun" ADD CONSTRAINT "MeetingRecorderSmokeRun_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "MeetingRecording"("id") ON DELETE SET NULL ON UPDATE CASCADE;
