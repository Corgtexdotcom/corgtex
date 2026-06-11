import { describe, expect, it, vi } from "vitest";

const ingestFile = vi.fn();

vi.mock("@corgtex/knowledge", () => ({
  ingestFile,
}));

describe("uploadWorkItemEvidenceDocument", () => {
  it("ignores missing evidence files", async () => {
    const { uploadWorkItemEvidenceDocument } = await import("./work-item-evidence-upload");
    const formData = new FormData();

    await expect(uploadWorkItemEvidenceDocument({ kind: "user", user: { id: "u-1" } } as any, {
      workspaceId: "ws-1",
      formData,
      entityType: "Action",
      entityId: "action-1",
      purpose: "completion_evidence",
    })).resolves.toEqual([]);

    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("uploads evidence files through the existing ingestion path", async () => {
    const { uploadWorkItemEvidenceDocument } = await import("./work-item-evidence-upload");
    const formData = new FormData();
    formData.set("evidenceFile", new File(["evidence"], "proof.txt", { type: "text/plain" }));
    ingestFile.mockResolvedValueOnce({ document: { id: "doc-1" } });

    await expect(uploadWorkItemEvidenceDocument({ kind: "user", user: { id: "u-1" } } as any, {
      workspaceId: "ws-1",
      formData,
      entityType: "Action",
      entityId: "action-1",
      purpose: "completion_evidence",
    })).resolves.toEqual(["doc-1"]);

    expect(ingestFile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: "ws-1",
      fileName: "proof.txt",
      mimeType: "text/plain",
      uploadSource: "work-item-evidence",
      documentTitle: "proof.txt",
      documentMetadata: {
        entityType: "Action",
        entityId: "action-1",
        purpose: "completion_evidence",
        size: 8,
      },
    }));
  });
});
