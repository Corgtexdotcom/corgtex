import {
  claimFinanceReportImportExtraction,
  completeFinanceReportImportExtraction,
  failFinanceReportImportExtraction,
  type FinanceReportExtractionFailureCode,
} from "@corgtex/domain";
import {
  extractFinanceReportFile,
  FinanceFileExtractionError,
  type FinanceFileExtraction,
} from "@corgtex/knowledge";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";

export const FINANCE_REPORT_IMPORT_EXTRACTION_JOB_TYPE = "finance-report-import.extract";
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

type ExtractionStorage = Pick<StorageProvider, "get">;
type Extractor = typeof extractFinanceReportFile;

function extractedText(extraction: FinanceFileExtraction) {
  const lines: string[] = [];
  let length = 0;
  const append = (value: unknown) => {
    const line = JSON.stringify(value);
    length += line.length + (lines.length > 0 ? 1 : 0);
    if (length > MAX_EXTRACTED_TEXT_CHARS) {
      throw new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED");
    }
    lines.push(line);
  };
  extraction.pages?.forEach((page) => append(page));
  extraction.sheets?.forEach((sheet) => {
    append({ sheet: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount });
    sheet.cells.forEach((cell) => append({ sheet: sheet.name, ...cell }));
  });
  return lines.join("\n");
}

function extractionCounts(extraction: FinanceFileExtraction) {
  return {
    pageCount: extraction.pages?.length ?? 0,
    sheetCount: extraction.sheets?.length ?? 0,
    rowCount: extraction.sheets?.reduce((count, sheet) => count + sheet.rowCount, 0) ?? 0,
    cellCount: extraction.sheets?.reduce((count, sheet) => count + sheet.cells.length, 0) ?? 0,
  };
}

export async function runFinanceReportImportExtractionJob(params: {
  workspaceId: string;
  batchId: string;
  workflowJobId: string;
  attempts: number;
  isFinalAttempt: boolean;
  storage?: ExtractionStorage;
  extract?: Extractor;
}) {
  const claim = await claimFinanceReportImportExtraction({
    workspaceId: params.workspaceId,
    batchId: params.batchId,
    workflowJobId: params.workflowJobId,
    retryCount: params.attempts,
  });
  if (claim.skipped) return claim;
  try {
    const stored = await (params.storage ?? defaultStorage).get(claim.storageKey);
    if (!stored) throw new Error("Finance report source is unavailable.");
    const extraction = await (params.extract ?? extractFinanceReportFile)({
      fileBuffer: stored.data,
      fileName: claim.fileName,
      mimeType: claim.mimeType,
    });
    return completeFinanceReportImportExtraction({
      workspaceId: params.workspaceId,
      batchId: params.batchId,
      workflowJobId: params.workflowJobId,
      expectedVersion: claim.version,
      extraction: {
        fileHash: extraction.fileHash,
        fileSizeBytes: extraction.fileSizeBytes,
        mimeType: extraction.mimeType,
        format: extraction.format,
        text: extractedText(extraction),
        metadata: extractionCounts(extraction),
      },
    });
  } catch (error) {
    const failureCode: FinanceReportExtractionFailureCode | null = error instanceof FinanceFileExtractionError
      ? error.code
      : params.isFinalAttempt
        ? "FINANCE_REPORT_EXTRACTION_FAILED"
        : null;
    if (failureCode) {
      await failFinanceReportImportExtraction({
        workspaceId: params.workspaceId,
        batchId: params.batchId,
        workflowJobId: params.workflowJobId,
        expectedVersion: claim.version,
        failureCode,
      });
      if (error instanceof FinanceFileExtractionError) return { failed: true as const, failureCode };
    }
    throw error;
  }
}
