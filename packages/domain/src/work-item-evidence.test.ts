import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    workItemEvidence: {
      findMany: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership,
}));

describe("work item evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
  });

  it("includes product feedback context as a supported purpose", async () => {
    const { WORK_ITEM_EVIDENCE_PURPOSES } = await import("./work-item-evidence");

    expect(WORK_ITEM_EVIDENCE_PURPOSES).toContain("feedback_context");
  });

  it("links feedback context documents to work items", async () => {
    const tx = {
      document: {
        findMany: vi.fn().mockResolvedValue([{ id: "doc-1" }]),
      },
      workItemEvidence: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { createWorkItemEvidenceLinks } = await import("./work-item-evidence");

    await expect(createWorkItemEvidenceLinks(tx as any, {
      workspaceId: "workspace-1",
      entityType: "Action",
      entityId: "action-1",
      documentIds: ["doc-1"],
      purpose: "feedback_context",
    })).resolves.toEqual(["doc-1"]);

    expect(tx.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "workspace-1",
        entityType: "Action",
        entityId: "action-1",
        documentId: "doc-1",
        purpose: "feedback_context",
      }],
      skipDuplicates: true,
    });
  });
});
