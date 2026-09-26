ALTER TABLE "Action" ADD COLUMN "duplicateOfActionId" TEXT;

CREATE UNIQUE INDEX "Action_id_workspaceId_key" ON "Action"("id", "workspaceId");

CREATE INDEX "Action_workspaceId_duplicateOfActionId_idx"
    ON "Action"("workspaceId", "duplicateOfActionId");

ALTER TABLE "Action" ADD CONSTRAINT "Action_duplicateOfActionId_fkey"
    FOREIGN KEY ("duplicateOfActionId") REFERENCES "Action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ActionCreationSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "sourceType" VARCHAR(64) NOT NULL,
    "sourceId" VARCHAR(191) NOT NULL,
    "sourceGroupId" VARCHAR(191),
    "payloadHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionCreationSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActionCreationSource_workspaceId_sourceType_sourceId_key"
    ON "ActionCreationSource"("workspaceId", "sourceType", "sourceId");

CREATE INDEX "ActionCreationSource_workspaceId_actionId_idx"
    ON "ActionCreationSource"("workspaceId", "actionId");

CREATE INDEX "ActionCreationSource_workspaceId_sourceType_sourceGroupId_idx"
    ON "ActionCreationSource"("workspaceId", "sourceType", "sourceGroupId");

ALTER TABLE "ActionCreationSource" ADD CONSTRAINT "ActionCreationSource_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionCreationSource" ADD CONSTRAINT "ActionCreationSource_actionId_fkey"
    FOREIGN KEY ("actionId", "workspaceId") REFERENCES "Action"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
