import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import { createFinanceReportImportUpload } from "./finance-import-upload";

const { prismaMock, storageMock, accessMock, capacityMock } = vi.hoisted(() => ({
  accessMock: vi.fn(), capacityMock: vi.fn(),
  storageMock: { put: vi.fn(), delete: vi.fn() },
  prismaMock: {
    $executeRaw: vi.fn(), $transaction: vi.fn(),
    document: { create: vi.fn() }, brainSource: { create: vi.fn() },
    financeImportBatch: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: storageMock }));
vi.mock("./finance", () => ({ requireFinanceReportImportHumanWriteAccess: accessMock }));
vi.mock("./trial-entitlements", () => ({ assertTrialStorageCapacity: capacityMock }));

const fileBuffer = Buffer.from("Account,Amount");
const actor: AppActor = {
  kind: "user",
  user: { id: "user-1", email: "user@example.com", displayName: "User", globalRole: "USER" },
};
const batch = {
  id: "batch-1", workspaceId: "workspace-1", stage: "UPLOADED",
  fileHash: createHash("sha256").update(fileBuffer).digest("hex"),
};
function upload(overrides: Partial<Parameters<typeof createFinanceReportImportUpload>[1]> = {}) {
  return createFinanceReportImportUpload(actor, {
    workspaceId: "workspace-1", fileBuffer, fileName: "report.csv", mimeType: "text/csv", ...overrides,
  });
}

describe("Finance report import upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue({});
    capacityMock.mockResolvedValue(undefined);
    storageMock.put.mockResolvedValue({ key: "stored", size: fileBuffer.length });
    storageMock.delete.mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(null);
    prismaMock.financeImportBatch.create.mockImplementation(({ data }) => Promise.resolve({ ...batch, ...data }));
    prismaMock.document.create.mockResolvedValue({});
    prismaMock.brainSource.create.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
  });

  it("stores and atomically links a locked, quota-checked Finance upload", async () => {
    const result = await upload({ fileName: " Report.csv ", mimeType: "text/csv; charset=utf-8" });
    expect(storageMock.put).toHaveBeenCalledWith(
      expect.stringMatching(/\/finance\/report-imports\/[^/]+\/Report\.csv$/),
      fileBuffer,
      { contentType: "text/csv" },
    );
    expect(capacityMock).toHaveBeenNthCalledWith(2, "workspace-1", fileBuffer.length, prismaMock);
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce();
    const document = prismaMock.document.create.mock.calls[0][0].data;
    const source = prismaMock.brainSource.create.mock.calls[0][0].data;
    expect(document).toMatchObject({ accessDomain: "FINANCE", source: "finance-report-import" });
    expect(document).not.toHaveProperty("textContent");
    expect(source).toMatchObject({ accessDomain: "FINANCE", content: "Finance report upload pending extraction." });
    expect(source).not.toHaveProperty("absorbedAt");
    expect(prismaMock.financeImportBatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      uploadedByUserId: "user-1", documentId: expect.any(String), brainSourceId: expect.any(String),
      fileHash: batch.fileHash, originalFilename: "Report.csv", stage: "UPLOADED",
    }) });
    const audit = prismaMock.auditLog.create.mock.calls[0][0];
    expect(audit.data.meta).not.toHaveProperty("storageKey");
    expect(audit.data.meta).not.toHaveProperty("fileHash");
    expect(JSON.stringify(audit)).not.toContain("Account,Amount");
    expect(result).toMatchObject({ reused: false, batch: { stage: "UPLOADED" } });
  });

  it("returns a preexisting exact hash without capacity, storage, or transaction writes", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(batch);
    await expect(upload({ mimeType: "application/octet-stream" })).resolves.toEqual({ batch, reused: true });
    expect(capacityMock).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("uses the immutable snapshot taken before authorization awaits", async () => {
    let allowAccess: (() => void) | undefined;
    accessMock.mockReturnValueOnce(new Promise<void>((resolve) => { allowAccess = resolve; }));
    const original = Buffer.from("original");
    const pending = upload({ fileBuffer: original });
    original.fill(0x78);
    allowAccess?.();
    await pending;
    expect(storageMock.put.mock.calls[0][1]).toEqual(Buffer.from("original"));
    expect(prismaMock.financeImportBatch.create.mock.calls[0][0].data.fileHash)
      .toBe(createHash("sha256").update("original").digest("hex"));
  });

  it.each([
    [Buffer.alloc(0), "report.csv", "text/csv", "EMPTY_FILE"],
    [Buffer.from("x"), "report.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "UNSUPPORTED_FILE_TYPE"],
    [Buffer.from("x"), "report.xlsx", "application/pdf", "FILE_TYPE_MISMATCH"],
    [Buffer.alloc((25 * 1024 * 1024) + 1), "report.pdf", "application/pdf", "FILE_TOO_LARGE"],
  ])("rejects invalid input before storage", async (buffer, fileName, mimeType, code) => {
    await expect(upload({ fileBuffer: buffer, fileName, mimeType })).rejects.toMatchObject({ code });
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("does not write when Finance human access fails", async () => {
    accessMock.mockRejectedValueOnce(new Error("forbidden"));
    await expect(upload()).rejects.toThrow("forbidden");
    expect(prismaMock.financeImportBatch.findUnique).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
  });

  it("cleans a stored object when the locked capacity recheck fails", async () => {
    capacityMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      new AppError(403, "TRIAL_STORAGE_LIMIT_EXCEEDED", "Trial storage limit exceeded."),
    );
    await expect(upload()).rejects.toMatchObject({ code: "TRIAL_STORAGE_LIMIT_EXCEEDED" });
    expect(storageMock.delete).toHaveBeenCalledWith(storageMock.put.mock.calls[0][0]);
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("cleans its object and returns an exact winner found after the lock", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(batch);
    await expect(upload()).resolves.toEqual({ batch, reused: true });
    expect(storageMock.delete).toHaveBeenCalledWith(storageMock.put.mock.calls[0][0]);
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("hides transaction errors after cleanup", async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error("database details"));
    await expect(upload()).rejects.toMatchObject({ code: "FINANCE_REPORT_UPLOAD_FAILED" });
    expect(storageMock.delete).toHaveBeenCalledWith(storageMock.put.mock.calls[0][0]);
  });

  it("hides provider errors and attempts cleanup", async () => {
    storageMock.put.mockRejectedValueOnce(new Error("provider details"));
    await expect(upload()).rejects.toMatchObject({ code: "FINANCE_REPORT_STORAGE_UNAVAILABLE" });
    expect(storageMock.delete).toHaveBeenCalledWith(expect.stringContaining("/finance/report-imports/"));
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
