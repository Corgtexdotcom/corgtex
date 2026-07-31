import { createHash, randomUUID } from "node:crypto";
import type { FinanceImportBatch, Prisma } from "@prisma/client";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";
import { prisma, type AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { assertTrialStorageCapacity } from "./trial-entitlements";

export const FINANCE_REPORT_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;

type FinanceImportStorage = Pick<StorageProvider, "put" | "delete">;
type FinanceFileFormat = "CSV" | "PDF" | "XLSX";

const CANONICAL_MIME: Record<FinanceFileFormat, string> = {
  CSV: "text/csv",
  PDF: "application/pdf",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function financeFileEnvelope(fileName: string, mimeType: string) {
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
      || ((mime === "text/plain" || mime === "application/vnd.ms-excel") && byName === "CSV")
      ? "CSV"
      : mime === CANONICAL_MIME.XLSX ? "XLSX"
        : undefined;
  invariant(byName, 415, "UNSUPPORTED_FILE_TYPE", "Only PDF, CSV, and XLSX finance reports are supported.");
  invariant(genericMime || byName === byMime, 400, "FILE_TYPE_MISMATCH", "The report filename and content type do not match.");
  const storageName = originalFilename
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return { format: byName, mimeType: CANONICAL_MIME[byName], originalFilename, storageName };
}

function workspaceHashConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") return false;
  const meta = "meta" in error && error.meta && typeof error.meta === "object" ? error.meta : null;
  const target = meta && "target" in meta ? meta.target : null;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return fields.some((field) => field.includes("workspaceId"))
    && fields.some((field) => field.includes("fileHash"));
}

async function existingBatch(workspaceId: string, fileHash: string) {
  return prisma.financeImportBatch.findUnique({
    where: { workspaceId_fileHash: { workspaceId, fileHash } },
  });
}

export async function createFinanceReportImportUpload(actor: AppActor, params: {
  workspaceId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  storage?: FinanceImportStorage;
}): Promise<{ batch: FinanceImportBatch; reused: boolean }> {
  const snapshot = Buffer.from(params.fileBuffer);
  await requireFinanceReportImportHumanWriteAccess(actor, params.workspaceId);
  invariant(actor.kind === "user", 403, "FORBIDDEN", "A human Finance writer is required.");
  invariant(snapshot.byteLength > 0, 400, "EMPTY_FILE", "The report file is empty.");
  invariant(
    snapshot.byteLength <= FINANCE_REPORT_IMPORT_MAX_FILE_BYTES,
    413,
    "FILE_TOO_LARGE",
    "The report file exceeds the supported size limit.",
  );
  const file = financeFileEnvelope(params.fileName, params.mimeType);
  const fileHash = createHash("sha256").update(snapshot).digest("hex");
  const duplicate = await existingBatch(params.workspaceId, fileHash);
  if (duplicate) return { batch: duplicate, reused: true };

  await assertTrialStorageCapacity(params.workspaceId, snapshot.byteLength);
  const storage = params.storage ?? defaultStorage;
  const batchId = randomUUID();
  const documentId = randomUUID();
  const brainSourceId = randomUUID();
  const storageKey = `workspaces/${params.workspaceId}/finance/report-imports/${randomUUID()}/${file.storageName}`;
  try {
    await storage.put(storageKey, snapshot, { contentType: file.mimeType });
  } catch {
    await storage.delete(storageKey).catch(() => undefined);
    throw new AppError(503, "FINANCE_REPORT_STORAGE_UNAVAILABLE", "The report could not be stored. Please try again.");
  }

  try {
    const batch = await prisma.$transaction(async (tx) => {
      await tx.document.create({
        data: {
          id: documentId,
          workspaceId: params.workspaceId,
          accessDomain: "FINANCE",
          title: file.originalFilename,
          source: "finance-report-import",
          mimeType: file.mimeType,
          storageKey,
          metadata: {
            financeImportBatchId: batchId,
            fileHash,
            fileName: file.originalFilename,
            format: file.format,
            size: snapshot.byteLength,
            extraction: { status: "pending" },
          } as Prisma.InputJsonObject,
        },
      });
      await tx.brainSource.create({
        data: {
          id: brainSourceId,
          workspaceId: params.workspaceId,
          accessDomain: "FINANCE",
          sourceType: "FILE_UPLOAD",
          tier: 2,
          title: file.originalFilename,
          channel: "finance-report-import",
          content: "Finance report upload pending extraction.",
          fileStorageKey: storageKey,
          fileName: file.originalFilename,
          fileMimeType: file.mimeType,
          fileSizeBytes: snapshot.byteLength,
          metadata: {
            documentId,
            financeImportBatchId: batchId,
            fileHash,
            format: file.format,
            extraction: { status: "pending" },
          } as Prisma.InputJsonObject,
        },
      });
      const created = await tx.financeImportBatch.create({
        data: {
          id: batchId,
          workspaceId: params.workspaceId,
          uploadedByUserId: actor.user.id,
          documentId,
          brainSourceId,
          fileHash,
          mimeType: file.mimeType,
          originalFilename: file.originalFilename,
          fileSizeBytes: snapshot.byteLength,
          stage: "UPLOADED",
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actor.user.id,
          action: "finance-report-import.uploaded",
          entityType: "FinanceImportBatch",
          entityId: batchId,
          meta: {
            documentId,
            brainSourceId,
            format: file.format,
            mimeType: file.mimeType,
            fileSizeBytes: snapshot.byteLength,
          },
        },
      });
      return created;
    });
    return { batch, reused: false };
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    if (workspaceHashConflict(error)) {
      const winner = await existingBatch(params.workspaceId, fileHash);
      if (winner) return { batch: winner, reused: true };
    }
    throw new AppError(500, "FINANCE_REPORT_UPLOAD_FAILED", "The report upload could not be completed.");
  }
}
