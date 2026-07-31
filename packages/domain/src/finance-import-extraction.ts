import type { FinanceImportBatch, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import { lockFinanceImportArtifactLinkTargets } from "./finance-import-artifact-ownership";

const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

type LockedBatch = FinanceImportBatch & {
  document: {
    id: string;
    accessDomain: string;
    archivedAt: Date | null;
    storageKey: string;
    mimeType: string;
    metadata: Prisma.JsonValue | null;
  } | null;
  brainSource: {
    id: string;
    accessDomain: string;
    archivedAt: Date | null;
    fileStorageKey: string | null;
    fileMimeType: string | null;
    fileSizeBytes: number | null;
    metadata: Prisma.JsonValue | null;
  } | null;
};

function jsonObject(value: Prisma.JsonValue | null): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.InputJsonObject
    : {};
}

async function loadLockedBatch(tx: Prisma.TransactionClient, workspaceId: string, batchId: string) {
  const lockKey = `finance-report-import:${workspaceId}:${batchId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const links = await tx.financeImportBatch.findUnique({
    where: { id_workspaceId: { id: batchId, workspaceId } },
    select: { documentId: true, brainSourceId: true },
  });
  invariant(links?.documentId && links.brainSourceId, 404, "FINANCE_REPORT_IMPORT_NOT_FOUND", "The Finance report import was not found.");
  await lockFinanceImportArtifactLinkTargets(tx, {
    workspaceId,
    documentId: links.documentId,
    brainSourceId: links.brainSourceId,
  });
  const batch = await tx.financeImportBatch.findUnique({
    where: { id_workspaceId: { id: batchId, workspaceId } },
    include: { document: true, brainSource: true },
  }) as LockedBatch | null;
  invariant(batch?.document && batch.brainSource, 409, "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE", "The Finance report artifacts are no longer available.");
  invariant(
    batch.document.accessDomain === "FINANCE"
      && batch.brainSource.accessDomain === "FINANCE"
      && !batch.document.archivedAt
      && !batch.brainSource.archivedAt
      && Boolean(batch.document.storageKey)
      && batch.document.storageKey === batch.brainSource.fileStorageKey
      && batch.document.mimeType === batch.mimeType
      && batch.brainSource.fileMimeType === batch.mimeType
      && batch.brainSource.fileSizeBytes === batch.fileSizeBytes,
    409,
    "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE",
    "The Finance report artifacts are no longer available.",
  );
  return batch;
}

export async function claimFinanceReportImportExtraction(params: {
  workspaceId: string;
  batchId: string;
  workflowJobId: string;
  retryCount: number;
}) {
  invariant(Number.isSafeInteger(params.retryCount) && params.retryCount >= 0, 400, "INVALID_INPUT", "Retry count is invalid.");
  return prisma.$transaction(async (tx) => {
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    if (batch.stage !== "UPLOADED" && batch.stage !== "EXTRACTING") {
      return { skipped: true as const, batchId: batch.id, version: batch.version };
    }
    invariant(
      !batch.workflowJobId || batch.workflowJobId === params.workflowJobId,
      409,
      "FINANCE_REPORT_EXTRACTION_CONFLICT",
      "Another worker owns this Finance report extraction.",
    );
    if (batch.stage === "EXTRACTING" && params.retryCount <= batch.retryCount) {
      return {
        skipped: false as const,
        batchId: batch.id,
        version: batch.version,
        storageKey: batch.document!.storageKey,
        fileHash: batch.fileHash,
        fileSizeBytes: batch.fileSizeBytes,
        fileName: batch.originalFilename,
        mimeType: batch.mimeType,
      };
    }
    const result = await tx.financeImportBatch.updateMany({
      where: {
        id: batch.id,
        workspaceId: batch.workspaceId,
        version: batch.version,
        stage: batch.stage,
        workflowJobId: batch.workflowJobId,
      },
      data: {
        stage: "EXTRACTING",
        workflowJobId: params.workflowJobId,
        retryCount: Math.max(batch.retryCount, params.retryCount),
        safeErrorCode: null,
        safeErrorMessage: null,
        version: { increment: 1 },
      },
    });
    invariant(result.count === 1, 409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
    return {
      skipped: false as const,
      batchId: batch.id,
      version: batch.version + 1,
      storageKey: batch.document!.storageKey,
      fileHash: batch.fileHash,
      fileSizeBytes: batch.fileSizeBytes,
      fileName: batch.originalFilename,
      mimeType: batch.mimeType,
    };
  });
}

export async function completeFinanceReportImportExtraction(params: {
  workspaceId: string;
  batchId: string;
  workflowJobId: string;
  expectedVersion: number;
  extraction: {
    fileHash: string;
    fileSizeBytes: number;
    mimeType: string;
    format: "CSV" | "PDF" | "XLSX";
    text: string;
    metadata: Prisma.InputJsonObject;
  };
}) {
  return prisma.$transaction(async (tx) => {
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    if (batch.stage !== "EXTRACTING" && batch.workflowJobId === params.workflowJobId) {
      return { skipped: true as const, batchId: batch.id, version: batch.version };
    }
    invariant(
      batch.stage === "EXTRACTING"
        && batch.workflowJobId === params.workflowJobId
        && batch.version === params.expectedVersion,
      409,
      "FINANCE_REPORT_EXTRACTION_CONFLICT",
      "The Finance report extraction changed. Please retry.",
    );
    invariant(
      params.extraction.fileHash === batch.fileHash
        && params.extraction.fileSizeBytes === batch.fileSizeBytes
        && params.extraction.mimeType === batch.mimeType,
      409,
      "FINANCE_REPORT_FILE_CHANGED",
      "The stored report no longer matches the uploaded file.",
    );
    const text = params.extraction.text.trim();
    invariant(
      text.length > 0 && text.length <= MAX_EXTRACTED_TEXT_CHARS,
      422,
      "EXTRACTION_LIMIT_EXCEEDED",
      "The report exceeds the supported extraction limits.",
    );
    const extraction = {
      ...params.extraction.metadata,
      status: "complete",
      format: params.extraction.format,
      workflowJobId: params.workflowJobId,
    } satisfies Prisma.InputJsonObject;
    const result = await tx.financeImportBatch.updateMany({
      where: {
        id: batch.id,
        workspaceId: batch.workspaceId,
        version: batch.version,
        stage: "EXTRACTING",
        workflowJobId: params.workflowJobId,
      },
      data: { stage: "CLASSIFYING", safeErrorCode: null, safeErrorMessage: null, version: { increment: 1 } },
    });
    invariant(result.count === 1, 409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
    await tx.document.update({
      where: { id_workspaceId: { id: batch.document!.id, workspaceId: batch.workspaceId } },
      data: { textContent: text, metadata: { ...jsonObject(batch.document!.metadata), extraction } },
    });
    await tx.brainSource.update({
      where: { id_workspaceId: { id: batch.brainSource!.id, workspaceId: batch.workspaceId } },
      data: { content: text, metadata: { ...jsonObject(batch.brainSource!.metadata), extraction } },
    });
    await tx.auditLog.create({ data: {
      workspaceId: batch.workspaceId,
      action: "finance-report-import.extracted",
      entityType: "FinanceImportBatch",
      entityId: batch.id,
      meta: { format: params.extraction.format, mimeType: batch.mimeType, fileSizeBytes: batch.fileSizeBytes },
    } });
    return { skipped: false as const, batchId: batch.id, version: batch.version + 1 };
  });
}
