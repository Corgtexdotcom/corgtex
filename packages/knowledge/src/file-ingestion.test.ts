import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractTextFromFileBuffer, ingestFile } from "./file-ingestion";
import { prisma } from "@corgtex/shared";
import {
  assertTrialStorageCapacity,
  checkWorkspaceDuplicateGuard,
  isGlobalOperator,
  lockAndAssertTrialStorageCapacity,
  requireWorkspaceMembership,
} from "@corgtex/domain";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    $transaction: vi.fn((cb) => cb({
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Test Doc" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1" }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    })),
    document: {
      findFirst: vi.fn(),
    },
    brainSource: {
      findFirst: vi.fn(),
    },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@corgtex/domain", () => ({
  appendEvents: vi.fn(),
  checkWorkspaceDuplicateGuard: vi.fn().mockResolvedValue(null),
  duplicateGuardAuditMeta: vi.fn(() => ({})),
  duplicateGuardContentHash: vi.fn((value?: string | null) => value?.trim() ? `hash:${value.trim()}` : null),
  duplicateGuardMergeText: vi.fn((existing?: string | null, incoming?: string | null) => incoming?.trim() || existing || null),
  assertTrialStorageCapacity: vi.fn().mockResolvedValue(undefined),
  lockAndAssertTrialStorageCapacity: vi.fn().mockResolvedValue(undefined),
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem1" }),
  isGlobalOperator: vi.fn().mockReturnValue(false),
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
const VALID_PPTX_BUFFER = readFileSync(new URL("./fixtures/brain-pptx-ingestion.pptx", import.meta.url));
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("file-ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireWorkspaceMembership).mockResolvedValue({ id: "mem1" } as any);
    vi.mocked(isGlobalOperator).mockReturnValue(false);
    vi.mocked(checkWorkspaceDuplicateGuard).mockResolvedValue(null);
    vi.mocked(assertTrialStorageCapacity).mockResolvedValue(undefined);
    vi.mocked(lockAndAssertTrialStorageCapacity).mockResolvedValue(undefined);
    vi.mocked((prisma as any).document.findFirst).mockResolvedValue(null);
    vi.mocked((prisma as any).brainSource.findFirst).mockResolvedValue(null);
  });

  const actor = { kind: "user" as const, user: { id: "usr1", email: "test@example.com", displayName: "Test User" } };

  it("extracts text from plain text files", async () => {
    const { defaultStorage } = await import("@corgtex/storage");
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
    expect(assertTrialStorageCapacity).toHaveBeenCalledWith("ws_1", Buffer.byteLength("Hello text"));
    expect(vi.mocked(assertTrialStorageCapacity).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(defaultStorage.put).mock.invocationCallOrder[0]);
    expect(lockAndAssertTrialStorageCapacity).toHaveBeenCalledWith(
      txObj,
      "ws_1",
      Buffer.byteLength("Hello text"),
    );
    expect(vi.mocked(lockAndAssertTrialStorageCapacity).mock.invocationCallOrder.at(-1))
      .toBeLessThan(txObj.document.create.mock.invocationCallOrder[0]);
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

  it("does not persist the synthetic global operator membership as a Brain source author", async () => {
    vi.mocked(isGlobalOperator).mockReturnValue(true);
    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "ws_1",
      userId: "usr1",
      role: "ADMIN",
      isActive: true,
    } as any);

    await ingestFile(
      { kind: "user" as const, user: { id: "usr1", email: "admin@example.com", displayName: "Admin", globalRole: "OPERATOR" } },
      {
        workspaceId: "ws_1",
        fileName: "operator-upload.txt",
        mimeType: "text/plain",
        fileBuffer: Buffer.from("Operator upload"),
        uploadSource: "brain-upload",
      },
    );

    const txMock = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Operator Upload", source: "brain-upload" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1", sourceType: "FILE_UPLOAD", tier: 2 }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txMock(txObj);

    expect(txObj.brainSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorMemberId: null,
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

  it("stores PPTX text and provenance and hashes the extracted content", async () => {
    await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "synthetic.pptx",
      mimeType: PPTX_MIME,
      fileBuffer: VALID_PPTX_BUFFER,
      uploadSource: "brain-upload",
    });

    expect(checkWorkspaceDuplicateGuard).toHaveBeenCalledWith(expect.objectContaining({
      contentHash: expect.stringContaining("NEBULA-LATE-SLIDE-7421 searchable phrase"),
    }), undefined);
    const txCallback = vi.mocked(prisma.$transaction).mock.calls[0][0] as any;
    const txObj = {
      document: { create: vi.fn().mockResolvedValue({ id: "doc1", title: "Synthetic", source: "brain-upload" }) },
      brainSource: { create: vi.fn().mockResolvedValue({ id: "src1", sourceType: "FILE_UPLOAD", tier: 2 }) },
      auditLog: { create: vi.fn() },
      eventRecord: { createMany: vi.fn() },
    };
    await txCallback(txObj);

    expect(txObj.document.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        textContent: expect.stringContaining("NEBULA-LATE-SLIDE-7421 searchable phrase"),
        metadata: expect.objectContaining({
          extraction: expect.objectContaining({
            format: "PPTX",
            parserVersion: "7.6.2",
            slideCount: 2,
            notesIncluded: true,
          }),
        }),
      }),
    }));
    expect(txObj.brainSource.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        content: expect.stringContaining("NEBULA-LATE-SLIDE-7421 searchable phrase"),
        metadata: expect.objectContaining({
          extraction: expect.objectContaining({ format: "PPTX", hasTextContent: true }),
        }),
      }),
    }));
  });

  it("validates generic binary PPTX before treating it as supported", async () => {
    const valid = await extractTextFromFileBuffer({
      fileBuffer: VALID_PPTX_BUFFER,
      fileName: "upload.bin",
      mimeType: "application/octet-stream",
    });
    const invalid = await extractTextFromFileBuffer({
      fileBuffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      fileName: "upload.bin",
      mimeType: "application/octet-stream",
    });

    expect(valid.supported).toBe(true);
    expect(valid.extraction).toMatchObject({ format: "PPTX", parserVersion: "7.6.2" });
    expect(invalid).toMatchObject({ supported: false, textContent: null });
  });

  it.each(["application/zip", "application/x-zip-compressed"])(
    "validates a named PPTX reported as %s without treating ordinary ZIP files as PPTX",
    async (mimeType) => {
      const valid = await extractTextFromFileBuffer({
        fileBuffer: VALID_PPTX_BUFFER,
        fileName: "presentation.pptx",
        mimeType,
      });
      const ordinaryZip = await extractTextFromFileBuffer({
        fileBuffer: VALID_PPTX_BUFFER,
        fileName: "archive.zip",
        mimeType,
      });
      const invalidPptx = extractTextFromFileBuffer({
        fileBuffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
        fileName: "invalid.pptx",
        mimeType,
      });

      expect(valid).toMatchObject({ supported: true, extraction: { format: "PPTX" } });
      expect(ordinaryZip).toMatchObject({ supported: false, textContent: null });
      await expect(invalidPptx).rejects.toThrow("not a valid PowerPoint presentation");
    },
  );

  it("fails recognized unsafe PPTX before duplicate checks, storage, transactions, audits, or events", async () => {
    const { defaultStorage } = await import("@corgtex/storage");

    await expect(ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "unsafe.pptx",
      mimeType: PPTX_MIME,
      fileBuffer: Buffer.from("PRIVATE-DECK-CONTENT"),
      uploadSource: "brain-upload",
    })).rejects.toThrow("not a valid PowerPoint presentation");

    expect(checkWorkspaceDuplicateGuard).not.toHaveBeenCalled();
    expect(assertTrialStorageCapacity).not.toHaveBeenCalled();
    expect(defaultStorage.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    const fileBuffer = Buffer.from("fake image");
    await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "diagram.png",
      mimeType: "image/png",
      fileBuffer,
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
    expect(checkWorkspaceDuplicateGuard).toHaveBeenCalledWith(expect.objectContaining({
      contentHash: createHash("sha256").update(fileBuffer).digest("hex"),
    }), undefined);
  });

  it("returns an existing document for duplicate file uploads without storing a new blob", async () => {
    const { defaultStorage } = await import("@corgtex/storage");
    vi.mocked(checkWorkspaceDuplicateGuard).mockResolvedValueOnce({
      resolution: "use_existing",
      match: {
        entityType: "Document",
        entityId: "doc-existing",
        title: "Existing Upload",
        excerpt: "Hello text",
        score: 1,
        matchKind: "exact",
        reasons: ["contentHash"],
        createdAt: null,
        updatedAt: null,
        archivedAt: null,
      },
    });
    vi.mocked((prisma as any).document.findFirst).mockResolvedValueOnce({
      id: "doc-existing",
      title: "Existing Upload",
      textContent: "Hello text",
    });
    vi.mocked((prisma as any).brainSource.findFirst).mockResolvedValueOnce({
      id: "source-existing",
      title: "Existing Upload",
    });

    const res = await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "test.txt",
      mimeType: "text/plain",
      fileBuffer: Buffer.from("Hello text"),
      uploadSource: "FILE_UPLOAD",
      duplicateGuard: {
        resolution: "use_existing",
        targetEntityId: "doc-existing",
      },
    });

    expect(res.document.id).toBe("doc-existing");
    expect(res.source?.id).toBe("source-existing");
    expect(defaultStorage.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(assertTrialStorageCapacity).not.toHaveBeenCalled();
    expect(lockAndAssertTrialStorageCapacity).not.toHaveBeenCalled();
  });

  it("stores and links the replacement blob when a duplicate file upload updates an existing document", async () => {
    const { defaultStorage } = await import("@corgtex/storage");
    vi.mocked(checkWorkspaceDuplicateGuard).mockResolvedValueOnce({
      resolution: "update_existing",
      match: {
        entityType: "Document",
        entityId: "doc-existing",
        title: "Existing Upload",
        excerpt: "Old text",
        score: 0.93,
        matchKind: "likely",
        reasons: ["similar content"],
        createdAt: null,
        updatedAt: null,
        archivedAt: null,
      },
    });

    const existingDocument = {
      id: "doc-existing",
      workspaceId: "ws_1",
      title: "Existing Upload",
      source: "FILE_UPLOAD",
      storageKey: "old-storage-key",
      mimeType: "text/plain",
      textContent: "Old text",
      metadata: {},
      archivedAt: null,
    };
    vi.mocked((prisma as any).document.findFirst).mockResolvedValueOnce(existingDocument);
    const existingSource = {
      id: "source-existing",
      workspaceId: "ws_1",
      sourceType: "FILE_UPLOAD",
      title: "Existing Upload",
      channel: "FILE_UPLOAD",
      ingestionGuidanceMd: null,
      metadata: { documentId: "doc-existing" },
    };
    const txObj = {
      document: {
        findFirst: vi.fn().mockResolvedValue(existingDocument),
        update: vi.fn().mockImplementation(async (args: any) => ({ ...existingDocument, ...args.data })),
      },
      brainSource: {
        findFirst: vi.fn().mockResolvedValue(existingSource),
        update: vi.fn().mockImplementation(async (args: any) => ({ ...existingSource, ...args.data })),
        create: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: any) => callback(txObj));

    const res = await ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "test.txt",
      mimeType: "text/plain",
      fileBuffer: Buffer.from("New replacement text"),
      uploadSource: "FILE_UPLOAD",
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "doc-existing",
      },
    });

    const replacementStorageKey = vi.mocked(defaultStorage.put).mock.calls[0]?.[0];
    expect(replacementStorageKey).toMatch(/^workspaces\/ws_1\/uploads\/.+\/test\.txt$/);
    expect(txObj.document.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "doc-existing" },
      data: expect.objectContaining({
        storageKey: replacementStorageKey,
        mimeType: "text/plain",
      }),
    }));
    expect(txObj.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-existing" },
      data: expect.objectContaining({
        fileStorageKey: replacementStorageKey,
        fileName: "test.txt",
        fileMimeType: "text/plain",
        absorbedAt: null,
      }),
    }));
    expect(txObj.brainSource.create).not.toHaveBeenCalled();
    expect(res.document.storageKey).toBe(replacementStorageKey);
    expect(assertTrialStorageCapacity).toHaveBeenCalledWith(
      "ws_1",
      Buffer.byteLength("New replacement text"),
    );
    expect(lockAndAssertTrialStorageCapacity).toHaveBeenCalledWith(
      txObj,
      "ws_1",
      Buffer.byteLength("New replacement text"),
      { replacingDocumentId: "doc-existing" },
    );
    expect(vi.mocked(lockAndAssertTrialStorageCapacity).mock.invocationCallOrder[0])
      .toBeLessThan(txObj.document.update.mock.invocationCallOrder[0]);
  });

  it("cleans the new blob when the locked trial capacity check rejects", async () => {
    const { defaultStorage } = await import("@corgtex/storage");
    vi.mocked(lockAndAssertTrialStorageCapacity).mockRejectedValueOnce(
      new Error("Trial storage limit exceeded."),
    );

    await expect(ingestFile(actor, {
      workspaceId: "ws_1",
      fileName: "over-limit.txt",
      mimeType: "text/plain",
      fileBuffer: Buffer.from("Capacity race loser"),
      uploadSource: "FILE_UPLOAD",
    })).rejects.toThrow("Trial storage limit exceeded.");

    const storageKey = vi.mocked(defaultStorage.put).mock.calls[0]?.[0];
    expect(assertTrialStorageCapacity).toHaveBeenCalledWith(
      "ws_1",
      Buffer.byteLength("Capacity race loser"),
    );
    expect(defaultStorage.delete).toHaveBeenCalledWith(storageKey);
  });
});
