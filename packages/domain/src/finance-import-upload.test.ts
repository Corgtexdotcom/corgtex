import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, storageMock, accessMock, capacityMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  capacityMock: vi.fn(),
  storageMock: { put: vi.fn(), delete: vi.fn() },
  prismaMock: {
    $transaction: vi.fn(),
    document: { create: vi.fn() },
    brainSource: { create: vi.fn() },
    financeImportBatch: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: storageMock }));
vi.mock("./finance", () => ({ requireFinanceReportImportHumanWriteAccess: accessMock }));
vi.mock("./trial-entitlements", () => ({ assertTrialStorageCapacity: capacityMock }));

const actor: AppActor = {
  kind: "user",
  user: { id: "user-1", email: "user@example.com", displayName: "User", globalRole: "USER" },
};
const batch = {
  id: "batch-1",
  workspaceId: "workspace-1",
  fileHash: createHash("sha256").update("Account,Amount").digest("hex"),
  stage: "UPLOADED",
};

describe("Finance report import upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue({});
    capacityMock.mockResolvedValue(undefined);
    storageMock.put.mockResolvedValue({ key: "stored", size: 14 });
    storageMock.delete.mockResolvedValue(undefined);
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(null);
    prismaMock.financeImportBatch.create.mockImplementation(({ data }) => Promise.resolve({ ...batch, ...data }));
    prismaMock.document.create.mockResolvedValue({});
    prismaMock.brainSource.create.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock));
  });

  it("stores one immutable private file and creates linked Finance records atomically", async () => {
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    const fileBuffer = Buffer.from("Account,Amount");
    const result = await createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer,
      fileName: " Report.csv ",
      mimeType: "text/csv; charset=utf-8",
    });

    expect(accessMock).toHaveBeenCalledWith(actor, "workspace-1");
    expect(storageMock.put).toHaveBeenCalledWith(
      expect.stringMatching(/^workspaces\/workspace-1\/finance\/report-imports\/[^/]+\/Report\.csv$/),
      fileBuffer,
      { contentType: "text/csv" },
    );
    const documentData = prismaMock.document.create.mock.calls[0]?.[0].data;
    const sourceData = prismaMock.brainSource.create.mock.calls[0]?.[0].data;
    expect(documentData).toMatchObject({ accessDomain: "FINANCE", source: "finance-report-import" });
    expect(documentData).not.toHaveProperty("textContent");
    expect(sourceData).toMatchObject({
      accessDomain: "FINANCE",
      content: "Finance report upload pending extraction.",
    });
    expect(sourceData).not.toHaveProperty("absorbedAt");
    expect(prismaMock.financeImportBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        uploadedByUserId: "user-1",
        documentId: expect.any(String),
        brainSourceId: expect.any(String),
        fileHash: batch.fileHash,
        mimeType: "text/csv",
        originalFilename: "Report.csv",
        fileSizeBytes: fileBuffer.byteLength,
        stage: "UPLOADED",
      }),
    });
    const audit = prismaMock.auditLog.create.mock.calls[0]?.[0];
    expect(audit.data.meta).not.toHaveProperty("storageKey");
    expect(audit.data.meta).not.toHaveProperty("fileHash");
    expect(JSON.stringify(audit)).not.toContain("Account,Amount");
    expect(result).toMatchObject({ reused: false, batch: { stage: "UPLOADED" } });
  });

  it("returns an exact workspace duplicate before storage or capacity writes", async () => {
    prismaMock.financeImportBatch.findUnique.mockResolvedValue(batch);
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: Buffer.from("Account,Amount"),
      fileName: "report.csv",
      mimeType: "application/octet-stream",
    })).resolves.toEqual({ batch, reused: true });
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(capacityMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("hashes and stores the immutable byte snapshot taken before authorization awaits", async () => {
    let allowAccess: (() => void) | undefined;
    accessMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      allowAccess = resolve;
    }));
    const original = Buffer.from("original");
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    const upload = createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: original,
      fileName: "report.csv",
      mimeType: "text/csv",
    });
    original.fill(0x78);
    allowAccess?.();
    await upload;
    expect(storageMock.put.mock.calls[0][1]).toEqual(Buffer.from("original"));
    expect(prismaMock.financeImportBatch.create.mock.calls[0][0].data.fileHash)
      .toBe(createHash("sha256").update("original").digest("hex"));
  });

  it.each([
    ["empty", Buffer.alloc(0), "report.csv", "text/csv", "EMPTY_FILE"],
    ["unsupported", Buffer.from("x"), "report.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "UNSUPPORTED_FILE_TYPE"],
    ["mismatch", Buffer.from("x"), "report.xlsx", "application/pdf", "FILE_TYPE_MISMATCH"],
    ["too large", Buffer.alloc((25 * 1024 * 1024) + 1), "report.pdf", "application/pdf", "FILE_TOO_LARGE"],
  ])("rejects %s input before storage", async (_label, fileBuffer, fileName, mimeType, code) => {
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1", fileBuffer, fileName, mimeType,
    })).rejects.toMatchObject({ code });
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("performs no writes when the Finance human-write gate rejects", async () => {
    accessMock.mockRejectedValueOnce(new Error("forbidden"));
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: Buffer.from("x"),
      fileName: "report.csv",
      mimeType: "text/csv",
    })).rejects.toThrow("forbidden");
    expect(prismaMock.financeImportBatch.findUnique).not.toHaveBeenCalled();
    expect(storageMock.put).not.toHaveBeenCalled();
  });

  it("deletes a stored object after transaction failure", async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error("database unavailable"));
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: Buffer.from("x"),
      fileName: "report.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({
      code: "FINANCE_REPORT_UPLOAD_FAILED",
      message: "The report upload could not be completed.",
    });
    expect(storageMock.delete).toHaveBeenCalledWith(storageMock.put.mock.calls[0][0]);
  });

  it("hides storage provider errors and attempts cleanup", async () => {
    storageMock.put.mockRejectedValueOnce(new Error("provider details"));
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: Buffer.from("x"),
      fileName: "report.pdf",
      mimeType: "application/pdf",
    })).rejects.toMatchObject({
      code: "FINANCE_REPORT_STORAGE_UNAVAILABLE",
      message: "The report could not be stored. Please try again.",
    });
    expect(storageMock.delete).toHaveBeenCalledWith(expect.stringContaining("/finance/report-imports/"));
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("cleans up and returns the winner after a concurrent hash conflict", async () => {
    prismaMock.$transaction.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["workspaceId", "fileHash"] },
    });
    prismaMock.financeImportBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(batch);
    const { createFinanceReportImportUpload } = await import("./finance-import-upload");
    await expect(createFinanceReportImportUpload(actor, {
      workspaceId: "workspace-1",
      fileBuffer: Buffer.from("Account,Amount"),
      fileName: "report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).resolves.toEqual({ batch, reused: true });
    expect(storageMock.delete).toHaveBeenCalledWith(storageMock.put.mock.calls[0][0]);
  });
});
