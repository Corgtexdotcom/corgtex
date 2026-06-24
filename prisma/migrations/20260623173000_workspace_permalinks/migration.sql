-- Permanent links for user-facing workspace items.

CREATE TABLE "WorkspacePermalink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "canonicalPath" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspacePermalink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspacePermalink_workspaceId_entityType_entityId_key" ON "WorkspacePermalink"("workspaceId", "entityType", "entityId");
CREATE INDEX "WorkspacePermalink_workspaceId_entityType_idx" ON "WorkspacePermalink"("workspaceId", "entityType");
CREATE INDEX "WorkspacePermalink_workspaceId_entityId_idx" ON "WorkspacePermalink"("workspaceId", "entityId");

ALTER TABLE "WorkspacePermalink"
  ADD CONSTRAINT "WorkspacePermalink_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':Action:' || "id"), "workspaceId", 'Action', "id", '/workspaces/' || "workspaceId" || '/actions/' || "id", "authorUserId", "createdAt", CURRENT_TIMESTAMP
FROM "Action"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':Tension:' || "id"), "workspaceId", 'Tension', "id", '/workspaces/' || "workspaceId" || '/tensions/' || "id", "authorUserId", "createdAt", CURRENT_TIMESTAMP
FROM "Tension"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':Proposal:' || "id"), "workspaceId", 'Proposal', "id", '/workspaces/' || "workspaceId" || '/proposals/' || "id", "authorUserId", "createdAt", CURRENT_TIMESTAMP
FROM "Proposal"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':BrainArticle:' || "id"), "workspaceId", 'BrainArticle', "id", '/workspaces/' || "workspaceId" || '/brain/' || "slug", NULL, "createdAt", CURRENT_TIMESTAMP
FROM "BrainArticle"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':Meeting:' || "id"), "workspaceId", 'Meeting', "id", '/workspaces/' || "workspaceId" || '/meetings/' || "id", NULL, "createdAt", CURRENT_TIMESTAMP
FROM "Meeting"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT md5("workspaceId" || ':Goal:' || "id"), "workspaceId", 'Goal', "id", '/workspaces/' || "workspaceId" || '/goals?view=tree&cadence=' || "cadence" || '&goalId=' || "id", NULL, "createdAt", CURRENT_TIMESTAMP
FROM "Goal"
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;

INSERT INTO "WorkspacePermalink" ("id", "workspaceId", "entityType", "entityId", "canonicalPath", "createdByUserId", "createdAt", "updatedAt")
SELECT
  md5(ar."workspaceId" || ':' || ar."entityType" || ':' || ar."entityId"),
  ar."workspaceId",
  ar."entityType",
  ar."entityId",
  CASE ar."entityType"
    WHEN 'Action' THEN '/workspaces/' || ar."workspaceId" || '/actions/' || ar."entityId"
    WHEN 'Tension' THEN '/workspaces/' || ar."workspaceId" || '/tensions/' || ar."entityId"
    WHEN 'Proposal' THEN '/workspaces/' || ar."workspaceId" || '/proposals/' || ar."entityId"
    WHEN 'BrainArticle' THEN '/workspaces/' || ar."workspaceId" || '/brain/' || ar."entityId"
    WHEN 'Meeting' THEN '/workspaces/' || ar."workspaceId" || '/meetings/' || ar."entityId"
    WHEN 'Goal' THEN '/workspaces/' || ar."workspaceId" || '/goals?goalId=' || ar."entityId"
  END,
  ar."archivedByUserId",
  ar."createdAt",
  CURRENT_TIMESTAMP
FROM "WorkspaceArchiveRecord" ar
WHERE ar."entityType" IN ('Action', 'Tension', 'Proposal', 'BrainArticle', 'Meeting', 'Goal')
ON CONFLICT ("workspaceId", "entityType", "entityId") DO NOTHING;
