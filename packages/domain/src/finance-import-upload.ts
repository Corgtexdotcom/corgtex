import { createHash, randomUUID } from "node:crypto";
import type { FinanceImportBatch, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";
import { AppError, invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { createFinanceImportBatchWithArtifactOwnership } from "./finance-import-artifact-ownership";
import { lockAndAssertTrialStorageCapacity } from "./trial-entitlements";

export const FINANCE_REPORT_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const STORAGE_PENDING = "FINANCE_REPORT_STORAGE_PENDING";
const STORAGE_UNAVAILABLE = "FINANCE_REPORT_STORAGE_UNAVAILABLE";

type FinanceImportStorage = Pick<StorageProvider, "put">;
type FinanceFileFormat = "CSV" | "PDF" | "XLSX";

const FILE_TYPES: Record<FinanceFileFormat, { extension: string; mimeType: string }> = {
  CSV: { extension: "csv", mimeType: "text/csv" },
  PDF: { extension: "pdf", mimeType: "application/pdf" },
  XLSX: { extension: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
};

function fileEnvelope(fileName: string, mimeType: string) {
  const originalFilename = fileName.trim();
  invariant(originalFilename.length > 0, 400, "INVALID_INPUT", "File name is required.");
  invariant(originalFilename.length <= 255 && !originalFilename.includes("\0"), 400, "INVALID_INPUT", "File name is invalid.");
  const lowerName = originalFilename.toLowerCase();
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const genericMime = !mime || mime === "application/octet-stream";
  const byName: FinanceFileFormat | undefined = lowerName.endsWith(".pdf") ? "PDF"
    : lowerName.endsWith(".csv") ? "CSV"
      : lowerName.endsWith(".xlsx") ? "XLSX"
        : undefined;
  const byMime: FinanceFileFormat | undefined = mime === "application/pdf" ? "PDF"
    : mime === "text/csv" || mime === "application/csv"
      || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV") ? "CSV"
      : mime === FILE_TYPES.XLSX.mimeType ? "XLSX"
        : undefined;
  invariant(byName, 415, "UNSUPPORTED_FILE_TYPE", "Only PDF, CSV, and XLSX finance reports are supported.");
  invariant(genericMime || byName === byMime, 400, "FILE_TYPE_MISMATCH", "The report filename and content type do not match.");
  return { format: byName, mimeType: FILE_TYPES[byName].mimeType, originalFilename };
}

function resumable(batch: FinanceImportBatch) {
  return batch.stage === "FAILED" && (batch.safeErrorCode === STORAGE_PENDING || batch.safeErrorCode === STORAGE_UNAVAILABLE);
}

function formatForMimeType(mimeType: string) {
  const format = (Object.entries(FILE_TYPES) as Array<[FinanceFileFormat, (typeof FILE_TYPES)[FinanceFileFormat]]>)
    .find(([, value]) => value.mimeType === mimeType)?.[0];
  invariant(format, 409, "FINANCE_REPORT_UPLOAD_INVALID", "The stored report type is invalid.");
  return format;
}

function storageKeyFor(workspaceId: string, fileHash: string, mimeType: string) {
  const format = formatForMimeType(mimeType);
  return `workspaces/${workspaceId}/finance/report-imports/${fileHash}/source.${FILE_TYPES[format].extension}`;
}

async function reserveUpload(actor: Extract<AppActor, { kind: "user" }>, params: {
  workspaceId: string;
  fileHash: string;
  fileSizeBytes: number;
  originalFilename: string;
  mimeType: string;
  format: FinanceFileFormat;
}) {
  try {
    return await prisma.$transaction(async (tx) => {
      const identityLock = `finance-report-import:${params.workspaceId}:${params.fileHash}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`;
      const winner = await tx.financeImportBatch.findUnique({
        where: { workspaceId_fileHash: { workspaceId: params.workspaceId, fileHash: params.fileHash } },
      });
      if (winner) return { batch: winner, created: false };
      await lockAndAssertTrialStorageCapacity(tx, params.workspaceId, params.fileSizeBytes);
      const batchId = randomUUID();
      const documentId = randomUUID();
      const brainSourceId = randomUUID();
      const storageKey = storageKeyFor(params.workspaceId, params.fileHash, params.mimeType);
      const metadata = {
        financeImportBatchId: batchId,
        fileHash: params.fileHash,
        format: params.format,
        size: params.fileSizeBytes,
        extraction: { status: "pending" },
      } as Prisma.InputJsonObject;
      await tx.document.create({ data: {
        id: documentId, workspaceId: params.workspaceId, accessDomain: "FINANCE",
        title: params.originalFilename, source: "finance-report-import", mimeType: params.mimeType,
        storageKey, metadata,
      } });
      await tx.brainSource.create({ data: {
        id: brainSourceId, workspaceId: params.workspaceId, accessDomain: "FINANCE",
        sourceType: "FILE_UPLOAD", tier: 2, title: params.originalFilename,
        channel: "finance-report-import", content: "Finance report upload pending extraction.",
        fileStorageKey: storageKey, fileName: params.originalFilename,
        fileMimeType: params.mimeType, fileSizeBytes: params.fileSizeBytes, metadata,
      } });
      const batch = await createFinanceImportBatchWithArtifactOwnership(tx, {
        id: batchId, workspaceId: params.workspaceId, uploadedByUserId: actor.user.id,
        documentId, brainSourceId, fileHash: params.fileHash, mimeType: params.mimeType,
        originalFilename: params.originalFilename, fileSizeBytes: params.fileSizeBytes,
        stage: "FAILED", safeErrorCode: STORAGE_PENDING,
        safeErrorMessage: "The report upload is being stored.",
      });
      return { batch, created: true };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "FINANCE_REPORT_UPLOAD_FAILED", "The report upload could not be prepared.");
  }
}

async function markStorageUnavailable(batch: FinanceImportBatch) {
  await prisma.financeImportBatch.updateMany({
    where: { id: batch.id, workspaceId: batch.workspaceId, stage: "FAILED", safeErrorCode: { in: [STORAGE_PENDING, STORAGE_UNAVAILABLE] } },
    data: { safeErrorCode: STORAGE_UNAVAILABLE, safeErrorMessage: "The report could not be stored. Please try again.", version: { increment: 1 } },
  }).catch(() => undefined);
}

async function finalizeUpload(batch: FinanceImportBatch, actorUserId: string, format: FinanceFileFormat) {
  let current = batch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (current.stage === "UPLOADED" && !current.safeErrorCode) return current;
    invariant(resumable(current), 409, "FINANCE_REPORT_UPLOAD_CONFLICT", "The report upload changed. Refresh and try again.");
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.financeImportBatch.updateMany({
        where: { id: current.id, workspaceId: current.workspaceId, version: current.version, stage: "FAILED", safeErrorCode: { in: [STORAGE_PENDING, STORAGE_UNAVAILABLE] } },
        data: { stage: "UPLOADED", safeErrorCode: null, safeErrorMessage: null, version: { increment: 1 } },
      });
      if (result.count !== 1) return null;
      await tx.auditLog.create({ data: {
        workspaceId: current.workspaceId, actorUserId, action: "finance-report-import.uploaded",
        entityType: "FinanceImportBatch", entityId: current.id,
        meta: { format, mimeType: current.mimeType, fileSizeBytes: current.fileSizeBytes },
      } });
      const finalized: FinanceImportBatch = {
        ...current,
        stage: "UPLOADED",
        safeErrorCode: null,
        safeErrorMessage: null,
        version: current.version + 1,
      };
      return finalized;
    });
    if (updated) return updated;
    const winner = await prisma.financeImportBatch.findUnique({ where: { id_workspaceId: { id: current.id, workspaceId: current.workspaceId } } });
    invariant(winner, 409, "FINANCE_REPORT_UPLOAD_CONFLICT", "The report upload is no longer available.");
    current = winner;
  }
  throw new AppError(409, "FINANCE_REPORT_UPLOAD_CONFLICT", "The report upload changed. Refresh and try again.");
}

export async function createFinanceReportImportUpload(actor: AppActor, params: {
  workspaceId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  storage?: FinanceImportStorage;
}): Promise<{ batch: FinanceImportBatch; reused: boolean }> {
  invariant(params.fileBuffer.byteLength <= FINANCE_REPORT_IMPORT_MAX_FILE_BYTES, 413, "FILE_TOO_LARGE", "The report file exceeds the supported size limit.");
  const snapshot = Buffer.from(params.fileBuffer);
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  invariant(snapshot.byteLength > 0, 400, "EMPTY_FILE", "The report file is empty.");
  const file = fileEnvelope(params.fileName, params.mimeType);
  const fileHash = createHash("sha256").update(snapshot).digest("hex");
  const existing = await prisma.financeImportBatch.findUnique({ where: { workspaceId_fileHash: { workspaceId: params.workspaceId, fileHash } } });
  if (existing && !resumable(existing)) return { batch: existing, reused: true };
  const reservation = existing ? { batch: existing, created: false } : await reserveUpload(actor, {
    workspaceId: params.workspaceId, fileHash, fileSizeBytes: snapshot.byteLength,
    originalFilename: file.originalFilename, mimeType: file.mimeType, format: file.format,
  });
  if (!resumable(reservation.batch)) return { batch: reservation.batch, reused: true };
  const storage = params.storage ?? defaultStorage;
  const storageKey = storageKeyFor(params.workspaceId, fileHash, reservation.batch.mimeType);
  try {
    await storage.put(storageKey, snapshot, { contentType: reservation.batch.mimeType });
  } catch {
    await markStorageUnavailable(reservation.batch);
    const winner = await prisma.financeImportBatch.findUnique({
      where: { id_workspaceId: { id: reservation.batch.id, workspaceId: reservation.batch.workspaceId } },
    }).catch(() => null);
    if (winner?.stage === "UPLOADED" && !winner.safeErrorCode) {
      return { batch: winner, reused: true };
    }
    throw new AppError(503, STORAGE_UNAVAILABLE, "The report could not be stored. Please try again.");
  }
  try {
    const batch = await finalizeUpload(reservation.batch, actor.user.id, formatForMimeType(reservation.batch.mimeType));
    return { batch, reused: !reservation.created };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "FINANCE_REPORT_UPLOAD_FAILED", "The report upload could not be finalized. Please try again.");
  }
}
