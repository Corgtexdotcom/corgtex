import { createHash } from "node:crypto";
import { claimFinanceReportImportExtraction, completeFinanceReportImportExtraction,
  failFinanceReportImportExtraction, type FinanceReportExtractionFailureCode } from "@corgtex/domain";
import { extractFinanceReportFile, FinanceFileExtractionError,
  type FinanceFileExtraction } from "@corgtex/knowledge";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";
import { runFinanceReportImportAgentV1 } from "@corgtex/agents";

export const FINANCE_REPORT_IMPORT_EXTRACTION_JOB_TYPE = "finance-report-import.extract";
export const FINANCE_REPORT_IMPORT_PROPOSAL_JOB_TYPE = "finance-report-import.interpret";
export const FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
type ExtractionStorage = Pick<StorageProvider, "get">;
type ExtractionJob = { workspaceId: string; batchId: string; workflowJobId: string;
  attempts: number; isFinalAttempt: boolean; storage?: ExtractionStorage; extract?: typeof extractFinanceReportFile };

async function readStoredReport(storage: ExtractionStorage, storageKey: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Finance report source read timed out.")), FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([storage.get(storageKey), expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function extractedText(extraction: FinanceFileExtraction) {
  const lines: string[] = [];
  let chars = 0;
  const append = (value: unknown) => {
    const line = JSON.stringify(value);
    chars += line.length + Number(lines.length > 0);
    if (chars > MAX_EXTRACTED_TEXT_CHARS) {
      throw new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED");
    }
    lines.push(line);
  };
  for (const page of extraction.pages ?? []) append(page);
  for (const sheet of extraction.sheets ?? []) {
    append({ sheet: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount });
    for (const cell of sheet.cells) append({ sheet: sheet.name, ...cell });
  }
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

export async function runFinanceReportImportExtractionJob(params: ExtractionJob) {
  const identity = { workspaceId: params.workspaceId, batchId: params.batchId, workflowJobId: params.workflowJobId };
  const claim = await claimFinanceReportImportExtraction({ ...identity, retryCount: params.attempts });
  if (claim.skipped) return claim;
  try {
    const stored = await readStoredReport(params.storage ?? defaultStorage, claim.storageKey);
    if (!stored) throw new Error("Finance report source is unavailable.");
    const storedHash = createHash("sha256").update(stored.data).digest("hex");
    if (stored.data.byteLength !== claim.fileSizeBytes || storedHash !== claim.fileHash) {
      throw new Error("Finance report source identity changed.");
    }
    const extraction = await (params.extract ?? extractFinanceReportFile)({
      fileBuffer: stored.data, fileName: claim.fileName, mimeType: claim.mimeType,
    });
    return completeFinanceReportImportExtraction({ ...identity, expectedVersion: claim.version,
      extraction: {
        fileHash: extraction.fileHash, fileSizeBytes: extraction.fileSizeBytes,
        mimeType: extraction.mimeType, format: extraction.format,
        text: extractedText(extraction), metadata: extractionCounts(extraction),
      },
    });
  } catch (error) {
    const deterministic = error instanceof FinanceFileExtractionError && !error.retryable;
    const failureCode: FinanceReportExtractionFailureCode | null = deterministic
      ? error.code : params.isFinalAttempt ? "FINANCE_REPORT_EXTRACTION_FAILED" : null;
    if (failureCode) {
      await failFinanceReportImportExtraction({ ...identity, expectedVersion: claim.version, failureCode });
      if (deterministic) return { failed: true as const, failureCode };
    }
    throw error;
  }
}

export async function runFinanceReportImportProposalJob(params: { workspaceId: string; batchId: string; expectedVersion: number;
  workflowJobId: string; attempts: number; isFinalAttempt: boolean }) {
  return runFinanceReportImportAgentV1(params);
}
