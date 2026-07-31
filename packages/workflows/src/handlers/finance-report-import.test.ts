import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { claimMock, completeMock, failMock, extractMock, storageMock } = vi.hoisted(() => ({
  claimMock: vi.fn(), completeMock: vi.fn(), failMock: vi.fn(), extractMock: vi.fn(),
  storageMock: { get: vi.fn() },
}));
vi.mock("@corgtex/domain", () => ({
  claimFinanceReportImportExtraction: claimMock,
  completeFinanceReportImportExtraction: completeMock,
  failFinanceReportImportExtraction: failMock,
}));
vi.mock("@corgtex/knowledge", () => {
  class MockExtractionError extends Error {
    constructor(public readonly code: string, public readonly retryable = false) { super(code); }
  }
  return { extractFinanceReportFile: extractMock, FinanceFileExtractionError: MockExtractionError };
});
vi.mock("@corgtex/storage", () => ({ defaultStorage: storageMock }));

const storedData = Buffer.from("Account,Amount"), storedHash = createHash("sha256").update(storedData).digest("hex");
const claim = {
  skipped: false, batchId: "batch-1", version: 2, storageKey: "private/report.csv",
  fileHash: storedHash, fileSizeBytes: storedData.byteLength,
  fileName: "synthetic.csv", mimeType: "text/csv",
};
const job = { workspaceId: "workspace-1", batchId: "batch-1", workflowJobId: "job-1", attempts: 1, isFinalAttempt: false };
async function run(overrides = {}) {
  const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
  return runFinanceReportImportExtractionJob({ ...job, ...overrides });
}

describe("Finance report extraction workflow handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimMock.mockResolvedValue(claim);
    storageMock.get.mockResolvedValue({ data: storedData, contentType: "text/csv" });
    extractMock.mockResolvedValue({
      fileHash: storedHash, fileSizeBytes: storedData.byteLength, format: "CSV", mimeType: "text/csv",
      sheets: [{ name: "CSV", rowCount: 1, columnCount: 2, cells: [
        { row: 1, column: 1, type: "TEXT", value: "Account" },
        { row: 1, column: 2, type: "TEXT", value: "Amount" },
      ] }],
    });
    completeMock.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
    failMock.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
  });
  it("reads, extracts, and completes the exact claimed report", async () => {
    const actual = await vi.importActual<typeof import("@corgtex/knowledge")>("@corgtex/knowledge");
    await expect(run({ extract: actual.extractFinanceReportFile })).resolves.toMatchObject({ version: 3 });
    expect(storageMock.get).toHaveBeenCalledWith("private/report.csv");
    expect(completeMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 2,
      extraction: expect.objectContaining({
        fileHash: storedHash, format: "CSV",
        text: expect.stringContaining('"sheet":"CSV","row":1,"column":1'),
        metadata: { pageCount: 0, sheetCount: 1, rowCount: 1, cellCount: 2 },
      }),
    }));
    expect(failMock).not.toHaveBeenCalled();
  });

  it("skips a completed claim without reading storage", async () => {
    claimMock.mockResolvedValueOnce({ skipped: true, batchId: "batch-1", version: 3 });
    await expect(run()).resolves.toMatchObject({ skipped: true, version: 3 });
    expect(storageMock.get).not.toHaveBeenCalled();
  });

  it("persists an allowlisted deterministic failure and completes the job", async () => {
    const { FinanceFileExtractionError } = await import("@corgtex/knowledge");
    extractMock.mockRejectedValueOnce(new FinanceFileExtractionError("MALFORMED_FILE"));
    await expect(run()).resolves.toEqual({ failed: true, failureCode: "MALFORMED_FILE" });
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2, failureCode: "MALFORMED_FILE" }));
    expect(completeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing storage", () => storageMock.get.mockResolvedValue(null), "source is unavailable"],
    ["stored-byte mismatch", () => storageMock.get.mockResolvedValue({ data: Buffer.from("corrupted") }), "source identity changed"],
  ])("retries %s and sanitizes only the final attempt", async (_label, arrange, message) => {
    arrange();
    await expect(run()).rejects.toThrow(message);
    expect(failMock).not.toHaveBeenCalled();
    await expect(run({ attempts: 5, isFinalAttempt: true })).rejects.toThrow(message);
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "FINANCE_REPORT_EXTRACTION_FAILED" }));
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("retries extractor infrastructure failures", async () => {
    const { FinanceFileExtractionError } = await import("@corgtex/knowledge");
    const error = new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED", true);
    extractMock.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(failMock).not.toHaveBeenCalled();
    await expect(run({ attempts: 5, isFinalAttempt: true })).rejects.toBe(error);
    expect(failMock).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "FINANCE_REPORT_EXTRACTION_FAILED" }));
  });

  it("times out a stalled storage read before the workflow lease expires", async () => {
    vi.useFakeTimers();
    storageMock.get.mockReturnValueOnce(new Promise(() => undefined));
    const { FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS } = await import("./finance-report-import");
    const pending = expect(run()).rejects.toThrow("source read timed out");
    await vi.advanceTimersByTimeAsync(FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS);
    await pending;
    expect(extractMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
