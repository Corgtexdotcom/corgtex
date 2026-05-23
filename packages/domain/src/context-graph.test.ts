import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  upsertContextGraphObject,
} from "./context-graph";
import { prisma } from "@corgtex/shared";

const { prismaMock, appendEventsMock, recordAuditMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prismaMock = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prismaMock)),
    contextGraphObject: {
      create: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphRelationship: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphEvidenceRef: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphProposedDiff: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    knowledgeChunk: {
      findMany: vi.fn(),
    },
  };
  return {
    prismaMock,
    appendEventsMock: vi.fn(),
    recordAuditMock: vi.fn(),
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("user-1"),
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./audit-trail", () => ({
  recordAudit: recordAuditMock,
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

describe("context graph domain", () => {
  const actor = {
    kind: "user",
    user: { id: "user-1", email: "user@example.com", displayName: "User" },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.contextGraphObject.findFirst.mockResolvedValue({ id: "object-existing" });
    prismaMock.contextGraphEvidenceRef.findFirst.mockResolvedValue(null);
    prismaMock.contextGraphEvidenceRef.create.mockResolvedValue({ id: "evidence-1" });
    prismaMock.contextGraphProposedDiff.update.mockResolvedValue({ id: "diff-1", status: "applied" });
  });

  it("rejects unknown object types before writing graph objects", async () => {
    await expect(upsertContextGraphObject(actor, {
      workspaceId: "ws-1",
      objectType: "StickyNote",
      title: "Unbounded type",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(prisma.contextGraphObject.upsert).not.toHaveBeenCalled();
    expect(prisma.contextGraphObject.create).not.toHaveBeenCalled();
  });

  it("applies a proposed diff transactionally and records audit/event proof", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: "agent-run-1",
      diffJson: {
        objects: [
          { ref: "team", objectType: "Team", title: "Customer Success" },
          { ref: "process", objectType: "Process", title: "Customer onboarding" },
        ],
        relationships: [
          { ref: "owns", sourceRef: "team", targetRef: "process", relationshipType: "owns" },
        ],
        evidenceRefs: [
          { objectRef: "process", sourceType: "MEETING", sourceId: "meeting-1", quote: "CS owns onboarding." },
        ],
      },
    });
    prismaMock.contextGraphObject.create
      .mockResolvedValueOnce({ id: "team-1", objectType: "Team", title: "Customer Success", status: "approved" })
      .mockResolvedValueOnce({ id: "process-1", objectType: "Process", title: "Customer onboarding", status: "approved" });
    prismaMock.contextGraphObject.findFirst
      .mockResolvedValueOnce({ id: "team-1" })
      .mockResolvedValueOnce({ id: "process-1" });
    prismaMock.contextGraphRelationship.upsert.mockResolvedValue({
      id: "relationship-1",
      relationshipType: "owns",
      status: "approved",
    });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextGraphRelationship.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "ws-1:team-1:owns:process-1:manual:manual" },
    }));
    expect(prismaMock.contextGraphEvidenceRef.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        objectId: "process-1",
        sourceType: "MEETING",
        sourceId: "meeting-1",
      }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-graph.diff.applied",
    }));
    expect(appendEventsMock).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      type: "context-graph.diff.applied",
    })]);
  });

  it("assembles selected-region context from graph traversal and evidence", async () => {
    prismaMock.contextGraphObject.findMany
      .mockResolvedValueOnce([{ id: "process-1", workspaceId: "ws-1", objectType: "Process", title: "Onboarding", status: "approved" }])
      .mockResolvedValueOnce([{ id: "team-1", workspaceId: "ws-1", objectType: "Team", title: "CS", status: "approved" }]);
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([{
      id: "relationship-1",
      workspaceId: "ws-1",
      sourceObjectId: "team-1",
      targetObjectId: "process-1",
      relationshipType: "owns",
      status: "approved",
    }]);
    prismaMock.contextGraphEvidenceRef.findMany.mockResolvedValueOnce([{
      id: "evidence-1",
      objectId: "process-1",
      relationshipId: null,
      sourceType: "MEETING",
      sourceId: "meeting-1",
      knowledgeChunkId: "chunk-1",
    }]);
    prismaMock.knowledgeChunk.findMany.mockResolvedValueOnce([{
      id: "chunk-1",
      sourceType: "MEETING",
      sourceId: "meeting-1",
      sourceTitle: "Kickoff",
      chunkIndex: 0,
      content: "Customer onboarding owner discussion.",
      sensitivity: "PUBLIC",
    }]);

    const context = await buildSelectedRegionContext(actor, {
      workspaceId: "ws-1",
      objectIds: ["process-1"],
      depth: 1,
    });

    expect(context.objects.map((object) => object.id).sort()).toEqual(["process-1", "team-1"]);
    expect(context.relationships).toHaveLength(1);
    expect(context.evidenceRefs).toHaveLength(1);
    expect(context.knowledgeChunks).toHaveLength(1);
    expect(context.permissions.canApprove).toBe(true);
  });
});
