import { beforeEach, describe, expect, it, vi } from "vitest";

const { claimMock, completeMock, failMock, extractMock, storageMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  completeMock: vi.fn(),
  failMock: vi.fn(),
  extractMock: vi.fn(),
  storageMock: { get: vi.fn() },
}));

vi.mock("@corgtex/domain", () => ({
  claimFinanceReportImportExtraction: claimMock,
  completeFinanceReportImportExtraction: completeMock,
  failFinanceReportImportExtraction: failMock,
}));
vi.mock("@corgtex/knowledge", () => {
  class MockExtractionError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return { extractFinanceReportFile: extractMock, FinanceFileExtractionError: MockExtractionError };
});
vi.mock("@corgtex/storage", () => ({ defaultStorage: storageMock }));

const claim = {
  skipped: false,
  batchId: "batch-1",
  version: 2,
  storageKey: "private/report.csv",
  fileHash: "a".repeat(64),
  fileSizeBytes: 12,
  fileName: "synthetic.csv",
  mimeType: "text/csv",
};
const job = {
  workspaceId: "workspace-1",
  batchId: "batch-1",
  workflowJobId: "job-1",
  attempts: 1,
  isFinalAttempt: false,
};

describe("Finance report extraction workflow handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimMock.mockResolvedValue(claim);
    storageMock.get.mockResolvedValue({ data: Buffer.from("Account,Amount"), contentType: "text/csv" });
    extractMock.mockResolvedValue({
      fileHash: "a".repeat(64), fileSizeBytes: 12, format: "CSV", mimeType: "text/csv",
      sheets: [{ name: "CSV", rowCount: 1, columnCount: 2, cells: [
        { row: 1, column: 1, type: "TEXT", value: "Account" },
        { row: 1, column: 2, type: "TEXT", value: "Amount" },
      ] }],
    });
    completeMock.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
    failMock.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
  });

  it("reads, extracts, and completes the exact claimed report", async () => {
    const actualKnowledge = await vi.importActual<typeof import("@corgtex/knowledge")>("@corgtex/knowledge");
    const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
    await expect(runFinanceReportImportExtractionJob({
      ...job, extract: actualKnowledge.extractFinanceReportFile,
    })).resolves.toEqual({
      skipped: false, batchId: "batch-1", version: 3,
    });
    expect(storageMock.get).toHaveBeenCalledWith("private/report.csv");
    expect(completeMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 2,
      extraction: expect.objectContaining({
        fileHash: expect.stringMatching(/^[a-f0-9]{64}$/), format: "CSV",
        text: expect.stringContaining('"sheet":"CSV","row":1,"column":1'),
        metadata: { pageCount: 0, sheetCount: 1, rowCount: 1, cellCount: 2 },
      }),
    }));
    expect(failMock).not.toHaveBeenCalled();
  });

  it("skips a completed claim without reading storage", async () => {
    claimMock.mockResolvedValueOnce({ skipped: true, batchId: "batch-1", version: 3 });
    const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
    await expect(runFinanceReportImportExtractionJob(job)).resolves.toEqual({
      skipped: true, batchId: "batch-1", version: 3,
    });
    expect(storageMock.get).not.toHaveBeenCalled();
  });

  it("persists an allowlisted deterministic failure and completes the job", async () => {
    const { FinanceFileExtractionError } = await import("@corgtex/knowledge");
    extractMock.mockRejectedValueOnce(new FinanceFileExtractionError("MALFORMED_FILE"));
    const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
    await expect(runFinanceReportImportExtractionJob(job)).resolves.toEqual({
      failed: true, failureCode: "MALFORMED_FILE",
    });
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 2, failureCode: "MALFORMED_FILE",
    }));
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("retries transient storage failure and sanitizes only the final attempt", async () => {
    storageMock.get.mockResolvedValue(null);
    const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
    await expect(runFinanceReportImportExtractionJob(job)).rejects.toThrow("source is unavailable");
    expect(failMock).not.toHaveBeenCalled();
    await expect(runFinanceReportImportExtractionJob({ ...job, attempts: 5, isFinalAttempt: true }))
      .rejects.toThrow("source is unavailable");
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 2, failureCode: "FINANCE_REPORT_EXTRACTION_FAILED",
    }));
  });
});
