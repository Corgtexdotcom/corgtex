-- Durable permission rebuild events; additive to the applied governor migration.
-- Complete governor coverage; historical partial v1 vectors are withheld by policy v2.
CREATE OR REPLACE FUNCTION pun68_source_permission_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb; field text; workspace_id text; source_id text; member_user text; changed boolean := false;
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
      INSERT INTO "Event" (id,"workspaceId",type,"aggregateType","aggregateId",payload,status,"availableAt","createdAt")
      VALUES (md5('pun68-permission:' || workspace_id || ':' || txid_current()::text), workspace_id,
        'source-permission.changed','SourcePermissionEpoch',workspace_id,
        jsonb_build_object('version',1,'governors',jsonb_build_array(jsonb_build_object('kind',TG_ARGV[0],'id',source_id))),
        'PENDING',now(),now())
      ON CONFLICT (id) DO UPDATE SET payload = jsonb_build_object('version',1,'governors',
        coalesce("Event".payload->'governors','[]'::jsonb) || (EXCLUDED.payload->'governors'));
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
