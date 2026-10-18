-- Authenticated OAuth inputs and semantic authority epochs. Routine token refresh is not revocation.
CREATE TABLE "OAuthProviderFetchInput" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "connectionId" TEXT NOT NULL REFERENCES "OAuthConnection"("id") ON DELETE CASCADE,
  "localUserId" TEXT NOT NULL, "ownerMemberId" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "providerAccountId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL, "externalId" TEXT NOT NULL, "sourceKey" TEXT NOT NULL,
  "selection" TEXT NOT NULL, "grantHash" TEXT NOT NULL, "encryptedPayload" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL, "permissionEpochsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OAuthProviderFetchInput_workspace_connection_item_idx"
  ON "OAuthProviderFetchInput"("workspaceId","connectionId","sourceKind","externalId");
CREATE FUNCTION pun68_oauth_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OAuth provider capture is immutable'; END;
$$;
CREATE TRIGGER "pun68_oauth_input_immutable" BEFORE UPDATE ON "OAuthProviderFetchInput"
  FOR EACH ROW EXECUTE FUNCTION pun68_oauth_input_immutable();
CREATE TRIGGER "pun68_permission_OAuthProviderFetchInput" AFTER INSERT OR DELETE ON "OAuthProviderFetchInput"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('OAuthProviderFetchInput','["workspaceId","connectionId","localUserId","ownerMemberId"]');
CREATE FUNCTION pun68_oauth_connection_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; ws text; connection_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    (old_row - ARRAY['accessToken','refreshToken','tokenStorageVersion','expiresAt','providerEmail','lastSyncAt','lastSyncError','createdAt','updatedAt']) =
    (new_row - ARRAY['accessToken','refreshToken','tokenStorageVersion','expiresAt','providerEmail','lastSyncAt','lastSyncError','createdAt','updatedAt']) THEN RETURN NEW; END IF;
  connection_id := COALESCE(new_row->>'id',old_row->>'id');
  FOR ws IN SELECT DISTINCT candidate FROM (
    SELECT old_row->>'workspaceId' candidate UNION SELECT new_row->>'workspaceId'
    UNION SELECT "workspaceId" FROM "Member" WHERE "userId" IN (old_row->>'userId',new_row->>'userId')
    UNION SELECT "workspaceId" FROM "OAuthProviderFetchInput" WHERE "connectionId"=connection_id
  ) scopes WHERE candidate IS NOT NULL ORDER BY candidate LOOP
    PERFORM pun68_bump_permission_epoch(ws,'OAuthConnectionPolicy',connection_id);
    IF TG_OP <> 'INSERT' THEN PERFORM pun68_emit_permission_rebuild(ws,'OAuthConnectionPolicy',connection_id); END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_permission_OAuthConnection" AFTER INSERT OR UPDATE OR DELETE ON "OAuthConnection"
  FOR EACH ROW EXECUTE FUNCTION pun68_oauth_connection_transition();
