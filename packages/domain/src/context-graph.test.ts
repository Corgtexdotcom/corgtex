import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  createPersonalContextMapView,
  createContextGraphProposedDiff,
  upsertContextGraphObject,
  updateContextMapLayout,
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
    contextMapView: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    contextMapLayoutItem: {
      create: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
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
    prismaMock.contextMapView.findFirst.mockResolvedValue({
      id: "map-1",
      workspaceId: "ws-1",
      name: "Master process map",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextMapView.create.mockResolvedValue({
      id: "personal-map-1",
      workspaceId: "ws-1",
      name: "My process map",
      viewType: "process",
      query: {},
      createdByUserId: "user-1",
    });
    prismaMock.contextMapLayoutItem.findMany.mockResolvedValue([]);
    prismaMock.contextMapLayoutItem.upsert.mockResolvedValue({ id: "layout-1" });
    prismaMock.contextMapLayoutItem.create.mockResolvedValue({ id: "layout-copy-1" });
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

  it("lets propose-scoped agent credentials create diffs but not mutate graph truth directly", async () => {
    const proposeOnlyAgent = {
      kind: "agent",
      authProvider: "credential",
      label: "research-agent",
      workspaceIds: ["ws-1"],
      scopes: ["context-graph:read", "context-graph:propose"],
    } as any;

    prismaMock.contextGraphProposedDiff.create.mockResolvedValue({
      id: "diff-agent-1",
      status: "pending",
      reason: "Agent proposal",
    });

    await expect(createContextGraphProposedDiff(proposeOnlyAgent, {
      workspaceId: "ws-1",
      reason: "Agent proposal",
      diff: {
        objects: [{ ref: "question", objectType: "Question", title: "Who owns onboarding?" }],
      },
    })).resolves.toMatchObject({ id: "diff-agent-1", status: "pending" });

    await expect(upsertContextGraphObject(proposeOnlyAgent, {
      workspaceId: "ws-1",
      objectType: "Question",
      title: "Direct write should fail",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
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

  it("ranks critical-path context around blockers, owners, evidence, and gaps", async () => {
    prismaMock.contextGraphObject.findMany
      .mockResolvedValueOnce([{
        id: "task-1",
        workspaceId: "ws-1",
        objectType: "Task",
        title: "Draft governance charter",
        status: "approved",
        properties: { workState: "in_progress" },
      }])
      .mockResolvedValueOnce([
        { id: "risk-1", workspaceId: "ws-1", objectType: "Risk", title: "Digital twin transferability", status: "proposed", properties: { workState: "blocked" } },
        { id: "team-1", workspaceId: "ws-1", objectType: "Team", title: "R&D", status: "approved", properties: {} },
        { id: "decision-1", workspaceId: "ws-1", objectType: "Decision", title: "Create AI COE", status: "approved", properties: {} },
      ])
      .mockResolvedValueOnce([
        { id: "tool-1", workspaceId: "ws-1", objectType: "Tool", title: "MCP production smoke", status: "approved", properties: {} },
        { id: "medtech-1", workspaceId: "ws-1", objectType: "Team", title: "MedTech", status: "approved", properties: {} },
      ]);
    prismaMock.contextGraphRelationship.findMany
      .mockResolvedValueOnce([
        { id: "blocker-1", workspaceId: "ws-1", sourceObjectId: "risk-1", targetObjectId: "task-1", relationshipType: "blocks", status: "proposed" },
        { id: "owner-1", workspaceId: "ws-1", sourceObjectId: "task-1", targetObjectId: "team-1", relationshipType: "assigned_to", status: "approved" },
        { id: "dependency-1", workspaceId: "ws-1", sourceObjectId: "task-1", targetObjectId: "decision-1", relationshipType: "depends_on", status: "approved" },
      ])
      .mockResolvedValueOnce([
        { id: "tool-relationship-1", workspaceId: "ws-1", sourceObjectId: "tool-1", targetObjectId: "decision-1", relationshipType: "supports", status: "approved" },
        { id: "approval-1", workspaceId: "ws-1", sourceObjectId: "risk-1", targetObjectId: "medtech-1", relationshipType: "needs_approval_from", status: "proposed" },
      ]);
    prismaMock.contextGraphEvidenceRef.findMany.mockResolvedValueOnce([
      {
        id: "evidence-task-1",
        objectId: "task-1",
        relationshipId: null,
        sourceType: "MEETING",
        sourceId: "meeting-1",
        knowledgeChunkId: null,
        quote: "Draft the charter before the next R&D review.",
        relevanceScore: 0.82,
      },
      {
        id: "evidence-blocker-1",
        objectId: null,
        relationshipId: "blocker-1",
        sourceType: "MEETING",
        sourceId: "meeting-1",
        knowledgeChunkId: null,
        quote: "Digital twin pilots may need separate governance.",
        relevanceScore: 0.38,
      },
    ]);
    prismaMock.knowledgeChunk.findMany.mockResolvedValueOnce([]);

    const context = await buildSelectedRegionContext(actor, {
      workspaceId: "ws-1",
      objectIds: ["task-1"],
      depth: 2,
    });

    expect(context.rankedFacts[0]).toMatchObject({ kind: "object", id: "task-1" });
    expect(context.directNeighbors.map((neighbor) => neighbor.relationshipType).slice(0, 3)).toEqual(["blocks", "depends_on", "assigned_to"]);
    expect(context.directNeighbors[0]).toMatchObject({ objectId: "risk-1", relationshipType: "blocks" });
    expect(context.sourceRecords).toHaveLength(1);
    expect(context.contextGaps.map((gap) => gap.kind)).toContain("needs_review");
    expect(context.likelyNextActions[0]).toMatchObject({ title: "Resolve blocker: Digital twin transferability" });
  });

  it("requires incoming blocker edges before clearing blocked-object gaps", async () => {
    prismaMock.contextGraphObject.findMany
      .mockResolvedValueOnce([{
        id: "risk-1",
        workspaceId: "ws-1",
        objectType: "Risk",
        title: "Digital twin transferability",
        status: "approved",
        properties: { workState: "blocked" },
      }])
      .mockResolvedValueOnce([{
        id: "task-1",
        workspaceId: "ws-1",
        objectType: "Task",
        title: "Draft governance charter",
        status: "approved",
        properties: {},
      }]);
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([
      {
        id: "outgoing-blocks-1",
        workspaceId: "ws-1",
        sourceObjectId: "risk-1",
        targetObjectId: "task-1",
        relationshipType: "blocks",
        status: "approved",
      },
    ]);
    prismaMock.contextGraphEvidenceRef.findMany.mockResolvedValueOnce([
      {
        id: "evidence-risk-1",
        objectId: "risk-1",
        relationshipId: null,
        sourceType: "MEETING",
        sourceId: "meeting-1",
        knowledgeChunkId: null,
        quote: "The risk is waiting on evidence from the pilot.",
        relevanceScore: 0.72,
      },
    ]);
    prismaMock.knowledgeChunk.findMany.mockResolvedValueOnce([]);

    const context = await buildSelectedRegionContext(actor, {
      workspaceId: "ws-1",
      objectIds: ["risk-1"],
      depth: 1,
    });

    expect(context.contextGaps).toContainEqual(expect.objectContaining({
      objectId: "risk-1",
      kind: "missing_blocker_link",
    }));
  });

  it("lets admins update master map layouts directly", async () => {
    await expect(updateContextMapLayout(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      items: [{ objectId: "process-1", x: 120, y: 80 }],
    })).resolves.toMatchObject({ mode: "updated", updated: 1 });

    expect(prismaMock.contextMapLayoutItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { mapViewId_objectId: { mapViewId: "map-1", objectId: "process-1" } },
      update: expect.objectContaining({ x: 120, y: 80 }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-map.layout.updated",
    }));
  });

  it("routes contributor master layout updates through proposed diffs", async () => {
    requireWorkspaceMembershipMock.mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    }).mockResolvedValueOnce({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.contextGraphProposedDiff.create.mockResolvedValue({
      id: "diff-layout-1",
      status: "pending",
      reason: "Request to update master map layout: Master process map",
    });

    await expect(updateContextMapLayout(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      items: [{ objectId: "process-1", x: 240, y: 140 }],
    })).resolves.toMatchObject({ mode: "proposed", proposedDiffId: "diff-layout-1", updated: 0 });

    expect(prismaMock.contextMapLayoutItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          mapLayoutUpdates: [expect.objectContaining({ mapViewId: "map-1" })],
        }),
      }),
    }));
  });

  it("copies source layout into a personal map view", async () => {
    prismaMock.contextMapLayoutItem.findMany.mockResolvedValueOnce([{
      objectId: "process-1",
      x: 100,
      y: 200,
      width: 230,
      height: 110,
      visualState: { expanded: true },
    }]);

    await expect(createPersonalContextMapView(actor, {
      workspaceId: "ws-1",
      sourceMapViewId: "map-1",
      name: "My critical path",
    })).resolves.toMatchObject({ id: "personal-map-1" });

    expect(prismaMock.contextMapView.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "My critical path",
        createdByUserId: "user-1",
        query: expect.objectContaining({ scope: "personal", sourceMapViewId: "map-1" }),
      }),
    }));
    expect(prismaMock.contextMapLayoutItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mapViewId: "personal-map-1",
        objectId: "process-1",
        x: 100,
        y: 200,
      }),
    }));
  });

  it("rejects personal map copies with objects outside the workspace", async () => {
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce(null);

    await expect(createPersonalContextMapView(actor, {
      workspaceId: "ws-1",
      sourceMapViewId: "map-1",
      name: "Tampered map",
      items: [{ objectId: "other-workspace-object", x: 100, y: 200 }],
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(prismaMock.contextMapView.create).not.toHaveBeenCalled();
    expect(prismaMock.contextMapLayoutItem.create).not.toHaveBeenCalled();
  });

  it("applies proposed map layout updates during diff application", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-layout-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        mapLayoutUpdates: [{
          mapViewId: "map-1",
          items: [{ objectId: "process-1", x: 420, y: 160 }],
        }],
      },
    });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-layout-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextMapLayoutItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { mapViewId_objectId: { mapViewId: "map-1", objectId: "process-1" } },
      update: expect.objectContaining({ x: 420, y: 160 }),
    }));
    expect(appendEventsMock).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      payload: expect.objectContaining({
        layoutUpdates: [{ mapViewId: "map-1", updated: 1 }],
      }),
    })]);
  });

  it("rejects proposed layout diffs targeting another user's personal map view", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-layout-2",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        mapLayoutUpdates: [{
          mapViewId: "personal-map-2",
          items: [{ objectId: "process-1", x: 420, y: 160 }],
        }],
      },
    });
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "personal-map-2",
      workspaceId: "ws-1",
      name: "Other personal map",
      viewType: "process",
      query: {},
      createdByUserId: "user-2",
    });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-layout-2",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(prismaMock.contextMapLayoutItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contextGraphProposedDiff.update).not.toHaveBeenCalled();
  });
});
