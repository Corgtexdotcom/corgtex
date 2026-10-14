-- Permission-parent binding coverage. Prior partial vectors stay withheld by v3.
CREATE OR REPLACE FUNCTION pun68_emit_permission_rebuild(workspace_id text, governor_kind text, source_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" WHERE id = workspace_id) THEN RETURN; END IF;
  INSERT INTO "Event" (id,"workspaceId",type,"aggregateType","aggregateId",payload,status,"availableAt","createdAt")
  VALUES (md5('pun68-permission:' || workspace_id || ':' || txid_current()::text),workspace_id,
    'source-permission.changed','SourcePermissionEpoch',workspace_id,
    jsonb_build_object('version',1,'governors',jsonb_build_array(jsonb_build_object('kind',governor_kind,'id',source_id))),
    'PENDING',now(),now())
  ON CONFLICT (id) DO UPDATE SET payload = jsonb_build_object('version',1,'governors',
    coalesce("Event".payload->'governors','[]'::jsonb) || (EXCLUDED.payload->'governors'));
END;
$$;

CREATE OR REPLACE FUNCTION pun68_source_permission_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb; field text; workspace_id text; source_id text; member_user text; changed boolean := false; dependent_workspace_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR field IN SELECT jsonb_array_elements_text(TG_ARGV[1]::jsonb) LOOP
      IF before_image->field IS DISTINCT FROM after_image->field THEN
        IF field = 'status' AND TG_TABLE_NAME IN ('ContextGraphObject','ContextGraphRelationship','ContextGraphProposedDiff') THEN
          IF (before_image->>'status' = 'archived') IS DISTINCT FROM (after_image->>'status' = 'archived') THEN changed := true; EXIT; END IF;
        ELSIF field = 'status' AND TG_TABLE_NAME = 'ExternalContentSource' THEN
          IF (before_image->>'status' = 'ARCHIVED') IS DISTINCT FROM (after_image->>'status' = 'ARCHIVED') THEN changed := true; EXIT; END IF;
        ELSIF field = 'status' AND TG_TABLE_NAME IN ('Action','Tension','Proposal','Goal') THEN
          IF coalesce((before_image->>'isPrivate')::boolean,false) OR coalesce((after_image->>'isPrivate')::boolean,false) THEN changed := true; EXIT; END IF;
        ELSE changed := true; EXIT;
        END IF;
      END IF;
    END LOOP;
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  -- Both identities are bumped when a row moves tenant, principal, source or policy.
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image,after_image)) WHERE value <> 'null'::jsonb LOOP
    workspace_id := image->>'workspaceId'; source_id := image->>'id';
    IF TG_TABLE_NAME = 'Workspace' THEN workspace_id := source_id; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'Role' THEN SELECT "workspaceId" INTO workspace_id FROM "Circle" WHERE id = image->>'circleId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'AdviceRequestRecipient' THEN SELECT "workspaceId" INTO workspace_id FROM "AdviceRequest" WHERE id = image->>'requestId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'RoleAssignment' THEN SELECT "workspaceId", "userId" INTO workspace_id, member_user FROM "Member" WHERE id = image->>'memberId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'CircleAgentAssignment' THEN SELECT "workspaceId" INTO workspace_id FROM "Circle" WHERE id = image->>'circleId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'BrainArticleVersion' THEN SELECT "workspaceId" INTO workspace_id FROM "BrainArticle" WHERE id = image->>'articleId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'CrmProspectWorkspace' THEN workspace_id := image->>'crmWorkspaceId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'GoalUpdate' THEN SELECT "workspaceId" INTO workspace_id FROM "Goal" WHERE id = image->>'goalId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'KeyResult' THEN SELECT "workspaceId" INTO workspace_id FROM "Goal" WHERE id = image->>'goalId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'GoalLink' THEN SELECT "workspaceId" INTO workspace_id FROM "Goal" WHERE id = image->>'goalId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'TensionUpvote' THEN SELECT "workspaceId" INTO workspace_id FROM "Tension" WHERE id = image->>'tensionId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'BrainDiscussionThread' THEN SELECT "workspaceId" INTO workspace_id FROM "BrainArticle" WHERE id = image->>'articleId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'BrainDiscussionComment' THEN SELECT a."workspaceId" INTO workspace_id FROM "BrainDiscussionThread" t JOIN "BrainArticle" a ON a.id=t."articleId" WHERE t.id = image->>'threadId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'ContextMapLayoutItem' THEN SELECT "workspaceId" INTO workspace_id FROM "ContextMapView" WHERE id = image->>'mapViewId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'ApprovalDecision' THEN SELECT "workspaceId" INTO workspace_id FROM "ApprovalFlow" WHERE id = image->>'flowId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'Objection' THEN SELECT "workspaceId" INTO workspace_id FROM "ApprovalFlow" WHERE id = image->>'flowId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'BuildArtifactAsset' THEN SELECT "workspaceId" INTO workspace_id FROM "BuildArtifact" WHERE id = image->>'artifactId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'ConversationTurn' THEN SELECT "workspaceId" INTO workspace_id FROM "ConversationSession" WHERE id = image->>'conversationId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'CrmConversationMessage' THEN SELECT "workspaceId" INTO workspace_id FROM "CrmConversation" WHERE id = image->>'conversationId'; END IF;
    IF workspace_id IS NULL THEN CONTINUE; END IF;
    PERFORM pun68_bump_permission_epoch(workspace_id,TG_ARGV[0],source_id);
    IF TG_TABLE_NAME = 'Member' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'MemberUserPolicy',image->>'userId'); END IF;
    IF TG_TABLE_NAME = 'RoleAssignment' THEN
      SELECT "userId" INTO member_user FROM "Member" WHERE id = image->>'memberId';
      PERFORM pun68_bump_permission_epoch(workspace_id,'MemberUserPolicy',member_user);
      PERFORM pun68_bump_permission_epoch(workspace_id,'MemberRolePolicy',image->>'memberId');
    END IF;
    IF TG_TABLE_NAME = 'AdviceRequestRecipient' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'AdviceRequestRecipientsPolicy',image->>'requestId'); END IF;
    IF TG_TABLE_NAME = 'Role' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'CircleRolePolicy',image->>'circleId'); END IF;
    IF TG_TABLE_NAME = 'RoleAssignment' THEN
      PERFORM pun68_bump_permission_epoch(workspace_id,'CircleRolePolicy',(SELECT "circleId" FROM "Role" WHERE id = image->>'roleId'));
    END IF;
    IF TG_TABLE_NAME IN ('RoleAssignment','Role','Circle') THEN PERFORM pun68_bump_permission_epoch(workspace_id,'ModulePolicy','finance'); END IF;
    IF TG_TABLE_NAME = 'WorkspaceModuleGrant' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'ModulePolicy',image->>'moduleKey'); END IF;
    IF TG_TABLE_NAME = 'WorkspaceFeatureFlag' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'FeaturePolicy',image->>'flag'); END IF;
    IF TG_TABLE_NAME = 'WorkspaceSupportGrant' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'WorkspaceSupportPolicy',image->>'userId'); END IF;
    IF TG_TABLE_NAME = 'WorkspaceIntegrationBinding' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'IntegrationPolicy',image->>'provider'); END IF;
    IF TG_TABLE_NAME = 'CommunicationChannel' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'CommunicationChannelPolicy',replace(jsonb_build_array(image->>'installationId',image->>'externalChannelId')::text, ', ', ',')); END IF;
    IF TG_TABLE_NAME = 'WorkspaceArchiveRecord' THEN
      PERFORM pun68_bump_permission_epoch(workspace_id,CASE WHEN image->>'entityType' = 'MeetingTranscript' THEN 'Meeting' ELSE image->>'entityType' END,image->>'entityId');
    END IF;
    -- One durable rebuild event per workspace/transaction. Body text and secrets
    -- never enter this metadata-only governor inventory. Generation INSERTs do
    -- not emit events, preventing a derived-output feedback loop.
    IF workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM "Workspace" WHERE id = workspace_id)
      AND (TG_OP IN ('UPDATE','DELETE') OR TG_TABLE_NAME IN
        ('WorkspaceModuleGrant','WorkspaceFeatureFlag','WorkspaceSupportGrant','WorkspaceIntegrationBinding',
         'RoleAssignment','CircleAgentAssignment','AdviceRequestRecipient')) THEN
      PERFORM pun68_emit_permission_rebuild(workspace_id,TG_ARGV[0],source_id);
    END IF;
    -- Namespace-local proxy counters retain foreign membership transitions
    -- without trusting a current grant to recertify an old CRM snapshot.
    IF TG_TABLE_NAME IN ('Workspace','Member','WorkspaceSupportGrant') THEN
      FOR dependent_workspace_id IN SELECT DISTINCT "crmWorkspaceId" COLLATE "C" FROM "CrmProspectWorkspace"
        WHERE "targetWorkspaceId" = workspace_id ORDER BY "crmWorkspaceId" COLLATE "C" LOOP
        PERFORM pun68_bump_permission_epoch(dependent_workspace_id,'CrmProspectTargetAccessPolicy',workspace_id);
        PERFORM pun68_emit_permission_rebuild(dependent_workspace_id,'CrmProspectTargetAccessPolicy',workspace_id);
      END LOOP;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "pun68_permission_GoalUpdate" ON "GoalUpdate";
CREATE TRIGGER "pun68_permission_GoalUpdate" AFTER INSERT OR DELETE OR UPDATE ON "GoalUpdate" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('GoalUpdate', '["goalId","authorMemberId"]');
DROP TRIGGER IF EXISTS "pun68_permission_KeyResult" ON "KeyResult";
CREATE TRIGGER "pun68_permission_KeyResult" AFTER INSERT OR DELETE OR UPDATE ON "KeyResult" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('KeyResult', '["goalId"]');
DROP TRIGGER IF EXISTS "pun68_permission_GoalLink" ON "GoalLink";
CREATE TRIGGER "pun68_permission_GoalLink" AFTER INSERT OR DELETE OR UPDATE ON "GoalLink" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('GoalLink', '["goalId"]');
DROP TRIGGER IF EXISTS "pun68_permission_TensionUpvote" ON "TensionUpvote";
CREATE TRIGGER "pun68_permission_TensionUpvote" AFTER INSERT OR DELETE OR UPDATE ON "TensionUpvote" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('TensionUpvote', '["tensionId","userId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ActionChecklistItem" ON "ActionChecklistItem";
CREATE TRIGGER "pun68_permission_ActionChecklistItem" AFTER INSERT OR DELETE OR UPDATE ON "ActionChecklistItem" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ActionChecklistItem', '["workspaceId","actionId"]');
DROP TRIGGER IF EXISTS "pun68_permission_BrainDiscussionThread" ON "BrainDiscussionThread";
CREATE TRIGGER "pun68_permission_BrainDiscussionThread" AFTER INSERT OR DELETE OR UPDATE ON "BrainDiscussionThread" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainDiscussionThread', '["articleId","authorMemberId"]');
DROP TRIGGER IF EXISTS "pun68_permission_BrainDiscussionComment" ON "BrainDiscussionComment";
CREATE TRIGGER "pun68_permission_BrainDiscussionComment" AFTER INSERT OR DELETE OR UPDATE ON "BrainDiscussionComment" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainDiscussionComment', '["threadId","authorMemberId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ContextMapLayoutItem" ON "ContextMapLayoutItem";
CREATE TRIGGER "pun68_permission_ContextMapLayoutItem" AFTER INSERT OR DELETE OR UPDATE ON "ContextMapLayoutItem" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextMapLayoutItem', '["mapViewId"]');
DROP TRIGGER IF EXISTS "pun68_permission_BrainArticleVersion" ON "BrainArticleVersion";
CREATE TRIGGER "pun68_permission_BrainArticleVersion" AFTER INSERT OR DELETE OR UPDATE ON "BrainArticleVersion" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainArticleVersion', '["articleId"]');
DROP TRIGGER IF EXISTS "pun68_permission_DeliberationEntry" ON "DeliberationEntry";
CREATE TRIGGER "pun68_permission_DeliberationEntry" AFTER INSERT OR DELETE OR UPDATE ON "DeliberationEntry" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('DeliberationEntry', '["workspaceId","authorUserId","parentType","parentId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ConstitutionSourceReference" ON "ConstitutionSourceReference";
CREATE TRIGGER "pun68_permission_ConstitutionSourceReference" AFTER INSERT OR DELETE OR UPDATE ON "ConstitutionSourceReference" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConstitutionSourceReference', '["workspaceId","constitutionId"]');
DROP TRIGGER IF EXISTS "pun68_permission_PolicyCorpus" ON "PolicyCorpus";
CREATE TRIGGER "pun68_permission_PolicyCorpus" AFTER INSERT OR DELETE OR UPDATE ON "PolicyCorpus" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('PolicyCorpus', '["workspaceId","circleId","proposalId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ApprovalFlow" ON "ApprovalFlow";
CREATE TRIGGER "pun68_permission_ApprovalFlow" AFTER INSERT OR DELETE OR UPDATE ON "ApprovalFlow" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ApprovalFlow', '["workspaceId","createdByUserId","subjectType","subjectId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ApprovalDecision" ON "ApprovalDecision";
CREATE TRIGGER "pun68_permission_ApprovalDecision" AFTER INSERT OR DELETE OR UPDATE ON "ApprovalDecision" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ApprovalDecision', '["flowId","memberId"]');
DROP TRIGGER IF EXISTS "pun68_permission_Objection" ON "Objection";
CREATE TRIGGER "pun68_permission_Objection" AFTER INSERT OR DELETE OR UPDATE ON "Objection" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Objection', '["flowId","userId"]');
DROP TRIGGER IF EXISTS "pun68_permission_BuildArtifactAsset" ON "BuildArtifactAsset";
CREATE TRIGGER "pun68_permission_BuildArtifactAsset" AFTER INSERT OR DELETE OR UPDATE ON "BuildArtifactAsset" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BuildArtifactAsset', '["artifactId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ExecutionResult" ON "ExecutionResult";
CREATE TRIGGER "pun68_permission_ExecutionResult" AFTER INSERT OR DELETE OR UPDATE ON "ExecutionResult" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExecutionResult', '["workspaceId","agentCredentialId","submittedByUserId","executionRequestId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ConversationPromptInput" ON "ConversationPromptInput";
CREATE TRIGGER "pun68_permission_ConversationPromptInput" AFTER INSERT OR DELETE OR UPDATE ON "ConversationPromptInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationPromptInput', '["workspaceId","userId","sessionId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ConversationPendingOperation" ON "ConversationPendingOperation";
CREATE TRIGGER "pun68_permission_ConversationPendingOperation" AFTER INSERT OR DELETE OR UPDATE ON "ConversationPendingOperation" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationPendingOperation', '["workspaceId","userId","conversationId"]');
DROP TRIGGER IF EXISTS "pun68_permission_ConversationTurn" ON "ConversationTurn";
CREATE TRIGGER "pun68_permission_ConversationTurn" AFTER INSERT OR DELETE OR UPDATE ON "ConversationTurn" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationTurn', '["conversationId"]');
DROP TRIGGER IF EXISTS "pun68_permission_MeetingInsight" ON "MeetingInsight";
CREATE TRIGGER "pun68_permission_MeetingInsight" AFTER INSERT OR DELETE OR UPDATE ON "MeetingInsight" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingInsight', '["workspaceId","meetingId"]');
DROP TRIGGER IF EXISTS "pun68_permission_MeetingFollowUpReview" ON "MeetingFollowUpReview";
CREATE TRIGGER "pun68_permission_MeetingFollowUpReview" AFTER INSERT OR DELETE OR UPDATE ON "MeetingFollowUpReview" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingFollowUpReview', '["workspaceId","installationId","meetingId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmProspectWorkspace" ON "CrmProspectWorkspace";
CREATE TRIGGER "pun68_permission_CrmProspectWorkspace" AFTER INSERT OR DELETE OR UPDATE ON "CrmProspectWorkspace" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmProspectWorkspace', '["crmWorkspaceId","accountId","targetWorkspaceId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmAccount" ON "CrmAccount";
CREATE TRIGGER "pun68_permission_CrmAccount" AFTER INSERT OR DELETE OR UPDATE ON "CrmAccount" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmAccount', '["workspaceId","archivedAt"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmContact" ON "CrmContact";
CREATE TRIGGER "pun68_permission_CrmContact" AFTER INSERT OR DELETE OR UPDATE ON "CrmContact" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmContact', '["workspaceId","archivedAt","accountId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmDeal" ON "CrmDeal";
CREATE TRIGGER "pun68_permission_CrmDeal" AFTER INSERT OR DELETE OR UPDATE ON "CrmDeal" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmDeal', '["workspaceId","archivedAt","accountId","contactId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmActivity" ON "CrmActivity";
CREATE TRIGGER "pun68_permission_CrmActivity" AFTER INSERT OR DELETE OR UPDATE ON "CrmActivity" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmActivity', '["workspaceId","archivedAt","accountId","contactId","dealId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmConversation" ON "CrmConversation";
CREATE TRIGGER "pun68_permission_CrmConversation" AFTER INSERT OR DELETE OR UPDATE ON "CrmConversation" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmConversation', '["workspaceId","accountId","contactId","dealId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmConversationMessage" ON "CrmConversationMessage";
CREATE TRIGGER "pun68_permission_CrmConversationMessage" AFTER INSERT OR DELETE OR UPDATE ON "CrmConversationMessage" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmConversationMessage', '["conversationId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmDealStageTransition" ON "CrmDealStageTransition";
CREATE TRIGGER "pun68_permission_CrmDealStageTransition" AFTER INSERT OR DELETE OR UPDATE ON "CrmDealStageTransition" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmDealStageTransition', '["workspaceId","dealId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmCommunicationSuggestion" ON "CrmCommunicationSuggestion";
CREATE TRIGGER "pun68_permission_CrmCommunicationSuggestion" AFTER INSERT OR DELETE OR UPDATE ON "CrmCommunicationSuggestion" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmCommunicationSuggestion', '["workspaceId","accountId","contactId","dealId","activityId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmQualification" ON "CrmQualification";
CREATE TRIGGER "pun68_permission_CrmQualification" AFTER INSERT OR DELETE OR UPDATE ON "CrmQualification" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmQualification', '["workspaceId","demoLeadId"]');
DROP TRIGGER IF EXISTS "pun68_permission_CrmQualificationFormInput" ON "CrmQualificationFormInput";
CREATE TRIGGER "pun68_permission_CrmQualificationFormInput" AFTER INSERT OR DELETE OR UPDATE ON "CrmQualificationFormInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmQualificationFormInput', '["workspaceId","qualificationId","demoLeadId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceReportUploadInput" ON "FinanceReportUploadInput";
CREATE TRIGGER "pun68_permission_FinanceReportUploadInput" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportUploadInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportUploadInput', '["workspaceId","uploadedByUserId","batchId","documentId","brainSourceId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceImportBatch" ON "FinanceImportBatch";
CREATE TRIGGER "pun68_permission_FinanceImportBatch" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportBatch" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportBatch', '["workspaceId","uploadedByUserId","documentId","brainSourceId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceImportCandidate" ON "FinanceImportCandidate";
CREATE TRIGGER "pun68_permission_FinanceImportCandidate" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportCandidate" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportCandidate', '["workspaceId","batchId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceReport" ON "FinanceReport";
CREATE TRIGGER "pun68_permission_FinanceReport" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReport" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReport', '["workspaceId","sourceBatchId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceReportFact" ON "FinanceReportFact";
CREATE TRIGGER "pun68_permission_FinanceReportFact" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportFact" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportFact', '["workspaceId","kind","reportId","sourceBatchId","sourceCandidateId"]');
DROP TRIGGER IF EXISTS "pun68_permission_FinanceImportApplication" ON "FinanceImportApplication";
CREATE TRIGGER "pun68_permission_FinanceImportApplication" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportApplication" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportApplication', '["workspaceId","batchId","candidateId","targetFactId"]');
DROP TRIGGER IF EXISTS "pun68_permission_NativeTranscriptInput" ON "NativeTranscriptInput";
CREATE TRIGGER "pun68_permission_NativeTranscriptInput" AFTER INSERT OR DELETE OR UPDATE ON "NativeTranscriptInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('NativeTranscriptInput', '["workspaceId","mode","ownerMemberId","meetingAudioAssetId","submittedByUserId","connectionId","recordingId","sourceRecordId","storageKey","fileHash","grantHash"]');
