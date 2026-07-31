import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

function transactionClient() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    document: {
      findUnique: vi.fn().mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null }),
    },
    brainSource: {
      findUnique: vi.fn().mockResolvedValue({ accessDomain: "FINANCE", archivedAt: null }),
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

    expect(tx.$queryRaw.mock.calls.map((call) => call[1])).toEqual([
      "finance-import-artifact:workspace-1:BRAIN_SOURCE:source-1",
      "finance-import-artifact:workspace-1:DOCUMENT:document-1",
    ]);
    expect(Math.max(...tx.$queryRaw.mock.invocationCallOrder))
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
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
