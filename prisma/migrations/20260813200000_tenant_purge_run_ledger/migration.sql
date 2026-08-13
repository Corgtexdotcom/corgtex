-- CreateEnum
CREATE TYPE "TenantPurgeRunMode" AS ENUM (
    'ACCOUNT_WORKSPACE',
    'SELF_SERVE_TRIAL_WORKSPACE'
);

-- CreateEnum
CREATE TYPE "TenantPurgeRunStatus" AS ENUM (
    'PLANNED',
    'DRY_RUN_COMPLETE',
    'BACKUP_COMPLETE',
    'RESTORE_VERIFIED',
    'APPROVED',
    'EXECUTING',
    'CLEANUP_PENDING',
    'VERIFYING',
    'COMPLETED',
    'RESTORING',
    'RESTORED',
    'CANCELLED',
    'FAILED'
);

-- CreateTable
CREATE TABLE "TenantPurgeRun" (
    "id" TEXT NOT NULL,
    "mode" "TenantPurgeRunMode" NOT NULL,
    "status" "TenantPurgeRunStatus" NOT NULL DEFAULT 'PLANNED',
    "targetAccountId" TEXT,
    "targetDeploymentId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "targetTrialId" TEXT,
    "canonicalTargetKey" TEXT NOT NULL,
    "activeTargetKey" TEXT,
    "capabilitySha" TEXT NOT NULL,
    "manifestDigest" TEXT,
    "backupDigest" TEXT,
    "restoreDigest" TEXT,
    "manifestEvidenceRef" TEXT,
    "backupEvidenceRef" TEXT,
    "restoreEvidenceRef" TEXT,
    "executionEvidenceRef" TEXT,
    "terminalEvidenceRef" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manifestCapturedAt" TIMESTAMP(3),
    "backupCompletedAt" TIMESTAMP(3),
    "restoreVerifiedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvalExpiresAt" TIMESTAMP(3),
    "executionStartedAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "resultDatabaseRowsDeleted" INTEGER,
    "resultBlobObjectsDeleted" INTEGER,
    "resultSearchDocumentsDeleted" INTEGER,
    "resultCacheKeysCleared" INTEGER,
    "resultTargetRecordsRemaining" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantPurgeRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantPurgeRun_target_shape_check" CHECK (
        CASE "mode"
            WHEN 'ACCOUNT_WORKSPACE' THEN
                "targetAccountId" IS NOT NULL AND "targetTrialId" IS NULL
            WHEN 'SELF_SERVE_TRIAL_WORKSPACE' THEN
                "targetAccountId" IS NULL AND "targetTrialId" IS NOT NULL
        END
    ),
    CONSTRAINT "TenantPurgeRun_target_uuid_format_check" CHECK (
        ("targetAccountId" IS NULL OR "targetAccountId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        AND "targetDeploymentId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND "targetWorkspaceId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND ("targetTrialId" IS NULL OR "targetTrialId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        AND "requestedByUserId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND ("approvedByUserId" IS NULL OR "approvedByUserId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    ),
    CONSTRAINT "TenantPurgeRun_canonical_target_key_check" CHECK (
        "canonicalTargetKey" = CASE "mode"
            WHEN 'ACCOUNT_WORKSPACE' THEN
                'ACCOUNT_WORKSPACE:' || "targetAccountId" || ':' || "targetDeploymentId" || ':' || "targetWorkspaceId"
            WHEN 'SELF_SERVE_TRIAL_WORKSPACE' THEN
                'SELF_SERVE_TRIAL_WORKSPACE:' || "targetTrialId" || ':' || "targetDeploymentId" || ':' || "targetWorkspaceId"
        END
    ),
    CONSTRAINT "TenantPurgeRun_active_target_key_check" CHECK (
        CASE WHEN "status" IN ('COMPLETED', 'RESTORED', 'CANCELLED', 'FAILED')
            THEN "activeTargetKey" IS NULL
            ELSE "activeTargetKey" IS NOT DISTINCT FROM "canonicalTargetKey"
        END
    ),
    CONSTRAINT "TenantPurgeRun_capability_sha_format_check" CHECK (
        "capabilitySha" ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT "TenantPurgeRun_digest_format_check" CHECK (
        ("manifestDigest" IS NULL OR "manifestDigest" ~ '^[0-9a-f]{64}$')
        AND ("backupDigest" IS NULL OR "backupDigest" ~ '^[0-9a-f]{64}$')
        AND ("restoreDigest" IS NULL OR "restoreDigest" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "TenantPurgeRun_evidence_coherence_check" CHECK (
        (("manifestDigest" IS NULL) = ("manifestEvidenceRef" IS NULL))
        AND (("manifestDigest" IS NULL) = ("manifestCapturedAt" IS NULL))
        AND (("backupDigest" IS NULL) = ("backupEvidenceRef" IS NULL))
        AND (("backupDigest" IS NULL) = ("backupCompletedAt" IS NULL))
        AND (("restoreDigest" IS NULL) = ("restoreEvidenceRef" IS NULL))
        AND (("restoreDigest" IS NULL) = ("restoreVerifiedAt" IS NULL))
        AND (("executionStartedAt" IS NULL) = ("executionEvidenceRef" IS NULL))
        AND (("terminalAt" IS NULL) = ("terminalEvidenceRef" IS NULL))
        AND ("manifestEvidenceRef" IS NULL OR btrim("manifestEvidenceRef") <> '')
        AND ("backupEvidenceRef" IS NULL OR btrim("backupEvidenceRef") <> '')
        AND ("restoreEvidenceRef" IS NULL OR btrim("restoreEvidenceRef") <> '')
        AND ("executionEvidenceRef" IS NULL OR btrim("executionEvidenceRef") <> '')
        AND ("terminalEvidenceRef" IS NULL OR btrim("terminalEvidenceRef") <> '')
    ),
    CONSTRAINT "TenantPurgeRun_phase_dependency_check" CHECK (
        ("backupDigest" IS NULL OR "manifestDigest" IS NOT NULL)
        AND ("restoreDigest" IS NULL OR "backupDigest" IS NOT NULL)
        AND (
            "approvedByUserId" IS NULL
            OR (
                "manifestDigest" IS NOT NULL
                AND "backupDigest" IS NOT NULL
                AND "restoreDigest" IS NOT NULL
            )
        )
        AND ("executionStartedAt" IS NULL OR "approvedByUserId" IS NOT NULL)
    ),
    CONSTRAINT "TenantPurgeRun_approval_coherence_check" CHECK (
        ("approvedByUserId" IS NULL) = ("approvedAt" IS NULL)
        AND ("approvedByUserId" IS NULL) = ("approvalExpiresAt" IS NULL)
        AND ("approvedByUserId" IS NULL OR "approvedByUserId" <> "requestedByUserId")
        AND ("approvedAt" IS NULL OR "approvalExpiresAt" > "approvedAt")
        AND ("executionStartedAt" IS NULL OR "executionStartedAt" <= "approvalExpiresAt")
    ),
    CONSTRAINT "TenantPurgeRun_timestamp_order_check" CHECK (
        "requestedAt" >= "createdAt"
        AND ("manifestCapturedAt" IS NULL OR "manifestCapturedAt" >= "requestedAt")
        AND ("backupCompletedAt" IS NULL OR "backupCompletedAt" >= "manifestCapturedAt")
        AND ("restoreVerifiedAt" IS NULL OR "restoreVerifiedAt" >= "backupCompletedAt")
        AND ("approvedAt" IS NULL OR "approvedAt" >= "restoreVerifiedAt")
        AND ("executionStartedAt" IS NULL OR "executionStartedAt" >= "approvedAt")
        AND (
            "terminalAt" IS NULL
            OR "terminalAt" >= COALESCE(
                "executionStartedAt",
                "approvedAt",
                "restoreVerifiedAt",
                "backupCompletedAt",
                "manifestCapturedAt",
                "requestedAt"
            )
        )
    ),
    CONSTRAINT "TenantPurgeRun_status_phase_check" CHECK (
        CASE "status"
            WHEN 'PLANNED' THEN
                "manifestDigest" IS NULL AND "approvedAt" IS NULL AND "executionStartedAt" IS NULL AND "terminalAt" IS NULL
            WHEN 'DRY_RUN_COMPLETE' THEN
                "manifestDigest" IS NOT NULL AND "backupDigest" IS NULL AND "approvedAt" IS NULL AND "executionStartedAt" IS NULL AND "terminalAt" IS NULL
            WHEN 'BACKUP_COMPLETE' THEN
                "backupDigest" IS NOT NULL AND "restoreDigest" IS NULL AND "approvedAt" IS NULL AND "executionStartedAt" IS NULL AND "terminalAt" IS NULL
            WHEN 'RESTORE_VERIFIED' THEN
                "restoreDigest" IS NOT NULL AND "approvedAt" IS NULL AND "executionStartedAt" IS NULL AND "terminalAt" IS NULL
            WHEN 'APPROVED' THEN
                "approvedAt" IS NOT NULL AND "executionStartedAt" IS NULL AND "terminalAt" IS NULL
            WHEN 'EXECUTING' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NULL
            WHEN 'CLEANUP_PENDING' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NULL
            WHEN 'VERIFYING' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NULL
            WHEN 'RESTORING' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NULL
            WHEN 'COMPLETED' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NOT NULL
            WHEN 'RESTORED' THEN
                "executionStartedAt" IS NOT NULL AND "terminalAt" IS NOT NULL
            WHEN 'CANCELLED' THEN
                "terminalAt" IS NOT NULL
            WHEN 'FAILED' THEN
                "terminalAt" IS NOT NULL
        END
    ),
    CONSTRAINT "TenantPurgeRun_failure_code_check" CHECK (
        ("status" = 'FAILED') = ("failureCode" IS NOT NULL)
        AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,127}$')
    ),
    CONSTRAINT "TenantPurgeRun_terminal_counts_check" CHECK (
        CASE WHEN "status" IN ('COMPLETED', 'RESTORED', 'CANCELLED', 'FAILED') THEN
            "resultDatabaseRowsDeleted" IS NOT NULL
            AND "resultBlobObjectsDeleted" IS NOT NULL
            AND "resultSearchDocumentsDeleted" IS NOT NULL
            AND "resultCacheKeysCleared" IS NOT NULL
            AND "resultTargetRecordsRemaining" IS NOT NULL
            AND "resultDatabaseRowsDeleted" >= 0
            AND "resultBlobObjectsDeleted" >= 0
            AND "resultSearchDocumentsDeleted" >= 0
            AND "resultCacheKeysCleared" >= 0
            AND "resultTargetRecordsRemaining" >= 0
        ELSE
            "resultDatabaseRowsDeleted" IS NULL
            AND "resultBlobObjectsDeleted" IS NULL
            AND "resultSearchDocumentsDeleted" IS NULL
            AND "resultCacheKeysCleared" IS NULL
            AND "resultTargetRecordsRemaining" IS NULL
        END
        AND ("status" <> 'COMPLETED' OR "resultTargetRecordsRemaining" = 0)
    ),
    CONSTRAINT "TenantPurgeRun_reason_check" CHECK (
        btrim("reason") <> '' AND char_length("reason") <= 2000
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantPurgeRun_activeTargetKey_key" ON "TenantPurgeRun"("activeTargetKey");

-- CreateIndex
CREATE INDEX "TenantPurgeRun_canonicalTargetKey_createdAt_idx" ON "TenantPurgeRun"("canonicalTargetKey", "createdAt");

-- CreateIndex
CREATE INDEX "TenantPurgeRun_status_createdAt_idx" ON "TenantPurgeRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TenantPurgeRun_requestedByUserId_createdAt_idx" ON "TenantPurgeRun"("requestedByUserId", "createdAt");
