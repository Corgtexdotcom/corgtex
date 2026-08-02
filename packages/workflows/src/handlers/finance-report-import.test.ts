import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), fail: vi.fn(), extract: vi.fn(), propose: vi.fn(), storage: { get: vi.fn() },
}));
vi.mock("@corgtex/agents", () => ({ runFinanceReportImportAgentV1: mocks.propose }));
vi.mock("@corgtex/domain", () => ({
  claimFinanceReportImportExtraction: mocks.claim,
  completeFinanceReportImportExtraction: mocks.complete,
  failFinanceReportImportExtraction: mocks.fail,
}));
vi.mock("@corgtex/knowledge", () => {
  class MockExtractionError extends Error {
    constructor(public readonly code: string, public readonly retryable = false) { super(code); }
  }
  return { extractFinanceReportFile: mocks.extract, FinanceFileExtractionError: MockExtractionError };
});
vi.mock("@corgtex/storage", () => ({ defaultStorage: mocks.storage }));
const data = Buffer.from("Account,Amount");
const hash = createHash("sha256").update(data).digest("hex");
const claim = { skipped: false, batchId: "batch-1", version: 2, storageKey: "private/report.csv",
  fileHash: hash, fileSizeBytes: data.byteLength, fileName: "synthetic.csv", mimeType: "text/csv" };
const job = { workspaceId: "workspace-1", batchId: "batch-1", workflowJobId: "job-1", attempts: 1, isFinalAttempt: false };
async function run(overrides = {}) {
  const { runFinanceReportImportExtractionJob } = await import("./finance-report-import");
  return runFinanceReportImportExtractionJob({ ...job, ...overrides });
}
describe("Finance report extraction workflow handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(claim);
    mocks.storage.get.mockResolvedValue({ data, contentType: "text/csv" });
    mocks.extract.mockResolvedValue({ fileHash: hash, fileSizeBytes: data.byteLength, format: "CSV", mimeType: "text/csv",
      sheets: [{ name: "CSV", rowCount: 1, columnCount: 2, cells: [
        { row: 1, column: 1, type: "TEXT", value: "Account" },
        { row: 1, column: 2, type: "TEXT", value: "Amount" },
      ] }] });
    mocks.complete.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
    mocks.fail.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 3 });
  });
  it("reads and completes the exact claimed report with bounded source locations", async () => {
    await expect(run()).resolves.toMatchObject({ version: 3 });
    expect(mocks.storage.get).toHaveBeenCalledWith("private/report.csv");
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2,
      extraction: expect.objectContaining({ fileHash: hash, format: "CSV",
        text: expect.stringContaining('"sheet":"CSV","row":1,"column":1'),
        metadata: { pageCount: 0, sheetCount: 1, rowCount: 1, cellCount: 2 } }) }));
  });
  it("skips a completed claim without reading storage", async () => {
    mocks.claim.mockResolvedValueOnce({ skipped: true, batchId: "batch-1", version: 3 });
    await expect(run()).resolves.toMatchObject({ skipped: true });
    expect(mocks.storage.get).not.toHaveBeenCalled();
  });
  it("persists an allowlisted deterministic failure", async () => {
    const { FinanceFileExtractionError } = await import("@corgtex/knowledge");
    mocks.extract.mockRejectedValueOnce(new FinanceFileExtractionError("MALFORMED_FILE"));
    await expect(run()).resolves.toEqual({ failed: true, failureCode: "MALFORMED_FILE" });
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2, failureCode: "MALFORMED_FILE" }));
  });
  it.each([
    ["missing storage", () => mocks.storage.get.mockResolvedValue(null), "source is unavailable"],
    ["stored-byte mismatch", () => mocks.storage.get.mockResolvedValue({ data: Buffer.from("corrupted") }), "source identity changed"],
    ["extractor pressure", async () => { const { FinanceFileExtractionError } = await import("@corgtex/knowledge");
      mocks.extract.mockRejectedValue(new FinanceFileExtractionError("EXTRACTION_LIMIT_EXCEEDED", true)); }, "EXTRACTION_LIMIT_EXCEEDED"],
  ])("retries %s and sanitizes only the final attempt", async (_label, arrange, message) => {
    await arrange();
    await expect(run()).rejects.toThrow(message);
    expect(mocks.fail).not.toHaveBeenCalled();
    await expect(run({ attempts: 5, isFinalAttempt: true })).rejects.toThrow(message);
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "FINANCE_REPORT_EXTRACTION_FAILED" }));
  });
  it("times out a stalled storage read before the workflow lease expires", async () => {
    vi.useFakeTimers();
    mocks.storage.get.mockReturnValueOnce(new Promise(() => undefined));
    const { FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS } = await import("./finance-report-import");
    const pending = expect(run()).rejects.toThrow("source read timed out");
    await vi.advanceTimersByTimeAsync(FINANCE_REPORT_IMPORT_STORAGE_READ_TIMEOUT_MS);
    await pending;
    vi.useRealTimers();
  });
  it("delegates interpretation with the exact workflow attempt", async () => {
    mocks.propose.mockResolvedValue({ id: "run-1" });
    const { runFinanceReportImportProposalJob } = await import("./finance-report-import");
    await runFinanceReportImportProposalJob({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-2", attempts: 2, isFinalAttempt: false });
    expect(mocks.propose).toHaveBeenCalledWith({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-2", attempts: 2, isFinalAttempt: false });
  });
});
