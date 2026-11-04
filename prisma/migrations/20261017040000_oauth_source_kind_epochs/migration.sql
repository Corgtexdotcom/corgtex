-- Separate source selection/scope governors while retaining shared account and owner revocation.
-- Migration 194 is immutable; routine credential rotation still changes neither governor.
CREATE OR REPLACE FUNCTION pun68_oauth_connection_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; ws text; connection_id text; source_kind text;
  common_changed boolean; kind_changed boolean; old_scopes jsonb; new_scopes jsonb; policy text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  connection_id := COALESCE(new_row->>'id',old_row->>'id');
  common_changed := TG_OP <> 'UPDATE' OR
    (old_row - ARRAY['accessToken','refreshToken','tokenStorageVersion','expiresAt','providerEmail','lastSyncAt','lastSyncError','createdAt','updatedAt','syncSettings','scopes']) IS DISTINCT FROM
    (new_row - ARRAY['accessToken','refreshToken','tokenStorageVersion','expiresAt','providerEmail','lastSyncAt','lastSyncError','createdAt','updatedAt','syncSettings','scopes']);
  -- Identity and other shared grants still govern both kinds. Only the known
  -- content-family grants are isolated below.
  SELECT COALESCE(jsonb_agg(scope ORDER BY scope),'[]'::jsonb) INTO old_scopes FROM (
    SELECT DISTINCT lower(value) scope FROM jsonb_array_elements_text(COALESCE(old_row->'scopes','[]'::jsonb))
    WHERE lower(value) NOT IN ('https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','files.read','sites.read.all','https://www.googleapis.com/auth/gmail.readonly','mail.read')
  ) shared;
  SELECT COALESCE(jsonb_agg(scope ORDER BY scope),'[]'::jsonb) INTO new_scopes FROM (
    SELECT DISTINCT lower(value) scope FROM jsonb_array_elements_text(COALESCE(new_row->'scopes','[]'::jsonb))
    WHERE lower(value) NOT IN ('https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','files.read','sites.read.all','https://www.googleapis.com/auth/gmail.readonly','mail.read')
  ) shared;
  common_changed := common_changed OR old_scopes IS DISTINCT FROM new_scopes;
  FOR ws IN SELECT DISTINCT candidate FROM (
    SELECT old_row->>'workspaceId' candidate UNION SELECT new_row->>'workspaceId'
    UNION SELECT "workspaceId" FROM "Member" WHERE "userId" IN (old_row->>'userId',new_row->>'userId')
    UNION SELECT "workspaceId" FROM "OAuthProviderFetchInput" WHERE "connectionId"=connection_id
  ) scopes WHERE candidate IS NOT NULL ORDER BY candidate LOOP
    IF common_changed THEN
      PERFORM pun68_bump_permission_epoch(ws,'OAuthConnectionPolicy',connection_id);
      IF TG_OP <> 'INSERT' THEN PERFORM pun68_emit_permission_rebuild(ws,'OAuthConnectionPolicy',connection_id); END IF;
    END IF;
    FOREACH source_kind IN ARRAY ARRAY['documents','email'] LOOP
      SELECT COALESCE(jsonb_agg(scope ORDER BY scope),'[]'::jsonb) INTO old_scopes FROM (
        SELECT DISTINCT lower(value) scope FROM jsonb_array_elements_text(COALESCE(old_row->'scopes','[]'::jsonb))
        WHERE (source_kind='documents' AND lower(value) IN ('https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','files.read','sites.read.all'))
          OR (source_kind='email' AND lower(value) IN ('https://www.googleapis.com/auth/gmail.readonly','mail.read'))
      ) relevant;
      SELECT COALESCE(jsonb_agg(scope ORDER BY scope),'[]'::jsonb) INTO new_scopes FROM (
        SELECT DISTINCT lower(value) scope FROM jsonb_array_elements_text(COALESCE(new_row->'scopes','[]'::jsonb))
        WHERE (source_kind='documents' AND lower(value) IN ('https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','files.read','sites.read.all'))
          OR (source_kind='email' AND lower(value) IN ('https://www.googleapis.com/auth/gmail.readonly','mail.read'))
      ) relevant;
      kind_changed := TG_OP <> 'UPDATE' OR old_scopes IS DISTINCT FROM new_scopes
        OR old_row->'syncSettings'->source_kind IS DISTINCT FROM new_row->'syncSettings'->source_kind;
      IF kind_changed THEN
        policy := CASE source_kind WHEN 'documents' THEN 'OAuthDocumentsPolicy' ELSE 'OAuthEmailPolicy' END;
        PERFORM pun68_bump_permission_epoch(ws,policy,connection_id);
        IF TG_OP <> 'INSERT' THEN PERFORM pun68_emit_permission_rebuild(ws,policy,connection_id); END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
