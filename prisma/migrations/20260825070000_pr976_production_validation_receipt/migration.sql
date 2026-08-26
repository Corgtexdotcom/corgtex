-- CreateEnum
CREATE TYPE "ProductionValidationLifecycleState" AS ENUM ('PENDING', 'PROVISIONED', 'FEATURE_PROVEN', 'CLEANED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ProductionValidationOutcome" AS ENUM ('PENDING', 'COMPLETED', 'BLOCKED', 'FAILED');

-- CreateTable
CREATE TABLE "ProductionValidationReceipt" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetPullRequest" INTEGER NOT NULL,
    "targetReleaseSha" TEXT NOT NULL,
    "deployedSha" TEXT NOT NULL,
    "ancestorSha" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "workflowRunAttempt" INTEGER NOT NULL,
    "syntheticMarker" TEXT NOT NULL,
    "actionId" TEXT,
    "goalId" TEXT,
    "agentCredentialId" TEXT,
    "actionBaselineVersion" INTEGER,
    "goalBaselineVersion" INTEGER,
    "actionExpectedDigest" TEXT,
    "actionObservedDigest" TEXT,
    "goalExpectedProgress" INTEGER,
    "goalObservedProgress" INTEGER,
    "actionState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "goalState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "credentialState" "ProductionValidationLifecycleState" NOT NULL DEFAULT 'PENDING',
    "outcome" "ProductionValidationOutcome" NOT NULL DEFAULT 'PENDING',
    "actionArchiveRecordId" TEXT,
    "goalArchiveRecordId" TEXT,
    "cleanupStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "featureProvenAt" TIMESTAMP(3),
    "terminalizedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "transitions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionValidationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_operationKey_workflowRunId_work_key" ON "ProductionValidationReceipt"("operationKey", "workflowRunId", "workflowRunAttempt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_actionId_key" ON "ProductionValidationReceipt"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_goalId_key" ON "ProductionValidationReceipt"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionValidationReceipt_agentCredentialId_key" ON "ProductionValidationReceipt"("agentCredentialId");

-- CreateIndex
CREATE INDEX "ProductionValidationReceipt_workspaceId_outcome_idx" ON "ProductionValidationReceipt"("workspaceId", "outcome");

-- CreateIndex
CREATE INDEX "ProductionValidationReceipt_targetPullRequest_targetRelease_idx" ON "ProductionValidationReceipt"("targetPullRequest", "targetReleaseSha");

-- AddForeignKey
ALTER TABLE "ProductionValidationReceipt" ADD CONSTRAINT "ProductionValidationReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION production_validation_reject_action_relation_after_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    referenced_action_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'ActionChecklistItem' THEN
        referenced_action_id := NEW."actionId";
    ELSIF TG_TABLE_NAME = 'WorkItemEvidence' THEN
        IF NEW."entityType" IS DISTINCT FROM 'Action' THEN
            RETURN NEW;
        END IF;
        referenced_action_id := NEW."entityId";
    ELSIF TG_TABLE_NAME = 'WorkspaceExternalResourceAttachment' THEN
        IF NEW."entityType" IS DISTINCT FROM 'Action' THEN
            RETURN NEW;
        END IF;
        referenced_action_id := NEW."entityId";
    ELSIF TG_TABLE_NAME = 'DeliberationEntry' THEN
        IF NEW."parentType" IS DISTINCT FROM 'ACTION' THEN
            RETURN NEW;
        END IF;
        referenced_action_id := NEW."parentId";
    ELSIF TG_TABLE_NAME = 'AdviceProcess' THEN
        IF NEW."subjectType" IS DISTINCT FROM 'ACTION' THEN
            RETURN NEW;
        END IF;
        referenced_action_id := NEW."subjectId";
    ELSE
        RETURN NEW;
    END IF;

    IF referenced_action_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('work_item_version'), hashtext('Action:' || referenced_action_id));

    IF EXISTS (
        SELECT 1
        FROM "ProductionValidationReceipt"
        WHERE "actionId" = referenced_action_id
          AND "cleanupStartedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'production validation Action cleanup already started'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production_validation_reject_goal_relation_after_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    referenced_goal_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'Goal' THEN
        referenced_goal_id := NEW."parentGoalId";
    ELSIF TG_TABLE_NAME = 'KeyResult' THEN
        referenced_goal_id := NEW."goalId";
    ELSIF TG_TABLE_NAME = 'GoalUpdate' THEN
        referenced_goal_id := NEW."goalId";
    ELSIF TG_TABLE_NAME = 'GoalLink' THEN
        referenced_goal_id := NEW."goalId";
    ELSIF TG_TABLE_NAME = 'Recognition' THEN
        referenced_goal_id := NEW."goalId";
    ELSE
        RETURN NEW;
    END IF;

    IF referenced_goal_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('work_item_version'), hashtext('Goal:' || referenced_goal_id));

    IF EXISTS (
        SELECT 1
        FROM "ProductionValidationReceipt"
        WHERE "goalId" = referenced_goal_id
          AND "cleanupStartedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'production validation Goal cleanup already started'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production_validation_reject_agent_identity_after_credential_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_credential_id TEXT;
    new_credential_id TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        old_credential_id := NULL;
    ELSE
        old_credential_id := NULLIF(OLD."linkedCredentialId", '');
    END IF;
    new_credential_id := NULLIF(NEW."linkedCredentialId", '');

    IF old_credential_id IS NULL AND new_credential_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF old_credential_id IS NOT NULL AND (new_credential_id IS NULL OR old_credential_id <= new_credential_id) THEN
        PERFORM pg_advisory_xact_lock(hashtext('production_validation_credential'), hashtext(old_credential_id));
    END IF;
    IF new_credential_id IS NOT NULL AND new_credential_id IS DISTINCT FROM old_credential_id THEN
        PERFORM pg_advisory_xact_lock(hashtext('production_validation_credential'), hashtext(new_credential_id));
    END IF;
    IF old_credential_id IS NOT NULL AND new_credential_id IS NOT NULL AND old_credential_id > new_credential_id THEN
        PERFORM pg_advisory_xact_lock(hashtext('production_validation_credential'), hashtext(old_credential_id));
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ProductionValidationReceipt"
        WHERE "agentCredentialId" IN (old_credential_id, new_credential_id)
          AND "cleanupStartedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'production validation credential cleanup already started'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production_validation_reject_credential_update_after_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_to_inactive BOOLEAN;
BEGIN
    IF OLD."id" IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('production_validation_credential'), hashtext(OLD."id"));

    IF NOT EXISTS (
        SELECT 1
        FROM "ProductionValidationReceipt"
        WHERE "agentCredentialId" = OLD."id"
          AND "cleanupStartedAt" IS NOT NULL
    ) THEN
        RETURN NEW;
    END IF;

    active_to_inactive := OLD."isActive" = true AND NEW."isActive" = false;
    IF active_to_inactive AND NEW."tokenHash" IS NOT DISTINCT FROM OLD."tokenHash" THEN
        RETURN NEW;
    END IF;

    IF NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."isActive" = true THEN
        RAISE EXCEPTION 'production validation credential cleanup already started'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "ProductionValidationReceipt_action_checklist_cleanup_guard"
BEFORE INSERT OR UPDATE OF "actionId" ON "ActionChecklistItem"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_action_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_action_evidence_cleanup_guard"
BEFORE INSERT OR UPDATE OF "entityType", "entityId" ON "WorkItemEvidence"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_action_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_action_external_attachment_cleanup_guard"
BEFORE INSERT OR UPDATE OF "entityType", "entityId" ON "WorkspaceExternalResourceAttachment"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_action_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_action_deliberation_cleanup_guard"
BEFORE INSERT OR UPDATE OF "parentType", "parentId" ON "DeliberationEntry"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_action_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_action_advice_process_cleanup_guard"
BEFORE INSERT OR UPDATE OF "subjectType", "subjectId" ON "AdviceProcess"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_action_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_goal_parent_cleanup_guard"
BEFORE INSERT OR UPDATE OF "parentGoalId" ON "Goal"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_goal_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_goal_key_result_cleanup_guard"
BEFORE INSERT OR UPDATE OF "goalId" ON "KeyResult"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_goal_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_goal_update_cleanup_guard"
BEFORE INSERT OR UPDATE OF "goalId" ON "GoalUpdate"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_goal_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_goal_link_cleanup_guard"
BEFORE INSERT OR UPDATE OF "goalId" ON "GoalLink"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_goal_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_goal_recognition_cleanup_guard"
BEFORE INSERT OR UPDATE OF "goalId" ON "Recognition"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_goal_relation_after_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_agent_identity_cleanup_guard"
BEFORE INSERT OR UPDATE OF "linkedCredentialId" ON "AgentIdentity"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_agent_identity_after_credential_cleanup();

CREATE TRIGGER "ProductionValidationReceipt_agent_credential_cleanup_guard"
BEFORE UPDATE OF "tokenHash", "isActive" ON "AgentCredential"
FOR EACH ROW EXECUTE FUNCTION production_validation_reject_credential_update_after_cleanup();
