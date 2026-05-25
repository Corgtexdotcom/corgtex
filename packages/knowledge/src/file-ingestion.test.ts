import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestFile } from "./file-ingestion";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: vi.fn((cb) => cb({
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Test Doc" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1" }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    })),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@corgtex/domain", () => ({
  appendEvents: vi.fn(),
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem1" }),
  getStorageUsageSummary: vi.fn().mockResolvedValue({ usageBytes: 0, limitBytes: Infinity }),
  AppError: class extends Error { constructor(status: number, code: string, msg: string) { super(msg); } },
}));

vi.mock("@corgtex/storage", () => ({
  defaultStorage: {
    put: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

const VALID_PDF_BUFFER = Buffer.from(
  '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<<>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000206 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n300\n%%EOF',
  'ascii'
);

describe("file-ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const actor = { kind: "user" as const, user: { id: "usr1", email: "test@example.com", displayName: "Test User" } };

  it("extracts text from plain text files", async () => {
    const res = await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "test.txt",
      mimeType: "text/plain",
      fileBuffer: Buffer.from("Hello text"),
      uploadSource: "FILE_UPLOAD",
    });

    expect(res.document.id).toBe("doc1");
    // We mock $transaction so we check that brainSource.create was called with right content
    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Test Doc", source: "FILE_UPLOAD" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1" }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);
    expect(txObj.brainSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining("Hello text"),
        })
      })
    );
  });

  it("stores upload guidance on documents and brain sources", async () => {
    await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "guided.txt",
      mimeType: "text/plain",
      fileBuffer: Buffer.from("Guided body"),
      uploadSource: "brain-upload",
      ingestionGuidanceMd: " Overall guidance:\nPreserve contract terms. ",
    });

    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Guided Doc", source: "brain-upload" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1", sourceType: "FILE_UPLOAD", tier: 2 }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);

    expect(txObj.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            ingestionGuidanceMd: "Overall guidance:\nPreserve contract terms.",
          }),
        }),
      }),
    );
    expect(txObj.brainSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ingestionGuidanceMd: "Overall guidance:\nPreserve contract terms.",
          content: expect.stringContaining("User guidance for this upload:"),
        }),
      }),
    );
  });

  it("extracts text from real PDF buffers", async () => {
    const res = await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "test.pdf",
      mimeType: "application/pdf",
      fileBuffer: VALID_PDF_BUFFER,
      uploadSource: "FILE_UPLOAD",
    });

    expect(res.document.id).toBe("doc1");
    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Test Doc", source: "FILE_UPLOAD" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1" }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);
    
    const callArgs = txObj.brainSource.create.mock.calls[0][0];
    expect(callArgs.data.content).toContain("Hello PDF");
  });
  
  it("creates a Brain source stub when PDF extraction fails", async () => {
    // A malformed PDF buffer will throw an error in PDFParse
    const invalidPdf = Buffer.from("Not a PDF");
    
    await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "broken.pdf",
      mimeType: "application/pdf",
      fileBuffer: invalidPdf,
      uploadSource: "FILE_UPLOAD",
    });

    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Test Doc", source: "FILE_UPLOAD" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1" }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);

    expect(txObj.brainSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining("Text extraction was attempted, but no readable body text was found."),
          fileName: "broken.pdf",
          metadata: expect.objectContaining({
            extraction: expect.objectContaining({
              supported: true,
              hasTextContent: false,
            }),
          }),
        }),
      }),
    );
  });

  it("creates a Brain source stub for unsupported file types", async () => {
    await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "diagram.png",
      mimeType: "image/png",
      fileBuffer: Buffer.from("fake image"),
      uploadSource: "brain-upload",
    });

    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Diagram", source: "brain-upload" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1", sourceType: "FILE_UPLOAD", tier: 2 }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);

    expect(txObj.brainSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining("Text extraction is not available for this file type."),
          fileName: "diagram.png",
          fileMimeType: "image/png",
          metadata: expect.objectContaining({
            extraction: expect.objectContaining({
              supported: false,
              hasTextContent: false,
            }),
          }),
        }),
      }),
    );
  });
});
