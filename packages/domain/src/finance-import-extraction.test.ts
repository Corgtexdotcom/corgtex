import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    financeImportBatch: { findUnique: vi.fn(), updateMany: vi.fn() },
    document: { findUnique: vi.fn(), update: vi.fn() },
    brainSource: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));

const uploaded = {
  id: "batch-1",
  workspaceId: "workspace-1",
  uploadedByUserId: "user-1",
  documentId: "document-1",
  brainSourceId: "source-1",
  workflowJobId: null,
  agentRunId: null,
  fileHash: "a".repeat(64),
  mimeType: "text/csv",
  originalFilename: "synthetic.csv",
  fileSizeBytes: 12,
  stage: "UPLOADED",
  safeErrorCode: null,
  safeErrorMessage: null,
  retryCount: 0,
  version: 1,
  document: {
    id: "document-1",
    accessDomain: "FINANCE",
    archivedAt: null,
    storageKey: "private/report.csv",
    mimeType: "text/csv",
    metadata: { financeImportBatchId: "batch-1" },
  },
  brainSource: {
    id: "source-1",
    accessDomain: "FINANCE",
    archivedAt: null,
    fileStorageKey: "private/report.csv",
    fileMimeType: "text/csv",
    fileSizeBytes: 12,
    metadata: { financeImportBatchId: "batch-1" },
  },
};
function setBatch(
  batch: { documentId: string; brainSourceId: string } & Record<string, unknown> = uploaded,
) {
  prismaMock.financeImportBatch.findUnique
    .mockResolvedValueOnce({ documentId: batch.documentId, brainSourceId: batch.brainSourceId })
    .mockResolvedValueOnce(batch);
}
describe("Finance report import extraction lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.document.findUnique.mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null });
    prismaMock.brainSource.findUnique.mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null });
    prismaMock.financeImportBatch.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.document.update.mockResolvedValue({});
    prismaMock.brainSource.update.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
  });

  it("claims an active Finance-owned upload under batch and artifact locks", async () => {
    setBatch();
    const { claimFinanceReportImportExtraction } = await import("./finance-import-extraction");
    await expect(claimFinanceReportImportExtraction({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      workflowJobId: "job-1",
      retryCount: 1,
    })).resolves.toMatchObject({
      skipped: false,
      version: 2,
      storageKey: "private/report.csv",
      fileHash: "a".repeat(64),
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "EXTRACTING", workflowJobId: "job-1", retryCount: 1 }),
    }));
  });

  it("resumes the same attempt but rejects stale retries and a different owner", async () => {
    const active = { ...uploaded, stage: "EXTRACTING", workflowJobId: "job-1", retryCount: 2, version: 2 };
    setBatch(active);
    const { claimFinanceReportImportExtraction } = await import("./finance-import-extraction");
    await expect(claimFinanceReportImportExtraction({
      workspaceId: "workspace-1", batchId: "batch-1", workflowJobId: "job-1", retryCount: 2,
    })).resolves.toMatchObject({ skipped: false, version: 2 });
    expect(prismaMock.financeImportBatch.updateMany).not.toHaveBeenCalled();
    for (const [workflowJobId, retryCount] of [["job-1", 1], ["job-2", 2]] as const) {
      setBatch(active);
      await expect(claimFinanceReportImportExtraction({
        workspaceId: "workspace-1", batchId: "batch-1", workflowJobId, retryCount,
      })).rejects.toMatchObject({ code: "FINANCE_REPORT_EXTRACTION_CONFLICT" });
    }
  });

  it("persists exact extracted content in both Finance artifacts and advances only to classification", async () => {
    const active = { ...uploaded, stage: "EXTRACTING", workflowJobId: "job-1", retryCount: 1, version: 2 };
    setBatch(active);
    const { completeFinanceReportImportExtraction } = await import("./finance-import-extraction");
    await expect(completeFinanceReportImportExtraction({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      workflowJobId: "job-1",
      expectedVersion: 2,
      extraction: {
        fileHash: "a".repeat(64),
        fileSizeBytes: 12,
        mimeType: "text/csv",
        format: "CSV",
        text: " Account,Amount\nRevenue,100 ",
        metadata: { sheetCount: 1 },
      },
    })).resolves.toEqual({ skipped: false, batchId: "batch-1", version: 3 });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "CLASSIFYING" }),
    }));
    expect(prismaMock.document.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ textContent: " Account,Amount\nRevenue,100 " }),
    }));
    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: " Account,Amount\nRevenue,100 " }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "finance-report-import.extracted" }),
    }));
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.document.findUnique.mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null });
    prismaMock.brainSource.findUnique.mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null });
    setBatch({ ...active, stage: "CLASSIFYING", version: 3 });
    await expect(completeFinanceReportImportExtraction({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      workflowJobId: "job-1",
      expectedVersion: 2,
      extraction: {
        fileHash: "a".repeat(64),
        fileSizeBytes: 12,
        mimeType: "text/csv",
        format: "CSV",
        text: "Account,Amount\nRevenue,100",
        metadata: {},
      },
    })).resolves.toEqual({ skipped: true, batchId: "batch-1", version: 3 });
    expect(prismaMock.financeImportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.document.update).not.toHaveBeenCalled();
  });
  it("rejects stale versions and changed file identity before artifact writes", async () => {
    const active = { ...uploaded, stage: "EXTRACTING", workflowJobId: "job-1", version: 2 };
    const { completeFinanceReportImportExtraction } = await import("./finance-import-extraction");
    for (const params of [
      { batch: active, expectedVersion: 1, fileHash: "a".repeat(64), format: "CSV", code: "FINANCE_REPORT_EXTRACTION_CONFLICT" },
      { batch: active, expectedVersion: 2, fileHash: "b".repeat(64), format: "CSV", code: "FINANCE_REPORT_FILE_CHANGED" },
      { batch: active, expectedVersion: 2, fileHash: "a".repeat(64), format: "PDF", code: "FINANCE_REPORT_FILE_CHANGED" },
      { batch: { ...active, stage: "FAILED" }, expectedVersion: 2, fileHash: "a".repeat(64), format: "CSV", code: "FINANCE_REPORT_EXTRACTION_CONFLICT" },
    ] as const) {
      setBatch(params.batch);
      await expect(completeFinanceReportImportExtraction({
        workspaceId: "workspace-1",
        batchId: "batch-1",
        workflowJobId: "job-1",
        expectedVersion: params.expectedVersion,
        extraction: {
          fileHash: params.fileHash,
          fileSizeBytes: 12,
          mimeType: "text/csv",
          format: params.format,
          text: "Revenue,100",
          metadata: {},
        },
      })).rejects.toMatchObject({ code: params.code });
    }
    expect(prismaMock.document.update).not.toHaveBeenCalled();
    expect(prismaMock.brainSource.update).not.toHaveBeenCalled();
  });

  it("records only allowlisted terminal extraction failure details", async () => {
    const active = { ...uploaded, stage: "EXTRACTING", workflowJobId: "job-1", version: 2 };
    setBatch(active);
    const { failFinanceReportImportExtraction } = await import("./finance-import-extraction");
    await expect(failFinanceReportImportExtraction({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      workflowJobId: "job-1",
      expectedVersion: 2,
      failureCode: "MALFORMED_FILE",
    })).resolves.toEqual({ skipped: false, batchId: "batch-1", version: 3 });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        stage: "FAILED",
        safeErrorCode: "MALFORMED_FILE",
        safeErrorMessage: "The report file is malformed or unreadable.",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ meta: { failureCode: "MALFORMED_FILE" } }),
    }));
    expect(prismaMock.document.update).not.toHaveBeenCalled();
    expect(prismaMock.brainSource.update).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted terminal failure code before opening a transaction", async () => {
    const { failFinanceReportImportExtraction } = await import("./finance-import-extraction");
    await expect(failFinanceReportImportExtraction({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      workflowJobId: "job-1",
      expectedVersion: 2,
      failureCode: "UNSAFE_PROVIDER_DETAIL" as never,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("idempotently skips the same terminal failure and rejects a stale owner", async () => {
    const { failFinanceReportImportExtraction } = await import("./finance-import-extraction");
    setBatch({ ...uploaded, stage: "FAILED", workflowJobId: "job-1", version: 3 });
    await expect(failFinanceReportImportExtraction({
      workspaceId: "workspace-1", batchId: "batch-1", workflowJobId: "job-1",
      expectedVersion: 2, failureCode: "MALFORMED_FILE",
    })).resolves.toEqual({ skipped: true, batchId: "batch-1", version: 3 });
    setBatch({ ...uploaded, stage: "CLASSIFYING", workflowJobId: "job-1", version: 3 });
    await expect(failFinanceReportImportExtraction({
      workspaceId: "workspace-1", batchId: "batch-1", workflowJobId: "job-1",
      expectedVersion: 2, failureCode: "FINANCE_REPORT_EXTRACTION_FAILED",
    })).rejects.toMatchObject({ code: "FINANCE_REPORT_EXTRACTION_CONFLICT" });
    expect(prismaMock.financeImportBatch.updateMany).not.toHaveBeenCalled();
  });
});
