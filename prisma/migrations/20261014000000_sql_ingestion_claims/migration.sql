CREATE TABLE "SqlIngestionSourceClaim" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 0, "activeAttemptId" TEXT, "ownerNonce" TEXT,
  "configurationFingerprint" VARCHAR(64), "leaseExpiresAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'IDLE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SqlIngestionSourceClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SqlIngestionSourceClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SqlIngestionSourceClaim_workspaceId_sourceId_key" ON "SqlIngestionSourceClaim"("workspaceId","sourceId");
CREATE TABLE "SqlIngestionAttempt" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "generation" BIGINT NOT NULL,
  "ownerNonce" TEXT NOT NULL, "configurationFingerprint" VARCHAR(64) NOT NULL,
  "expectedCursor" TEXT, "sourcePermissionEpoch" BIGINT NOT NULL, "logId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING', "leaseExpiresAt" TIMESTAMP(3) NOT NULL, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "SqlIngestionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SqlIngestionAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SqlIngestionAttempt_workspaceId_sourceId_generation_key" ON "SqlIngestionAttempt"("workspaceId","sourceId","generation");
CREATE INDEX "SqlIngestionAttempt_workspaceId_sourceId_status_idx" ON "SqlIngestionAttempt"("workspaceId","sourceId","status");
ALTER TABLE "ExternalDataSyncLog" ADD COLUMN "sqlAttemptId" TEXT;
CREATE UNIQUE INDEX "ExternalDataSyncLog_sqlAttemptId_key" ON "ExternalDataSyncLog"("sqlAttemptId");

CREATE TRIGGER "pun68_permission_ExternalDataSource" AFTER INSERT OR DELETE OR UPDATE ON "ExternalDataSource"
  FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalDataSource',
    '["workspaceId","driverType","connectionStringEnc","selectedTables","cursorColumn","isActive","archivedAt"]');

CREATE FUNCTION pun68_sql_source_claim_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR OLD."driverType" IS DISTINCT FROM NEW."driverType" OR
    OLD."connectionStringEnc" IS DISTINCT FROM NEW."connectionStringEnc" OR OLD."selectedTables" IS DISTINCT FROM NEW."selectedTables" OR
    OLD."cursorColumn" IS DISTINCT FROM NEW."cursorColumn" OR OLD."isActive" IS DISTINCT FROM NEW."isActive" OR
    OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt"
  ) THEN RETURN NEW; END IF;
  FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_image,after_image)) WHERE value <> 'null'::jsonb LOOP
    IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE id = image->>'workspaceId') THEN CONTINUE; END IF;
    INSERT INTO "SqlIngestionSourceClaim" ("id","workspaceId","sourceId","generation","status","createdAt","updatedAt")
    VALUES (md5('pun68-sql-claim:' || (image->>'workspaceId') || ':' || (image->>'id')),image->>'workspaceId',image->>'id',1,'REVOKED',now(),now())
    ON CONFLICT ("workspaceId","sourceId") DO UPDATE SET "generation" = "SqlIngestionSourceClaim"."generation" + 1,
      "activeAttemptId" = NULL, "ownerNonce" = NULL, "configurationFingerprint" = NULL,
      "leaseExpiresAt" = NULL, "status" = 'REVOKED', "updatedAt" = now();
    UPDATE "SqlIngestionAttempt" SET "status" = 'REVOKED', "completedAt" = now()
    WHERE "workspaceId" = image->>'workspaceId' AND "sourceId" = image->>'id' AND "status" = 'RUNNING';
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_source_claim" AFTER INSERT OR DELETE OR UPDATE ON "ExternalDataSource"
  FOR EACH ROW EXECUTE FUNCTION pun68_sql_source_claim_transition();

CREATE FUNCTION pun68_sql_attempt_immutable_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD."workspaceId",OLD."sourceId",OLD.generation,OLD."ownerNonce",OLD."configurationFingerprint",
    OLD."expectedCursor",OLD."sourcePermissionEpoch",OLD."logId",OLD."createdAt") IS DISTINCT FROM
    ROW(NEW.id,NEW."workspaceId",NEW."sourceId",NEW.generation,NEW."ownerNonce",NEW."configurationFingerprint",
    NEW."expectedCursor",NEW."sourcePermissionEpoch",NEW."logId",NEW."createdAt")
    OR (OLD.status <> 'RUNNING' AND NEW.status = 'RUNNING') THEN
    RAISE EXCEPTION 'SQL ingestion attempt birth is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_attempt_birth" BEFORE UPDATE ON "SqlIngestionAttempt"
  FOR EACH ROW EXECUTE FUNCTION pun68_sql_attempt_immutable_birth();

CREATE FUNCTION pun68_sql_claim_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id,OLD."workspaceId",OLD."sourceId") IS DISTINCT FROM ROW(NEW.id,NEW."workspaceId",NEW."sourceId")
    OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'SQL ingestion source identity and generation are monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_claim_generation" BEFORE UPDATE ON "SqlIngestionSourceClaim"
  FOR EACH ROW EXECUTE FUNCTION pun68_sql_claim_monotonic();
