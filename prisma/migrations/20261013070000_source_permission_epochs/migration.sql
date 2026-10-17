-- AlterTable
ALTER TABLE "ArtifactInputLineage" ADD COLUMN     "epochProofVersion" INTEGER,
ADD COLUMN     "permissionEpochsJson" JSONB;

-- AlterTable
ALTER TABLE "ArtifactInputSnapshot" ADD COLUMN     "epochProofVersion" INTEGER,
ADD COLUMN     "permissionEpochsJson" JSONB;

-- CreateTable
CREATE TABLE "SourcePermissionEpoch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "SourcePermissionEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourcePermissionEpoch_workspaceId_sourceKind_sourceId_key" ON "SourcePermissionEpoch"("workspaceId", "sourceKind", "sourceId");

-- AddForeignKey
ALTER TABLE "SourcePermissionEpoch" ADD CONSTRAINT "SourcePermissionEpoch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- No pre-epoch derived proof is backfilled with current counters. Nullable vectors
-- intentionally remain unknown until original inputs are freshly proven and rebuilt.
CREATE FUNCTION pun68_bump_permission_epoch(p_workspace text, p_kind text, p_source text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_source = '' OR NOT EXISTS (SELECT 1 FROM "Workspace" WHERE id = p_workspace) THEN RETURN; END IF;
  INSERT INTO "SourcePermissionEpoch" (id,"workspaceId","sourceKind","sourceId",epoch)
  VALUES (md5(p_workspace || ':' || p_kind || ':' || p_source), p_workspace, p_kind, p_source, 1)
  ON CONFLICT ("workspaceId","sourceKind","sourceId") DO UPDATE SET epoch = "SourcePermissionEpoch".epoch + 1;
END;
$$;

CREATE FUNCTION pun68_source_permission_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb; field text; workspace_id text; source_id text; member_user text; changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR field IN SELECT jsonb_array_elements_text(TG_ARGV[1]::jsonb) LOOP
      IF before_image->field IS DISTINCT FROM after_image->field THEN
        IF field = 'status' AND TG_TABLE_NAME IN ('ContextGraphObject','ContextGraphRelationship','ContextGraphProposedDiff') THEN
          IF (before_image->>'status' = 'archived') IS DISTINCT FROM (after_image->>'status' = 'archived') THEN changed := true; EXIT; END IF;
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
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'RoleAssignment' THEN SELECT "workspaceId", "userId" INTO workspace_id, member_user FROM "Member" WHERE id = image->>'memberId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'CircleAgentAssignment' THEN SELECT "workspaceId" INTO workspace_id FROM "Circle" WHERE id = image->>'circleId'; END IF;
    IF workspace_id IS NULL AND TG_TABLE_NAME = 'BrainArticleVersion' THEN SELECT "workspaceId" INTO workspace_id FROM "BrainArticle" WHERE id = image->>'articleId'; END IF;
    IF workspace_id IS NULL THEN CONTINUE; END IF;
    PERFORM pun68_bump_permission_epoch(workspace_id,TG_ARGV[0],source_id);
    IF TG_TABLE_NAME = 'Member' THEN PERFORM pun68_bump_permission_epoch(workspace_id,'MemberUserPolicy',image->>'userId'); END IF;
    IF TG_TABLE_NAME = 'RoleAssignment' THEN
      SELECT "userId" INTO member_user FROM "Member" WHERE id = image->>'memberId';
      PERFORM pun68_bump_permission_epoch(workspace_id,'MemberUserPolicy',member_user);
      PERFORM pun68_bump_permission_epoch(workspace_id,'MemberRolePolicy',image->>'memberId');
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
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_permission_Action" AFTER INSERT OR DELETE OR UPDATE ON "Action" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Action', '["archivedAt","authorUserId","circleId","isPrivate","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_ActionChecklistItem" AFTER INSERT OR DELETE OR UPDATE ON "ActionChecklistItem" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ActionChecklistItem', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_AdviceRequest" AFTER INSERT OR DELETE OR UPDATE ON "AdviceRequest" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AdviceRequest', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentCredential" AFTER INSERT OR DELETE OR UPDATE ON "AgentCredential" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentCredential', '["createdByUserId","isActive","scopes","tokenHash","workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentFeedbackInput" AFTER INSERT OR DELETE OR UPDATE ON "AgentFeedbackInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentFeedbackInput', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentIdentity" AFTER INSERT OR DELETE OR UPDATE ON "AgentIdentity" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentIdentity', '["archivedAt","createdByUserId","isActive","workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentMemory" AFTER INSERT OR DELETE OR UPDATE ON "AgentMemory" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentMemory', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentRequestInput" AFTER INSERT OR DELETE OR UPDATE ON "AgentRequestInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentRequestInput', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_AgentRun" AFTER INSERT OR DELETE OR UPDATE ON "AgentRun" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('AgentRun', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_ApprovalFlow" AFTER INSERT OR DELETE OR UPDATE ON "ApprovalFlow" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ApprovalFlow', '["createdByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ApprovalPolicy" AFTER INSERT OR DELETE OR UPDATE ON "ApprovalPolicy" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ApprovalPolicy', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_ArtifactInputSnapshot" AFTER INSERT OR DELETE OR UPDATE ON "ArtifactInputSnapshot" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ArtifactInputSnapshot', '["sourceId","workspaceId"]');
CREATE TRIGGER "pun68_permission_BrainArticle" AFTER INSERT OR DELETE OR UPDATE ON "BrainArticle" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainArticle', '["archivedAt","isPrivate","ownerMemberId","workspaceId"]');
CREATE TRIGGER "pun68_permission_BrainArticleVersion" AFTER INSERT OR DELETE OR UPDATE ON "BrainArticleVersion" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainArticleVersion', '[]');
CREATE TRIGGER "pun68_permission_BrainSource" AFTER INSERT OR DELETE OR UPDATE ON "BrainSource" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainSource', '["accessDomain","archivedAt","authorMemberId","metadata","sourceType","workspaceId"]');
CREATE TRIGGER "pun68_permission_BuildArtifact" AFTER INSERT OR DELETE OR UPDATE ON "BuildArtifact" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BuildArtifact', '["createdByUserId","visibility","workspaceId"]');
CREATE TRIGGER "pun68_permission_CheckIn" AFTER INSERT OR DELETE OR UPDATE ON "CheckIn" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CheckIn', '["memberId","workspaceId"]');
CREATE TRIGGER "pun68_permission_Circle" AFTER INSERT OR DELETE OR UPDATE ON "Circle" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Circle', '["archivedAt","parentCircleId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CircleAgentAssignment" AFTER INSERT OR DELETE OR UPDATE ON "CircleAgentAssignment" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CircleAgentAssignment', '["agentIdentityId","circleId","roleId"]');
CREATE TRIGGER "pun68_permission_CommunicationChannel" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationChannel" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationChannel', '["externalChannelId","installationId","isArchived","isIngestEnabled","kind","provider","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationContextSummary" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationContextSummary" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationContextSummary', '["externalChannelId","installationId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationEntityLink" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationEntityLink" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationEntityLink', '["installationId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationExternalUser" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationExternalUser" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationExternalUser', '["installationId","memberId","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationInstallation" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationInstallation" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationInstallation', '["appId","botTokenEnc","botUserId","disconnectedAt","externalOrgId","externalWorkspaceId","optionalScopes","provider","scopes","settings","status","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationMessage" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationMessage" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationMessage', '["expiresRawAt","externalChannelId","installationId","isDeleted","isHidden","textRedactedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_Constitution" AFTER INSERT OR DELETE OR UPDATE ON "Constitution" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Constitution', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_ConstitutionSourceReference" AFTER INSERT OR DELETE OR UPDATE ON "ConstitutionSourceReference" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConstitutionSourceReference', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_ContextGraphEvidenceRef" AFTER INSERT OR DELETE OR UPDATE ON "ContextGraphEvidenceRef" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextGraphEvidenceRef', '["sourceId","sourceType","workspaceId"]');
CREATE TRIGGER "pun68_permission_ContextGraphObject" AFTER INSERT OR DELETE OR UPDATE ON "ContextGraphObject" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextGraphObject', '["createdByUserId","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_ContextGraphProposedDiff" AFTER INSERT OR DELETE OR UPDATE ON "ContextGraphProposedDiff" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextGraphProposedDiff', '["workspaceId","status"]');
CREATE TRIGGER "pun68_permission_ContextGraphRelationship" AFTER INSERT OR DELETE OR UPDATE ON "ContextGraphRelationship" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextGraphRelationship', '["createdByUserId","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_ContextMapView" AFTER INSERT OR DELETE OR UPDATE ON "ContextMapView" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ContextMapView', '["createdByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ConversationIngressInput" AFTER INSERT OR DELETE OR UPDATE ON "ConversationIngressInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationIngressInput', '["credentialId","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ConversationOperationOutcome" AFTER INSERT OR DELETE OR UPDATE ON "ConversationOperationOutcome" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationOperationOutcome', '["credentialId","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ConversationPendingOperation" AFTER INSERT OR DELETE OR UPDATE ON "ConversationPendingOperation" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationPendingOperation', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ConversationPromptInput" AFTER INSERT OR DELETE OR UPDATE ON "ConversationPromptInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationPromptInput', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ConversationSession" AFTER INSERT OR DELETE OR UPDATE ON "ConversationSession" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ConversationSession', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmAccount" AFTER INSERT OR DELETE OR UPDATE ON "CrmAccount" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmAccount', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmActivity" AFTER INSERT OR DELETE OR UPDATE ON "CrmActivity" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmActivity', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmCommunicationSuggestion" AFTER INSERT OR DELETE OR UPDATE ON "CrmCommunicationSuggestion" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmCommunicationSuggestion', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmContact" AFTER INSERT OR DELETE OR UPDATE ON "CrmContact" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmContact', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmConversation" AFTER INSERT OR DELETE OR UPDATE ON "CrmConversation" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmConversation', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmDeal" AFTER INSERT OR DELETE OR UPDATE ON "CrmDeal" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmDeal', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmDealStageTransition" AFTER INSERT OR DELETE OR UPDATE ON "CrmDealStageTransition" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmDealStageTransition', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmQualification" AFTER INSERT OR DELETE OR UPDATE ON "CrmQualification" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmQualification', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_CrmQualificationFormInput" AFTER INSERT OR DELETE OR UPDATE ON "CrmQualificationFormInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CrmQualificationFormInput', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_DeliberationEntry" AFTER INSERT OR DELETE OR UPDATE ON "DeliberationEntry" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('DeliberationEntry', '["authorUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_DemoLead" AFTER INSERT OR DELETE OR UPDATE ON "DemoLead" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('DemoLead', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_Document" AFTER INSERT OR DELETE OR UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Document', '["accessDomain","archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_ExecutionRequest" AFTER INSERT OR DELETE OR UPDATE ON "ExecutionRequest" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExecutionRequest', '["agentCredentialId","createdByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ExecutionResult" AFTER INSERT OR DELETE OR UPDATE ON "ExecutionResult" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExecutionResult', '["agentCredentialId","submittedByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ExternalContentSource" AFTER INSERT OR DELETE OR UPDATE ON "ExternalContentSource" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalContentSource', '["archivedAt","connectionId","externalId","metadata","providerKey","selectedByUserId","status","syncMode","workspaceId"]');
CREATE TRIGGER "pun68_permission_ExternalMcpConnection" AFTER INSERT OR DELETE OR UPDATE ON "ExternalMcpConnection" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalMcpConnection', '["accessTokenEnc","expiresAt","providerAccountId","providerKey","refreshTokenEnc","scopes","serverUrl","status","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ExternalProviderFetchInput" AFTER INSERT OR DELETE OR UPDATE ON "ExternalProviderFetchInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalProviderFetchInput', '["connectionId","localUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceImportApplication" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportApplication" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportApplication', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceImportBatch" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportBatch" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportBatch', '["uploadedByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceImportCandidate" AFTER INSERT OR DELETE OR UPDATE ON "FinanceImportCandidate" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceImportCandidate', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceReport" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReport" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReport', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceReportFact" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportFact" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportFact', '["kind","workspaceId"]');
CREATE TRIGGER "pun68_permission_FinanceReportUploadInput" AFTER INSERT OR DELETE OR UPDATE ON "FinanceReportUploadInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('FinanceReportUploadInput', '["uploadedByUserId","workspaceId"]');
CREATE TRIGGER "pun68_permission_GenericDerivedArtifactVariant" AFTER INSERT OR DELETE OR UPDATE ON "GenericDerivedArtifactVariant" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('GenericDerivedArtifactVariant', '["ownerMemberId","workspaceId"]');
CREATE TRIGGER "pun68_permission_Goal" AFTER INSERT OR DELETE OR UPDATE ON "Goal" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Goal', '["archivedAt","authorUserId","circleId","isPrivate","ownerMemberId","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_KnowledgeChunk" AFTER INSERT OR DELETE OR UPDATE ON "KnowledgeChunk" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('KnowledgeChunk', '["accessDomain","sourceId","sourceType","workspaceId"]');
CREATE TRIGGER "pun68_permission_McpToolInput" AFTER INSERT OR DELETE OR UPDATE ON "McpToolInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('McpToolInput', '["credentialId","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_Meeting" AFTER INSERT OR DELETE OR UPDATE ON "Meeting" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Meeting', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_MeetingFollowUpReview" AFTER INSERT OR DELETE OR UPDATE ON "MeetingFollowUpReview" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingFollowUpReview', '["installationId","workspaceId"]');
CREATE TRIGGER "pun68_permission_MeetingInsight" AFTER INSERT OR DELETE OR UPDATE ON "MeetingInsight" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingInsight', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_MeetingSeries" AFTER INSERT OR DELETE OR UPDATE ON "MeetingSeries" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('MeetingSeries', '["archivedAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_Member" AFTER INSERT OR DELETE OR UPDATE ON "Member" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Member', '["isActive","kind","role","userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_ModelUsageBudget" AFTER INSERT OR DELETE OR UPDATE ON "ModelUsageBudget" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ModelUsageBudget', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_NewspaperDelivery" AFTER INSERT OR DELETE OR UPDATE ON "NewspaperDelivery" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('NewspaperDelivery', '["kind","memberId","workspaceId"]');
CREATE TRIGGER "pun68_permission_NewspaperEdition" AFTER INSERT OR DELETE OR UPDATE ON "NewspaperEdition" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('NewspaperEdition', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_NewspaperTrackedLink" AFTER INSERT OR DELETE OR UPDATE ON "NewspaperTrackedLink" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('NewspaperTrackedLink', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_Notification" AFTER INSERT OR DELETE OR UPDATE ON "Notification" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Notification', '["userId","workspaceId"]');
CREATE TRIGGER "pun68_permission_PolicyCorpus" AFTER INSERT OR DELETE OR UPDATE ON "PolicyCorpus" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('PolicyCorpus', '["circleId","workspaceId"]');
CREATE TRIGGER "pun68_permission_Proposal" AFTER INSERT OR DELETE OR UPDATE ON "Proposal" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Proposal', '["archivedAt","authorUserId","circleId","isPrivate","ownerMemberId","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_Recognition" AFTER INSERT OR DELETE OR UPDATE ON "Recognition" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Recognition', '["authorMemberId","recipientMemberId","visibility","workspaceId"]');
CREATE TRIGGER "pun68_permission_RoleAssignment" AFTER INSERT OR DELETE OR UPDATE ON "RoleAssignment" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('RoleAssignment', '["expiresAt","memberId","roleId"]');
CREATE TRIGGER "pun68_permission_RoleHolderHistory" AFTER INSERT OR DELETE OR UPDATE ON "RoleHolderHistory" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('RoleHolderHistory', '["memberId","roleId","workspaceId"]');
CREATE TRIGGER "pun68_permission_RoleOnboardingSession" AFTER INSERT OR DELETE OR UPDATE ON "RoleOnboardingSession" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('RoleOnboardingSession', '["memberId","roleId","workspaceId"]');
CREATE TRIGGER "pun68_permission_RoleVersion" AFTER INSERT OR DELETE OR UPDATE ON "RoleVersion" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('RoleVersion', '["circleId","roleId","workspaceId"]');
CREATE TRIGGER "pun68_permission_Tension" AFTER INSERT OR DELETE OR UPDATE ON "Tension" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Tension', '["archivedAt","authorUserId","circleId","isPrivate","workspaceId","status"]');
CREATE TRIGGER "pun68_permission_Workspace" AFTER INSERT OR DELETE OR UPDATE ON "Workspace" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Workspace', '[]');
CREATE TRIGGER "pun68_permission_WorkspaceArchiveRecord" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceArchiveRecord" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceArchiveRecord', '["archivedAt","entityId","entityType","purgedAt","restoredAt","workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceBriefing" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceBriefing" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceBriefing', '["workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceFeatureFlag" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceFeatureFlag" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceFeatureFlag', '["enabled","flag","workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceIntegrationBinding" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceIntegrationBinding" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceIntegrationBinding', '["externalWorkspaceId","provider","workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceModuleGrant" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceModuleGrant" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceModuleGrant', '["accessLevel","createdByUserId","moduleKey","principalId","principalType","workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceSupportGrant" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceSupportGrant" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceSupportGrant', '["isActive","revokedAt","role","userId","version","workspaceId"]');
CREATE TRIGGER "pun68_permission_WorkspaceToolLink" AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceToolLink" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('WorkspaceToolLink', '["archivedAt","createdByUserId","workspaceId"]');
