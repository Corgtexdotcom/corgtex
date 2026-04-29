CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'COMPLETED');

CREATE TABLE "MeetingSeries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'internal',
    "externalId" TEXT,
    "recurrenceRule" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "defaultDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "participantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "participantEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingSeries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Meeting"
ADD COLUMN "seriesId" TEXT,
ADD COLUMN "status" "MeetingStatus" NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN "calendarExternalId" TEXT,
ADD COLUMN "scheduledEndAt" TIMESTAMP(3),
ADD COLUMN "participantEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "agendaJson" JSONB,
ADD COLUMN "agendaChannelId" TEXT,
ADD COLUMN "agendaMessageTs" TEXT,
ADD COLUMN "agendaPostedAt" TIMESTAMP(3),
ADD COLUMN "summaryPostedAt" TIMESTAMP(3);

CREATE INDEX "MeetingSeries_workspaceId_archivedAt_idx" ON "MeetingSeries"("workspaceId", "archivedAt");
CREATE UNIQUE INDEX "MeetingSeries_externalId_key" ON "MeetingSeries"("externalId");
CREATE INDEX "Meeting_workspaceId_status_recordedAt_idx" ON "Meeting"("workspaceId", "status", "recordedAt");
CREATE INDEX "Meeting_workspaceId_calendarExternalId_idx" ON "Meeting"("workspaceId", "calendarExternalId");
CREATE INDEX "Meeting_seriesId_recordedAt_idx" ON "Meeting"("seriesId", "recordedAt");

ALTER TABLE "MeetingSeries" ADD CONSTRAINT "MeetingSeries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "MeetingSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
