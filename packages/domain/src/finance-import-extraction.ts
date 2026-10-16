import type { BrainSource, Document, FinanceImportBatch, Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import { assertFinanceExtractionLease, createFinanceExtractionReceipt, resolveFinanceUploadInputs, validateFinanceExtractionReceipt,
  type FinanceExtractionLease, type FinanceExtractionReceipt } from "./finance-import-lineage";
import { advanceHumanArtifactInputLineage, captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import { lockFinanceImportArtifactLinkTargets } from "./finance-import-artifact-ownership";

const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
const FORMAT_MIME_TYPES = { CSV: "text/csv", PDF: "application/pdf", XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as const;
const COMPLETED_EXTRACTION_STAGES = new Set(["CLASSIFYING", "MAPPING", "RECONCILING", "READY_FOR_REVIEW", "APPLYING", "APPLIED", "NEEDS_INPUT", "PARTIALLY_APPLIED"]);
const SAFE_EXTRACTION_FAILURES = {
  EMPTY_FILE: "The report file is empty.",
  FILE_TOO_LARGE: "The report file exceeds the supported size limit.",
  UNSUPPORTED_FILE_TYPE: "Only PDF, CSV, and XLSX finance reports are supported.",
  FILE_TYPE_MISMATCH: "The report filename and content type do not match.",
  MALFORMED_FILE: "The report file is malformed or unreadable.",
  EMPTY_EXTRACTION: "The report contains no extractable data.",
  SCANNED_PDF_UNSUPPORTED: "Image-only or scanned PDFs are not supported yet.",
  UNSUPPORTED_PDF_FEATURE: "This PDF uses a structure that cannot be extracted safely.",
  UNSUPPORTED_XLSX_FEATURE: "This workbook uses a structure that cannot be extracted safely.",
  EXTRACTION_LIMIT_EXCEEDED: "The report exceeds the supported extraction limits.",
  FINANCE_REPORT_EXTRACTION_FAILED: "The report could not be extracted safely. Please retry.",
} as const;

export type FinanceReportExtractionFailureCode = keyof typeof SAFE_EXTRACTION_FAILURES;

type LockedBatch = FinanceImportBatch & { document: Document | null; brainSource: BrainSource | null };

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
  expectedLease?: FinanceExtractionLease;
}) {
  invariant(Number.isSafeInteger(params.retryCount) && params.retryCount >= 0, 400, "INVALID_INPUT", "Retry count is invalid.");
  return prisma.$transaction(async (tx) => {
    await assertFinanceExtractionLease(tx, { ...params, attempts: params.retryCount });
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    const captured = await resolveFinanceUploadInputs(batch, tx);
    await captureArtifactInputProof(captured.actor, params.workspaceId, [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
    if (batch.stage !== "UPLOADED" && batch.stage !== "EXTRACTING") {
      return { skipped: true as const, batchId: batch.id, version: batch.version };
    }
    invariant(
      !batch.workflowJobId || batch.workflowJobId === params.workflowJobId,
      409,
      "FINANCE_REPORT_EXTRACTION_CONFLICT",
      "Another worker owns this Finance report extraction.",
    );
    invariant(batch.stage !== "EXTRACTING" || params.retryCount >= batch.retryCount, 409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "A newer Finance report extraction attempt owns this batch.");
    if (batch.stage === "EXTRACTING" && params.retryCount === batch.retryCount) {
      return {
        skipped: false as const,
        batchId: batch.id,
        version: batch.version,
        storageKey: batch.document!.storageKey,
        fileHash: batch.fileHash,
        fileSizeBytes: batch.fileSizeBytes,
        fileName: batch.originalFilename,
        mimeType: batch.mimeType,
        receipt: await createFinanceExtractionReceipt(tx, {
          ...params, version: batch.version, attempts: params.retryCount, expectedLease: params.expectedLease! }),
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
    const after = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: batch.id, workspaceId: batch.workspaceId } } });
    await advanceHumanArtifactInputLineage({ tx, actor: captured.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: batch.id }, before: batch, after, allowSystemTransition: true });
    return {
      skipped: false as const,
      batchId: batch.id,
      version: batch.version + 1,
      storageKey: batch.document!.storageKey,
      fileHash: batch.fileHash,
      fileSizeBytes: batch.fileSizeBytes,
      fileName: batch.originalFilename,
      mimeType: batch.mimeType,
      receipt: await createFinanceExtractionReceipt(tx, {
        ...params, version: batch.version + 1, attempts: params.retryCount, expectedLease: params.expectedLease! }),
    };
  });
}

export async function completeFinanceReportImportExtraction(params: {
  workspaceId: string;
  batchId: string;
  workflowJobId: string;
  expectedVersion: number;
  receipt?: FinanceExtractionReceipt;
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
    const authority = await validateFinanceExtractionReceipt(params.receipt, params, tx);
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    if (COMPLETED_EXTRACTION_STAGES.has(batch.stage) && batch.workflowJobId === params.workflowJobId) {
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
        && params.extraction.mimeType === batch.mimeType
        && FORMAT_MIME_TYPES[params.extraction.format] === batch.mimeType,
      409,
      "FINANCE_REPORT_FILE_CHANGED",
      "The stored report no longer matches the uploaded file.",
    );
    const text = params.extraction.text;
    invariant(
      text.trim().length > 0 && text.length <= MAX_EXTRACTED_TEXT_CHARS,
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
    // Preserve the exact upload and existing source metadata before either mutable body changes.
    const batchRoots = await captureArtifactInputProof(authority.actor, params.workspaceId, [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
    const frozenRoots = await captureImmutableArtifactInputProof(authority.actor, params.workspaceId, [...authority.roots, ...batchRoots], tx);
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
    const document = await tx.document.update({
      where: { id_workspaceId: { id: batch.document!.id, workspaceId: batch.workspaceId } },
      data: { textContent: text, metadata: { ...jsonObject(batch.document!.metadata), extraction } },
    });
    await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "Document", id: document.id }, content: document, origin: "DERIVED", inputs: [], inheritedRoots: frozenRoots });
    const documentRoots = await captureArtifactInputProof(authority.actor, params.workspaceId,
      [{ kind: "Document", id: document.id, snapshot: document }], tx);
    const source = await tx.brainSource.update({
      where: { id_workspaceId: { id: batch.brainSource!.id, workspaceId: batch.workspaceId } },
      data: { content: text, metadata: { ...jsonObject(batch.brainSource!.metadata), extraction } },
    });
    await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "DERIVED", inputs: [],
      inheritedRoots: [...frozenRoots, ...documentRoots] });
    const current = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: batch.id, workspaceId: batch.workspaceId } } });
    const sourceRoots = await captureArtifactInputProof(authority.actor, params.workspaceId,
      [{ kind: "BrainSource", id: source.id, snapshot: source }], tx);
    await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: current.id }, content: current, origin: "DERIVED", inputs: [],
      inheritedRoots: [...frozenRoots, ...documentRoots, ...sourceRoots] });
    await tx.event.create({ data: {
      workspaceId: batch.workspaceId, type: "finance-report-import.extracted", aggregateType: "FinanceImportBatch",
      aggregateId: batch.id, payload: { batchId: batch.id, expectedVersion: batch.version + 1 },
    } });
    await tx.event.create({ data: {
      workspaceId: batch.workspaceId, type: "document.updated", aggregateType: "Document",
      aggregateId: batch.document!.id, payload: { documentId: batch.document!.id },
    } });
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

export async function failFinanceReportImportExtraction(params: {
  workspaceId: string; batchId: string; workflowJobId: string; expectedVersion: number;
  failureCode: FinanceReportExtractionFailureCode;
  receipt?: FinanceExtractionReceipt;
}) {
  invariant(Object.hasOwn(SAFE_EXTRACTION_FAILURES, params.failureCode), 400, "INVALID_INPUT", "Extraction failure code is invalid.");
  return prisma.$transaction(async (tx) => {
    const authority = await validateFinanceExtractionReceipt(params.receipt, params, tx);
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    await captureArtifactInputProof(authority.actor, params.workspaceId, [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
    const owned = batch.workflowJobId === params.workflowJobId;
    if (batch.stage === "FAILED" && owned) return { skipped: true as const, batchId: batch.id, version: batch.version };
    invariant(batch.stage === "EXTRACTING" && owned && batch.version === params.expectedVersion,
      409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
    const result = await tx.financeImportBatch.updateMany({
      where: { id: batch.id, workspaceId: batch.workspaceId, version: batch.version, stage: "EXTRACTING", workflowJobId: params.workflowJobId },
      data: { stage: "FAILED", safeErrorCode: params.failureCode,
        safeErrorMessage: SAFE_EXTRACTION_FAILURES[params.failureCode], version: { increment: 1 } },
    });
    invariant(result.count === 1, 409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
    const after = await tx.financeImportBatch.findUniqueOrThrow({ where: { id_workspaceId: { id: batch.id, workspaceId: batch.workspaceId } } });
    await advanceHumanArtifactInputLineage({ tx, actor: authority.actor, workspaceId: params.workspaceId,
      artifact: { kind: "FinanceImportBatch", id: batch.id }, before: batch, after, allowSystemTransition: true });
    await tx.auditLog.create({ data: {
      workspaceId: batch.workspaceId, action: "finance-report-import.extraction-failed", entityType: "FinanceImportBatch",
      entityId: batch.id, meta: { failureCode: params.failureCode },
    } });
    return { skipped: false as const, batchId: batch.id, version: batch.version + 1 };
  });
}

/** Recheck the opaque claim before and after any storage/parser work. */
export async function assertFinanceReportImportExtractionCurrent(params: {
  workspaceId: string; batchId: string; workflowJobId: string; expectedVersion: number; receipt: FinanceExtractionReceipt;
}) {
  await prisma.$transaction(async tx => {
    await validateFinanceExtractionReceipt(params.receipt, params, tx);
    const batch = await loadLockedBatch(tx, params.workspaceId, params.batchId);
    invariant(batch.stage === "EXTRACTING" && batch.workflowJobId === params.workflowJobId && batch.version === params.expectedVersion,
      409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
  });
}
