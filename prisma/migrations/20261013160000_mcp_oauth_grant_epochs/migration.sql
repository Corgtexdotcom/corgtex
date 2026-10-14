-- The MCP grant epoch fences an in-flight connection. It is intentionally not
-- a content permission parent: disconnect must not retract completed effects.
-- SourcePermissionEpoch keeps a tombstone when a token is deleted and later
-- recreated with the same ID.
CREATE FUNCTION pun68_mcp_oauth_grant_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt" OR
      OLD.scopes IS DISTINCT FROM NEW.scopes OR
      OLD."userId" IS DISTINCT FROM NEW."userId" OR
      OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR
      OLD."clientId" IS DISTINCT FROM NEW."clientId" OR
      OLD.resource IS DISTINCT FROM NEW.resource OR
      OLD."instanceSlug" IS DISTINCT FROM NEW."instanceSlug" OR
      OLD."supportGrantVersion" IS DISTINCT FROM NEW."supportGrantVersion"
    ) THEN RETURN NEW; END IF;
  END IF;
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image, after_image))
    WHERE value <> 'null'::jsonb LOOP
    PERFORM pun68_bump_permission_epoch(image->>'workspaceId', 'McpOAuthGrantPolicy', image->>'id');
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pun68_mcp_oauth_grant_token" AFTER INSERT OR DELETE OR UPDATE ON "McpOAuthAccessToken"
  FOR EACH ROW EXECUTE FUNCTION pun68_mcp_oauth_grant_transition();

-- Client registration is global. A liveness change must fence every token
-- issued by that client in its own workspace, across all workspaces.
CREATE FUNCTION pun68_mcp_oauth_client_liveness_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dependent record;
BEGIN
  IF OLD."isActive" IS NOT DISTINCT FROM NEW."isActive" THEN RETURN NEW; END IF;
  FOR dependent IN SELECT "workspaceId", id FROM "McpOAuthAccessToken"
    WHERE "clientId" = NEW.id ORDER BY "workspaceId", id LOOP
    PERFORM pun68_bump_permission_epoch(dependent."workspaceId", 'McpOAuthGrantPolicy', dependent.id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pun68_mcp_oauth_grant_client" AFTER UPDATE OF "isActive" ON "McpOAuthClient"
  FOR EACH ROW EXECUTE FUNCTION pun68_mcp_oauth_client_liveness_transition();
