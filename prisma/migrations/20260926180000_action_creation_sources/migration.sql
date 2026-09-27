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

ALTER TABLE "ActionCreationSource" ADD CONSTRAINT "ActionCreationSource_actionId_workspaceId_fkey"
    FOREIGN KEY ("actionId", "workspaceId") REFERENCES "Action"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve identity for Action captures made before source claims existed.
-- Earlier captures could create more than one link for a message; the first
-- eligible link is the stable retry target.
INSERT INTO "ActionCreationSource" ("id", "workspaceId", "actionId", "sourceType", "sourceId", "createdAt")
SELECT gen_random_uuid()::text, legacy."workspaceId", legacy."entityId",
       'COMMUNICATION_MESSAGE', legacy."installationId" || ':' || legacy."messageId", legacy."createdAt"
FROM (
    SELECT DISTINCT ON (link."workspaceId", link."installationId", link."messageId")
           link."workspaceId", link."installationId", link."messageId", link."entityId", link."createdAt"
    FROM "CommunicationEntityLink" AS link
    JOIN "Action" AS action ON action."id" = link."entityId" AND action."workspaceId" = link."workspaceId"
    WHERE link."entityType" = 'Action' AND link."action" = 'create_action'
      AND link."messageId" IS NOT NULL
    ORDER BY link."workspaceId", link."installationId", link."messageId", link."createdAt", link."id"
) AS legacy
ON CONFLICT ("workspaceId", "sourceType", "sourceId") DO NOTHING;

INSERT INTO "ActionCreationSource" ("id", "workspaceId", "actionId", "sourceType", "sourceId", "sourceGroupId", "createdAt")
SELECT gen_random_uuid()::text, insight."workspaceId", insight."appliedEntityId",
       'MEETING_INSIGHT', insight."id", insight."meetingId", insight."createdAt"
FROM "MeetingInsight" AS insight
JOIN "Action" AS action ON action."id" = insight."appliedEntityId" AND action."workspaceId" = insight."workspaceId"
WHERE insight."status" = 'APPLIED' AND insight."operation" = 'CREATE'
  AND insight."type" IN ('ACTION_ITEM', 'FOLLOW_UP')
  AND insight."appliedEntityType" = 'Action'
ON CONFLICT ("workspaceId", "sourceType", "sourceId") DO NOTHING;

-- Every writer that attaches work to an Action takes a row lock and checks the
-- live duplicate marker. The resolver takes the same row lock before counting
-- links, so an in-flight writer either commits first and blocks resolution or
-- waits and refuses to attach to the resolved duplicate.
CREATE FUNCTION "guardResolvedActionLink"() RETURNS TRIGGER AS $$
DECLARE
    action_id TEXT;
    workspace_id TEXT;
    scope_id TEXT;
BEGIN
    IF TG_ARGV[0] <> '' AND (to_jsonb(NEW)->>TG_ARGV[0]) IS DISTINCT FROM TG_ARGV[1] THEN
        RETURN NEW;
    END IF;

    action_id := to_jsonb(NEW)->>TG_ARGV[2];
    IF action_id IS NULL THEN
        RETURN NEW;
    END IF;

    scope_id := CASE WHEN TG_ARGV[3] = 'goal'
        THEN to_jsonb(NEW)->>'goalId'
        ELSE to_jsonb(NEW)->>'workspaceId' END;
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(OLD)->>TG_ARGV[0]) IS NOT DISTINCT FROM (to_jsonb(NEW)->>TG_ARGV[0])
            AND (to_jsonb(OLD)->>TG_ARGV[2]) IS NOT DISTINCT FROM action_id
            AND (CASE WHEN TG_ARGV[3] = 'goal' THEN to_jsonb(OLD)->>'goalId' ELSE to_jsonb(OLD)->>'workspaceId' END) IS NOT DISTINCT FROM scope_id THEN
            RETURN NEW;
        END IF;
    END IF;

    IF TG_ARGV[3] = 'goal' THEN
        SELECT "workspaceId" INTO workspace_id FROM "Goal" WHERE "id" = scope_id;
    ELSE
        workspace_id := scope_id;
    END IF;

    PERFORM 1 FROM "Action"
        WHERE "id" = action_id AND "workspaceId" = workspace_id
          AND "duplicateOfActionId" IS NULL
        FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            MESSAGE = 'Action link target is missing or resolved as a duplicate.',
            CONSTRAINT = 'Action_link_unresolved_check';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ActionChecklistItem_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "actionId" ON "ActionChecklistItem"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('', '', 'actionId', 'workspace');
CREATE TRIGGER "WorkItemEvidence_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "entityType", "entityId" ON "WorkItemEvidence"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('entityType', 'Action', 'entityId', 'workspace');
CREATE TRIGGER "WorkspaceExternalResourceAttachment_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "entityType", "entityId" ON "WorkspaceExternalResourceAttachment"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('entityType', 'Action', 'entityId', 'workspace');
CREATE TRIGGER "CommunicationEntityLink_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "entityType", "entityId" ON "CommunicationEntityLink"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('entityType', 'Action', 'entityId', 'workspace');
CREATE TRIGGER "DeliberationEntry_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "parentType", "parentId" ON "DeliberationEntry"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('parentType', 'ACTION', 'parentId', 'workspace');
CREATE TRIGGER "GoalLink_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "goalId", "entityType", "entityId" ON "GoalLink"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('entityType', 'Action', 'entityId', 'goal');
CREATE TRIGGER "AdviceProcess_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "subjectType", "subjectId" ON "AdviceProcess"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('subjectType', 'ACTION', 'subjectId', 'workspace');
CREATE TRIGGER "ApprovalFlow_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "subjectType", "subjectId" ON "ApprovalFlow"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('subjectType', 'ACTION', 'subjectId', 'workspace');
CREATE TRIGGER "ActionCreationSource_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "actionId" ON "ActionCreationSource"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('', '', 'actionId', 'workspace');
CREATE TRIGGER "MeetingInsight_applied_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "appliedEntityType", "appliedEntityId" ON "MeetingInsight"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('appliedEntityType', 'Action', 'appliedEntityId', 'workspace');
CREATE TRIGGER "MeetingInsight_target_unresolved_action_check"
    BEFORE INSERT OR UPDATE OF "workspaceId", "targetEntityType", "targetEntityId" ON "MeetingInsight"
    FOR EACH ROW EXECUTE FUNCTION "guardResolvedActionLink"('targetEntityType', 'Action', 'targetEntityId', 'workspace');
