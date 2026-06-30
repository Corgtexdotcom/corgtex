ALTER TABLE "WorkspaceExternalResource"
ADD COLUMN "category" TEXT NOT NULL DEFAULT 'LINK',
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "WorkspaceExternalResource_workspace_category_priority_idx"
ON "WorkspaceExternalResource"("workspaceId", "category", "priority");

CREATE TABLE "WorkspaceExternalResourceMention" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceProvider" TEXT,
  "sourceExternalId" TEXT,
  "sourcePermalink" TEXT,
  "sourceLabel" TEXT,
  "sourceText" TEXT,
  "mentionedAt" TIMESTAMP(3),
  "redactedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "communicationMessageId" TEXT,

  CONSTRAINT "WorkspaceExternalResourceMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceExternalResourceMention_resource_source_key"
ON "WorkspaceExternalResourceMention"("resourceId", "sourceType", "sourceId");

CREATE INDEX "WorkspaceExternalResourceMention_workspace_source_idx"
ON "WorkspaceExternalResourceMention"("workspaceId", "sourceType", "sourceId");

CREATE INDEX "WorkspaceExternalResourceMention_workspace_source_time_idx"
ON "WorkspaceExternalResourceMention"("workspaceId", "sourceType", "mentionedAt");

CREATE INDEX "WorkspaceExternalResourceMention_message_idx"
ON "WorkspaceExternalResourceMention"("communicationMessageId");

ALTER TABLE "WorkspaceExternalResourceMention"
ADD CONSTRAINT "WorkspaceExternalResourceMention_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResourceMention"
ADD CONSTRAINT "WorkspaceExternalResourceMention_resourceId_fkey"
FOREIGN KEY ("resourceId") REFERENCES "WorkspaceExternalResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceExternalResourceMention"
ADD CONSTRAINT "WorkspaceExternalResourceMention_communicationMessageId_fkey"
FOREIGN KEY ("communicationMessageId") REFERENCES "CommunicationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
