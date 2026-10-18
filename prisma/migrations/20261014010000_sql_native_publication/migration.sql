-- AlterTable
ALTER TABLE "ExternalDataSource" ADD COLUMN     "accessDomain" "KnowledgeAccessDomain" NOT NULL DEFAULT 'WORKSPACE',
ADD COLUMN     "allowedCircleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allowedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "informationCategory" TEXT NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SqlIngestionAttempt" ADD COLUMN     "originalPermissionEpochsJson" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "InformationCategoryPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "isRestricted" BOOLEAN NOT NULL DEFAULT false,
    "allowedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedCircleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InformationCategoryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SqlNativeRunInput" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "configurationFingerprint" VARCHAR(64) NOT NULL,
    "sourcePermissionEpoch" BIGINT NOT NULL,
    "permissionEpochsJson" JSONB NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "rowsProcessed" INTEGER NOT NULL,
    "nextCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SqlNativeRunInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SqlKnowledgePublication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "nativeInputId" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "configurationFingerprint" VARCHAR(64) NOT NULL,
    "outputSetHash" VARCHAR(64) NOT NULL,
    "chunksCreated" INTEGER NOT NULL,
    "rowsProcessed" INTEGER NOT NULL,
    "nextCursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "SqlKnowledgePublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SqlKnowledgeStagedChunk" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "contentJson" JSONB NOT NULL,

    CONSTRAINT "SqlKnowledgeStagedChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InformationCategoryPolicy_workspaceId_category_key" ON "InformationCategoryPolicy"("workspaceId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "SqlNativeRunInput_attemptId_key" ON "SqlNativeRunInput"("attemptId");

-- CreateIndex
CREATE INDEX "SqlNativeRunInput_workspaceId_sourceId_idx" ON "SqlNativeRunInput"("workspaceId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "SqlKnowledgePublication_attemptId_key" ON "SqlKnowledgePublication"("attemptId");

-- CreateIndex
CREATE INDEX "SqlKnowledgePublication_workspaceId_sourceId_status_idx" ON "SqlKnowledgePublication"("workspaceId", "sourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SqlKnowledgeStagedChunk_publicationId_ordinal_key" ON "SqlKnowledgeStagedChunk"("publicationId", "ordinal");

-- AddForeignKey
ALTER TABLE "InformationCategoryPolicy" ADD CONSTRAINT "InformationCategoryPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SqlNativeRunInput" ADD CONSTRAINT "SqlNativeRunInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SqlKnowledgePublication" ADD CONSTRAINT "SqlKnowledgePublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SqlKnowledgeStagedChunk" ADD CONSTRAINT "SqlKnowledgeStagedChunk_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "SqlKnowledgePublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE OR REPLACE FUNCTION pun68_sql_source_claim_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb; before_image jsonb; after_image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" OR OLD."driverType" IS DISTINCT FROM NEW."driverType" OR
    OLD."connectionStringEnc" IS DISTINCT FROM NEW."connectionStringEnc" OR OLD."selectedTables" IS DISTINCT FROM NEW."selectedTables" OR
    OLD."cursorColumn" IS DISTINCT FROM NEW."cursorColumn" OR OLD."isActive" IS DISTINCT FROM NEW."isActive" OR
    OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt" OR
    OLD."accessDomain" IS DISTINCT FROM NEW."accessDomain" OR OLD."informationCategory" IS DISTINCT FROM NEW."informationCategory" OR
    OLD."isRestricted" IS DISTINCT FROM NEW."isRestricted" OR OLD."allowedRoleIds" IS DISTINCT FROM NEW."allowedRoleIds" OR
    OLD."allowedCircleIds" IS DISTINCT FROM NEW."allowedCircleIds"
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

DROP TRIGGER "pun68_permission_ExternalDataSource" ON "ExternalDataSource";
CREATE TRIGGER "pun68_permission_ExternalDataSource" AFTER INSERT OR DELETE OR UPDATE ON "ExternalDataSource"
 FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('ExternalDataSource',
 '["workspaceId","driverType","connectionStringEnc","selectedTables","cursorColumn","isActive","archivedAt","accessDomain","informationCategory","isRestricted","allowedRoleIds","allowedCircleIds"]');

CREATE FUNCTION pun68_information_category_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image jsonb;
BEGIN
 FOR image IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
   CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
   CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END)) WHERE value <> 'null'::jsonb LOOP
  IF EXISTS (SELECT 1 FROM "Workspace" WHERE id = image->>'workspaceId') THEN
   PERFORM pun68_bump_permission_epoch(image->>'workspaceId','InformationCategoryPolicy',image->>'category');
  END IF;
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_information_category" AFTER INSERT OR UPDATE OR DELETE ON "InformationCategoryPolicy"
 FOR EACH ROW EXECUTE FUNCTION pun68_information_category_transition();

CREATE FUNCTION pun68_sql_original_vector_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."originalPermissionEpochsJson" IS DISTINCT FROM NEW."originalPermissionEpochsJson" THEN
  RAISE EXCEPTION 'SQL attempt original permission vector is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_original_vector" BEFORE UPDATE ON "SqlIngestionAttempt"
 FOR EACH ROW EXECUTE FUNCTION pun68_sql_original_vector_immutable();

CREATE FUNCTION pun68_sql_native_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Authenticated SQL native input is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER "pun68_sql_native_immutable" BEFORE UPDATE ON "SqlNativeRunInput"
 FOR EACH ROW EXECUTE FUNCTION pun68_sql_native_immutable();
CREATE TRIGGER "pun68_permission_SqlNativeRunInput" AFTER DELETE ON "SqlNativeRunInput"
 FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('SqlNativeRunInput','[]');

CREATE FUNCTION pun68_sql_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'status'-'committedAt') IS DISTINCT FROM (to_jsonb(NEW)-'status'-'committedAt')
  OR NOT ((OLD.status='PREPARING' AND NEW.status='PREPARED' AND NEW."committedAt" IS NULL)
    OR (OLD.status='PREPARED' AND NEW.status='COMMITTED' AND NEW."committedAt" IS NOT NULL)) THEN
  RAISE EXCEPTION 'SQL publication set and terminal receipt are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_publication_immutable" BEFORE UPDATE ON "SqlKnowledgePublication"
 FOR EACH ROW EXECUTE FUNCTION pun68_sql_publication_immutable();

CREATE FUNCTION pun68_sql_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication_status text;
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM "SqlKnowledgePublication" WHERE id=OLD."publicationId") THEN RETURN OLD; END IF;
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SQL staged output is immutable' USING ERRCODE='23514'; END IF;
 SELECT status INTO publication_status FROM "SqlKnowledgePublication" WHERE id=NEW."publicationId" FOR SHARE;
 IF publication_status IS DISTINCT FROM 'PREPARING' THEN
  RAISE EXCEPTION 'SQL publication output set is sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "pun68_sql_stage_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "SqlKnowledgeStagedChunk"
 FOR EACH ROW EXECUTE FUNCTION pun68_sql_stage_immutable();
