import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

function transactionClient() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    document: {
      findUnique: vi.fn().mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null }),
    },
    brainSource: {
      findUnique: vi.fn().mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null }),
    },
    financeImportBatch: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "batch-1", ...data })),
    },
  };
}

describe("Finance import artifact ownership", () => {
  it("locks link targets deterministically before validating active Finance records", async () => {
    const tx = transactionClient();
    const { lockFinanceImportArtifactLinkTargets } = await import("./finance-import-artifact-ownership");
    await lockFinanceImportArtifactLinkTargets(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      documentId: "document-1",
      brainSourceId: "source-1",
    });

    expect(tx.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
      "finance-import-artifact:workspace-1:BRAIN_SOURCE:source-1",
      "finance-import-artifact:workspace-1:DOCUMENT:document-1",
    ]);
    expect(Math.max(...tx.$executeRaw.mock.invocationCallOrder))
      .toBeLessThan(tx.document.findUnique.mock.invocationCallOrder[0]);
    expect(tx.document.findUnique).toHaveBeenCalledWith({
      where: { id_workspaceId: { id: "document-1", workspaceId: "workspace-1" } },
      select: { accessDomain: true, archivedAt: true },
    });
  });

  it("rejects archived or non-Finance link targets after acquiring both locks", async () => {
    const tx = transactionClient();
    tx.brainSource.findUnique.mockResolvedValue({ accessDomain: "WORKSPACE", archivedAt: new Date() });
    const { lockFinanceImportArtifactLinkTargets } = await import("./finance-import-artifact-ownership");
    await expect(lockFinanceImportArtifactLinkTargets(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      documentId: "document-1",
      brainSourceId: "source-1",
    })).rejects.toMatchObject({ code: "FINANCE_IMPORT_ARTIFACT_UNAVAILABLE" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("creates a batch only after locking and validating both linked artifacts", async () => {
    const tx = transactionClient();
    const { createFinanceImportBatchWithArtifactOwnership } = await import("./finance-import-artifact-ownership");
    await createFinanceImportBatchWithArtifactOwnership(tx as unknown as Prisma.TransactionClient, {
      workspaceId: "workspace-1",
      uploadedByUserId: "user-1",
      documentId: "document-1",
      brainSourceId: "source-1",
      fileHash: "a".repeat(64),
      mimeType: "text/csv",
      originalFilename: "synthetic.csv",
      fileSizeBytes: 10,
    });

    expect(Math.max(
      ...tx.$executeRaw.mock.invocationCallOrder,
      ...tx.document.findUnique.mock.invocationCallOrder,
      ...tx.brainSource.findUnique.mock.invocationCallOrder,
    )).toBeLessThan(tx.financeImportBatch.create.mock.invocationCallOrder[0]);
    expect(tx.financeImportBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        documentId: "document-1",
        brainSourceId: "source-1",
      }),
    });
  });
});
