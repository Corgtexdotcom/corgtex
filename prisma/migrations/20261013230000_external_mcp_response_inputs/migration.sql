CREATE TABLE "ExternalMcpResponseInput" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "localUserId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "serverUrl" TEXT NOT NULL,
  "providerAccountId" TEXT,
  "mode" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "requestJson" JSONB NOT NULL,
  "encryptedResponseJson" TEXT NOT NULL,
  "responseHash" VARCHAR(64) NOT NULL,
  "connectionGrantHash" VARCHAR(64) NOT NULL,
  "originalLocalEpochsJson" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalMcpResponseInput_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalMcpResponseInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ExternalMcpResponseInput_workspaceId_connectionId_fetchedAt_idx" ON "ExternalMcpResponseInput"("workspaceId", "connectionId", "fetchedAt");
CREATE INDEX "ExternalMcpResponseInput_workspaceId_localUserId_fetchedAt_idx" ON "ExternalMcpResponseInput"("workspaceId", "localUserId", "fetchedAt");

CREATE TRIGGER "pun68_permission_ExternalMcpResponseInput" AFTER INSERT OR DELETE OR UPDATE ON "ExternalMcpResponseInput"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalMcpResponseInput',
    '["workspaceId","connectionId","localUserId","providerKey","serverUrl","providerAccountId","mode","toolName","requestJson","encryptedResponseJson","responseHash","connectionGrantHash","originalLocalEpochsJson","fetchedAt"]');

-- Stable absence-sensitive enumeration identity: disconnect/reconnect or a new
-- connection must not revive an earlier empty or ranked search response.
CREATE FUNCTION pun68_external_mcp_connection_set_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR OLD."userId" IS DISTINCT FROM NEW."userId" OR
    OLD."providerKey" IS DISTINCT FROM NEW."providerKey" OR OLD."serverUrl" IS DISTINCT FROM NEW."serverUrl" OR
    OLD."providerAccountId" IS DISTINCT FROM NEW."providerAccountId" OR OLD.scopes IS DISTINCT FROM NEW.scopes OR
    OLD.status IS DISTINCT FROM NEW.status OR OLD."accessTokenEnc" IS DISTINCT FROM NEW."accessTokenEnc" OR
    OLD."refreshTokenEnc" IS DISTINCT FROM NEW."refreshTokenEnc" OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" OR
    OLD.capabilities IS DISTINCT FROM NEW.capabilities
  ) THEN RETURN NEW; END IF;
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image, after_image))
    WHERE value <> 'null'::jsonb LOOP
    PERFORM pun68_bump_permission_epoch(image->>'workspaceId', 'ExternalMcpConnectionSetPolicy', image->>'userId');
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_external_mcp_connection_set" AFTER INSERT OR DELETE OR UPDATE ON "ExternalMcpConnection"
  FOR EACH ROW EXECUTE FUNCTION pun68_external_mcp_connection_set_transition();
