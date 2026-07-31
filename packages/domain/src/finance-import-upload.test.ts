import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { createFinanceReportImportUpload } from "./finance-import-upload";

const { prismaMock, storageMock, accessMock, capacityMock, createBatchMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  capacityMock: vi.fn(),
  createBatchMock: vi.fn(),
  storageMock: { put: vi.fn() },
  prismaMock: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    document: { create: vi.fn() },
    brainSource: { create: vi.fn() },
    financeImportBatch: { findUnique: vi.fn(), updateMany: vi.fn() },
    workflowJob: { updateMany: vi.fn() },
    event: { createMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: storageMock }));
vi.mock("./finance", () => ({ requireFinanceReportImportHumanWriteAccess: accessMock }));
vi.mock("./finance-import-artifact-ownership", () => ({ createFinanceImportBatchWithArtifactOwnership: createBatchMock }));
vi.mock("./trial-entitlements", () => ({ lockAndAssertTrialStorageCapacity: capacityMock }));

const fileBuffer = Buffer.from("Account,Amount");
const fileHash = createHash("sha256").update(fileBuffer).digest("hex");
const actor: AppActor = {
  kind: "user",
  user: { id: "user-1", email: "user@example.com", displayName: "User", globalRole: "USER" },
};
const reserved = {
  id: "batch-1", workspaceId: "workspace-1", uploadedByUserId: "user-1",
  stage: "FAILED", safeErrorCode: "FINANCE_REPORT_STORAGE_PENDING",
  safeErrorMessage: "The report upload is being stored.", fileHash,
  mimeType: "text/csv", originalFilename: "report.csv", fileSizeBytes: fileBuffer.length,
  workflowJobId: null, retryCount: 0, version: 1,
};
const uploaded = { ...reserved, stage: "UPLOADED", safeErrorCode: null, safeErrorMessage: null, version: 2 };

function upload(overrides: Partial<Parameters<typeof createFinanceReportImportUpload>[1]> = {}) {
  return createFinanceReportImportUpload(actor, {
    workspaceId: "workspace-1", fileBuffer, fileName: "report.csv", mimeType: "text/csv", ...overrides,
  });
}

describe("Finance report import upload persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue({});
    capacityMock.mockResolvedValue(undefined);
    createBatchMock.mockResolvedValue(reserved);
    storageMock.put.mockResolvedValue({ key: "stored", size: fileBuffer.length });
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(null);
    prismaMock.financeImportBatch.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.workflowJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.document.create.mockResolvedValue({});
    prismaMock.brainSource.create.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
  });

  it("owns the deterministic private key before storage and finalizes with sanitized audit", async () => {
    const result = await upload({ fileName: " Board report.csv ", mimeType: "text/csv; charset=utf-8" });
    const storageKey = `workspaces/workspace-1/finance/report-imports/${fileHash}/source.csv`;
    expect(capacityMock).toHaveBeenCalledWith(prismaMock, "workspace-1", fileBuffer.length);
    expect(prismaMock.document.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      accessDomain: "FINANCE", source: "finance-report-import", storageKey,
      metadata: expect.objectContaining({ size: fileBuffer.length }),
    }) });
    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      accessDomain: "FINANCE", fileStorageKey: storageKey, content: "Finance report upload pending extraction.",
    }) });
    expect(createBatchMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      originalFilename: "Board report.csv", stage: "FAILED", safeErrorCode: "FINANCE_REPORT_STORAGE_PENDING",
    }));
    expect(prismaMock.document.create).toHaveBeenCalledOnce();
    expect(prismaMock.brainSource.create).toHaveBeenCalledOnce();
    expect(createBatchMock).toHaveBeenCalledOnce();
    expect(prismaMock.document.create.mock.invocationCallOrder[0]).toBeLessThan(storageMock.put.mock.invocationCallOrder[0]);
    expect(storageMock.put).toHaveBeenCalledWith(storageKey, fileBuffer, { contentType: "text/csv" });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ version: 1, stage: "FAILED" }),
      data: expect.objectContaining({ stage: "UPLOADED", version: { increment: 1 } }),
    }));
    const audit = prismaMock.auditLog.create.mock.calls[0][0];
    expect(audit.data.meta).toEqual({ format: "CSV", mimeType: "text/csv", fileSizeBytes: fileBuffer.length });
    expect(JSON.stringify(audit)).not.toContain(fileHash);
    expect(JSON.stringify(audit)).not.toContain("Board report");
    expect(prismaMock.event.createMany).toHaveBeenCalledWith({ data: [{
      workspaceId: "workspace-1",
      type: "finance-report-import.uploaded",
      aggregateType: "FinanceImportBatch",
      aggregateId: "batch-1",
      payload: { batchId: "batch-1" },
    }] });
    expect(JSON.stringify(prismaMock.event.createMany.mock.calls)).not.toContain(fileHash);
    expect(JSON.stringify(prismaMock.event.createMany.mock.calls)).not.toContain("Board report");
    expect(result).toEqual({ batch: uploaded, reused: false });
  });

  it("returns a completed exact upload without capacity, transaction, or storage work", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(uploaded);
    await expect(upload({ mimeType: "application/octet-stream" })).resolves.toEqual({ batch: uploaded, reused: true });
    expect(capacityMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it.each([
    [Buffer.from("%PDF-1.7 synthetic"), "report.pdf", "application/pdf", "source.pdf"],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), "report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "source.xlsx"],
  ])("persists each non-CSV supported envelope", async (buffer, fileName, mimeType, storageSuffix) => {
    createBatchMock.mockResolvedValueOnce({ ...reserved, fileHash: createHash("sha256").update(buffer).digest("hex"), mimeType });
    await upload({ fileBuffer: buffer, fileName, mimeType });
    expect(storageMock.put.mock.calls[0][0]).toMatch(new RegExp(`/${storageSuffix}$`));
    expect(storageMock.put.mock.calls[0][2]).toEqual({ contentType: mimeType });
  });

  it("resumes a storage-failed batch on its already-owned key", async () => {
    const failed = { ...reserved, safeErrorCode: "FINANCE_REPORT_STORAGE_UNAVAILABLE", version: 4 };
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(failed);
    await expect(upload({ fileName: "renamed.pdf", mimeType: "application/pdf" }))
      .resolves.toMatchObject({ reused: true, batch: { stage: "UPLOADED", version: 5 } });
    expect(createBatchMock).not.toHaveBeenCalled();
    expect(capacityMock).not.toHaveBeenCalled();
    expect(storageMock.put.mock.calls[0][0]).toContain(`/${fileHash}/source.csv`);
    expect(prismaMock.auditLog.create.mock.calls[0][0].data.meta.format).toBe("CSV");
  });

  it("requeues the same batch after a terminal extraction runtime failure", async () => {
    const failed = {
      ...reserved, stage: "FAILED", safeErrorCode: "FINANCE_REPORT_EXTRACTION_FAILED",
      safeErrorMessage: "The report could not be extracted safely. Please retry.",
      workflowJobId: "job-previous", retryCount: 5, version: 4,
    };
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(failed);
    await expect(upload()).resolves.toMatchObject({ reused: true, batch: {
      id: "batch-1", stage: "UPLOADED", workflowJobId: null, retryCount: 0, version: 5,
    } });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ safeErrorCode: { in: expect.arrayContaining(["FINANCE_REPORT_EXTRACTION_FAILED"]) } }),
      data: expect.objectContaining({ workflowJobId: null, retryCount: 0 }),
    }));
    expect(prismaMock.workflowJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-previous", workspaceId: "workspace-1", status: "FAILED" },
      data: expect.objectContaining({ status: "PENDING", attempts: 0, completedAt: null, error: null }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledOnce();
    expect(createBatchMock).not.toHaveBeenCalled();
  });

  it("converges on the winner found under the exact-file lock", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(uploaded);
    await expect(upload()).resolves.toEqual({ batch: uploaded, reused: true });
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce();
    expect(capacityMock).not.toHaveBeenCalled();
    expect(createBatchMock).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
  });

  it("keeps durable ownership and retry state when storage is unavailable", async () => {
    prismaMock.financeImportBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("database details"));
    storageMock.put.mockRejectedValueOnce(new Error("provider details"));
    await expect(upload()).rejects.toMatchObject({ code: "FINANCE_REPORT_STORAGE_UNAVAILABLE" });
    expect(createBatchMock).toHaveBeenCalledOnce();
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ safeErrorCode: "FINANCE_REPORT_STORAGE_UNAVAILABLE" }),
    }));
    expect(JSON.stringify(prismaMock.financeImportBatch.updateMany.mock.calls)).not.toContain("provider details");
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("returns a concurrent winner when this retry's storage call fails", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce(reserved).mockResolvedValueOnce(uploaded);
    storageMock.put.mockRejectedValueOnce(new Error("provider details"));
    await expect(upload()).resolves.toEqual({ batch: uploaded, reused: true });
  });

  it("leaves the stored object owned by the reservation when finalization fails", async () => {
    prismaMock.$transaction.mockImplementationOnce((callback) => callback(prismaMock)).mockRejectedValueOnce(new Error("database details"));
    await expect(upload()).rejects.toMatchObject({ code: "FINANCE_REPORT_UPLOAD_FAILED" });
    expect(createBatchMock).toHaveBeenCalledOnce();
    expect(storageMock.put).toHaveBeenCalledOnce();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("does not append a second event when a concurrent finalizer wins", async () => {
    prismaMock.financeImportBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(uploaded);
    prismaMock.financeImportBatch.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(upload()).resolves.toEqual({ batch: uploaded, reused: false });
    expect(storageMock.put).toHaveBeenCalledOnce();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("uses the immutable snapshot taken before authorization awaits", async () => {
    let authorize: (() => void) | undefined;
    accessMock.mockReturnValueOnce(new Promise<void>((resolve) => { authorize = resolve; }));
    const original = Buffer.from("original");
    const pending = upload({ fileBuffer: original });
    original.fill(0x78);
    authorize?.();
    await pending;
    expect(storageMock.put.mock.calls[0][1]).toEqual(Buffer.from("original"));
  });

  it.each([
    [Buffer.alloc(0), "report.csv", "text/csv", "EMPTY_FILE"],
    [Buffer.from("x"), "report.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from("x"), "report.xlsx", "application/pdf", "FILE_TYPE_MISMATCH"],
    [Buffer.alloc((25 * 1024 * 1024) + 1), "report.pdf", "application/pdf", "FILE_TOO_LARGE"],
  ])("rejects invalid input before persistence", async (buffer, fileName, mimeType, code) => {
    await expect(upload({ fileBuffer: buffer, fileName, mimeType })).rejects.toMatchObject({ code });
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("does not persist when Finance human access fails", async () => {
    accessMock.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Forbidden"));
    await expect(upload()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prismaMock.financeImportBatch.findUnique).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
  });

  it("rejects an agent even if the access dependency is permissive", async () => {
    const agentActor: AppActor = { kind: "agent", authProvider: "credential", label: "Finance agent" };
    await expect(createFinanceReportImportUpload(agentActor, {
      workspaceId: "workspace-1", fileBuffer, fileName: "report.csv", mimeType: "text/csv",
    })).rejects.toMatchObject({ code: "HUMAN_REVIEW_REQUIRED" });
    expect(prismaMock.financeImportBatch.findUnique).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
  });
});
