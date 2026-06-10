import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyContextGraphProposedDiff,
  buildSelectedRegionContext,
  createContextMapChangeProposal,
  createContextMapManualEditProposal,
  createMissingRegionFactsProposal,
  createPersonalContextMapView,
  createContextGraphProposedDiff,
  getContextGraphMapSchema,
  getContextMapData,
  importContextGraphMap,
  listContextMapViews,
  markStaleContextGraphFacts,
  reviewContextGraphProposedDiff,
  updateContextGraphProposedDiff,
  upsertContextGraphObject,
  updateContextMapLayout,
} from "./context-graph";
import { prisma } from "@corgtex/shared";

const { prismaMock, appendEventsMock, recordAuditMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const prismaMock = {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prismaMock)),
    contextGraphObject: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    contextGraphRelationship: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
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
      update: vi.fn(),
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
    prismaMock.contextGraphObject.findMany.mockResolvedValue([]);
    prismaMock.contextGraphObject.update.mockResolvedValue({ id: "object-existing" });
    prismaMock.contextGraphRelationship.findFirst.mockResolvedValue({ id: "relationship-existing" });
    prismaMock.contextGraphRelationship.findMany.mockResolvedValue([]);
    prismaMock.contextGraphRelationship.update.mockResolvedValue({ id: "relationship-existing" });
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
    prismaMock.contextMapView.update.mockResolvedValue({
      id: "map-1",
      workspaceId: "ws-1",
      name: "Master process map",
      viewType: "process",
      query: {},
      createdByUserId: null,
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

  it("applies proposed updates to existing objects and relationships by id", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-update-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        objectUpdates: [{
          id: "step-1",
          title: "Decision to proceed",
          status: "approved",
          properties: { workState: "stalled", nextAction: "NDA required before financials released." },
        }],
        relationshipUpdates: [{
          id: "dependency-1",
          status: "archived",
        }],
      },
    });
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce({ id: "step-1" });
    prismaMock.contextGraphObject.update.mockResolvedValueOnce({ id: "step-1" });
    prismaMock.contextGraphRelationship.findFirst.mockResolvedValueOnce({ id: "dependency-1" });
    prismaMock.contextGraphRelationship.update.mockResolvedValueOnce({ id: "dependency-1" });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-update-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextGraphObject.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "step-1" },
      data: expect.objectContaining({
        title: "Decision to proceed",
        status: "approved",
        properties: expect.objectContaining({ workState: "stalled" }),
      }),
    }));
    expect(prismaMock.contextGraphRelationship.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "dependency-1" },
      data: expect.objectContaining({ status: "archived" }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-graph.diff.applied",
      meta: expect.objectContaining({
        objectUpdateIds: ["step-1"],
        relationshipUpdateIds: ["dependency-1"],
      }),
    }));
  });

  it("imports an approved context map with graph data, evidence, and layout", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-import-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextMapView.update.mockResolvedValueOnce({
      id: "map-import-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.upsert
      .mockResolvedValueOnce({ id: "process-1", objectType: "Process", title: "CR North America critical path", status: "approved" })
      .mockResolvedValueOnce({ id: "step-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved" });
    prismaMock.contextGraphObject.findFirst
      .mockResolvedValueOnce({ id: "process-1" })
      .mockResolvedValueOnce({ id: "step-1" })
      .mockResolvedValueOnce({ id: "step-1" });
    prismaMock.contextGraphRelationship.upsert.mockResolvedValueOnce({
      id: "relationship-1",
      relationshipType: "part_of",
      status: "approved",
    });

    await expect(importContextGraphMap(actor, {
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      query: {
        mode: "criticalPath",
        objectTypes: ["Process", "ProcessStep"],
        relationshipTypes: ["part_of"],
      },
      objects: [
        { ref: "process", objectType: "Process", title: "CR North America critical path", dedupeKey: "ws-1:crna:process" },
        { ref: "step", objectType: "ProcessStep", title: "Decision to proceed", dedupeKey: "ws-1:crna:step:decision", properties: { workState: "stalled" } },
      ],
      relationships: [
        { ref: "part", sourceRef: "step", targetRef: "process", relationshipType: "part_of", dedupeKey: "ws-1:crna:step:decision:part_of:process" },
      ],
      evidenceRefs: [
        { objectRef: "step", sourceType: "DOCUMENT", sourceId: "doc-1", quote: "NDA required before financials released." },
        { relationshipRef: "part", sourceType: "DOCUMENT", sourceId: "doc-1", quote: "Decision is part of the critical path." },
      ],
      layoutItems: [
        { objectRef: "step", x: 280, y: 120, width: 250, height: 112 },
      ],
    })).resolves.toEqual({
      mapViewId: "map-import-1",
      objectCount: 2,
      relationshipCount: 1,
      evidenceCount: 2,
      layoutItemCount: 1,
    });

    expect(prismaMock.contextMapView.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "map-import-1" },
      data: expect.objectContaining({ viewType: "process" }),
    }));
    expect(prismaMock.contextGraphObject.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.contextGraphRelationship.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "ws-1:crna:step:decision:part_of:process" },
    }));
    expect(prismaMock.contextGraphEvidenceRef.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.contextMapLayoutItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { mapViewId_objectId: { mapViewId: "map-import-1", objectId: "step-1" } },
      update: expect.objectContaining({ x: 280, y: 120 }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-graph.map.imported",
      entityType: "ContextMapView",
      entityId: "map-import-1",
    }));
    expect(appendEventsMock).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      type: "context-graph.map.imported",
    })]);
  });

  it("edits pending proposed diffs after validating the replacement diff", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-1",
      workspaceId: "ws-1",
      status: "pending",
      diffJson: { objects: [] },
    });
    prismaMock.contextGraphProposedDiff.update.mockResolvedValue({
      id: "diff-1",
      status: "pending",
      reason: "Edited review",
      diffJson: {
        objects: [{ objectType: "Task", title: "Assign owner for charter", status: "proposed" }],
      },
    });

    await expect(updateContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
      reason: "Edited review",
      diff: {
        objects: [{ objectType: "Task", title: "Assign owner for charter", status: "proposed" }],
      },
    })).resolves.toMatchObject({ id: "diff-1", reason: "Edited review" });

    expect(prismaMock.contextGraphProposedDiff.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reason: "Edited review",
        diffJson: expect.objectContaining({
          objects: [expect.objectContaining({ objectType: "Task", title: "Assign owner for charter" })],
        }),
      }),
    }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-graph.diff.edited",
    }));
  });

  it("rejects invalid edited proposed diffs before writing", async () => {
    await expect(updateContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
      diff: {
        objects: [{ objectType: "StickyNote", title: "Bad type" }],
      },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(prismaMock.contextGraphProposedDiff.update).not.toHaveBeenCalled();
  });

  it("rejects malformed edited proposed diffs without throwing runtime type errors", async () => {
    await expect(updateContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
      diff: null as any,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(updateContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
      diff: {
        evidenceRefs: [{ sourceType: 123, sourceId: "meeting-1" }],
      } as any,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(prismaMock.contextGraphProposedDiff.update).not.toHaveBeenCalled();
  });

  it("rejects pending proposed diffs without applying graph truth", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-1",
      workspaceId: "ws-1",
      status: "pending",
      diffJson: { objects: [{ objectType: "Task", title: "Needs owner" }] },
    });
    prismaMock.contextGraphProposedDiff.update.mockResolvedValue({ id: "diff-1", status: "rejected" });

    await expect(reviewContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-1",
      status: "rejected",
    })).resolves.toMatchObject({ id: "diff-1", status: "rejected" });

    expect(prismaMock.contextGraphObject.create).not.toHaveBeenCalled();
    expect(prismaMock.contextGraphRelationship.upsert).not.toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "context-graph.diff.rejected",
    }));
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

  it("creates proposed tasks, risks, and owner follow-ups from selected-region gaps", async () => {
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([{
      id: "task-1",
      workspaceId: "ws-1",
      objectType: "Task",
      title: "Draft governance charter",
      status: "approved",
      properties: { workState: "blocked" },
    }]);
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphEvidenceRef.findMany.mockResolvedValueOnce([]);
    prismaMock.knowledgeChunk.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValue({
      id: "diff-missing-1",
      status: "pending",
      reason: "Propose missing tasks, risks, or owners from the selected map region.",
    });

    await expect(createMissingRegionFactsProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      objectIds: ["task-1"],
    })).resolves.toMatchObject({ id: "diff-missing-1", status: "pending" });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objects: expect.arrayContaining([
            expect.objectContaining({ objectType: "Task", title: "Assign owner: Draft governance charter" }),
            expect.objectContaining({ objectType: "Task", title: "Attach evidence: Draft governance charter" }),
            expect.objectContaining({ objectType: "Risk", title: "Clarify blocker: Draft governance charter" }),
          ]),
          relationships: expect.arrayContaining([
            expect.objectContaining({ targetObjectId: "task-1", relationshipType: "supports" }),
            expect.objectContaining({ targetObjectId: "task-1", relationshipType: "blocks" }),
          ]),
          evidenceRefs: expect.arrayContaining([
            expect.objectContaining({ sourceType: "REGION_CONTEXT", sourceId: "map-1:task-1" }),
          ]),
        }),
      }),
    }));
  });

  it("recomputes canonical relationship dedupe keys when identity fields change", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-update-relationship-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        relationshipUpdates: [{
          id: "dependency-1",
          sourceObjectId: " step-2 ",
          relationshipType: " blocks ",
        }],
      },
    });
    prismaMock.contextGraphRelationship.findFirst.mockResolvedValueOnce({
      id: "dependency-1",
      sourceObjectId: "step-1",
      targetObjectId: "step-3",
      relationshipType: "depends_on",
      sourceEntityType: "ContextMapView",
      sourceEntityId: "map-1",
      dedupeKey: "old-key",
    });
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce({ id: "step-2" });
    prismaMock.contextGraphRelationship.update.mockResolvedValueOnce({ id: "dependency-1" });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-update-relationship-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextGraphRelationship.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "dependency-1" },
      data: expect.objectContaining({
        sourceObject: { connect: { id: "step-2" } },
        relationshipType: "blocks",
        dedupeKey: "ws-1:step-2:blocks:step-3:ContextMapView:map-1",
      }),
    }));
  });

  it("recomputes canonical object dedupe keys when source identity fields change", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-update-object-source-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        objectUpdates: [{
          id: "step-1",
          sourceEntityId: "scorecard-row-2",
        }],
      },
    });
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce({
      id: "step-1",
      sourceEntityType: "BrainDocument",
      sourceEntityId: "scorecard-row-1",
      dedupeKey: "ws-1:BrainDocument:scorecard-row-1",
    });
    prismaMock.contextGraphObject.update.mockResolvedValueOnce({ id: "step-1" });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-update-object-source-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextGraphObject.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "step-1" },
      data: expect.objectContaining({
        sourceEntityId: "scorecard-row-2",
        dedupeKey: "ws-1:BrainDocument:scorecard-row-2",
      }),
    }));
  });

  it("creates review-first map change proposals for clear selected-step instructions", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      {
        id: "step-1",
        workspaceId: "ws-1",
        objectType: "ProcessStep",
        title: "Decision to proceed",
        status: "approved",
        properties: { workState: "moving" },
      },
    ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-change-1",
      status: "pending",
      reason: "Map change request for Decision to proceed: Set next action to get NDA signed",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: {
        objectUpdates: [{
          id: "step-1",
          properties: { workState: "moving", nextAction: "get NDA signed" },
        }],
      },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["step-1"],
      instruction: "Set next action to get NDA signed",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-change-1",
      status: "pending",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objectUpdates: [expect.objectContaining({
            id: "step-1",
            properties: expect.objectContaining({ nextAction: "get NDA signed" }),
          })],
        }),
      }),
    }));
    expect(prismaMock.contextGraphObject.update).not.toHaveBeenCalled();
  });

  it("keeps explicitly selected map-agent targets even when they are outside the first map page", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "step-201",
          workspaceId: "ws-1",
          objectType: "ProcessStep",
          title: "Late selected step",
          status: "approved",
          properties: {},
        },
      ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-change-201",
      status: "pending",
      reason: "Map change request for Late selected step: Rename it to Final selected step",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: {
        objectUpdates: [{
          id: "step-201",
          title: "Final selected step",
        }],
      },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["step-201"],
      instruction: "Rename it to Final selected step",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-change-201",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objectUpdates: [expect.objectContaining({
            id: "step-201",
            title: "Final selected step",
          })],
        }),
      }),
    }));
  });

  it("searches the full map scope before inferring named map-agent targets", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      {
        id: "step-300",
        workspaceId: "ws-1",
        objectType: "ProcessStep",
        title: "Decision to proceed",
        status: "approved",
        properties: {},
      },
    ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-change-300",
      status: "pending",
      reason: "Map change request for Decision to proceed: Set next action to get NDA signed for Decision to proceed",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: {
        objectUpdates: [{
          id: "step-300",
          properties: { nextAction: "get NDA signed for Decision to proceed" },
        }],
      },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      instruction: "Set next action to get NDA signed for Decision to proceed",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-change-300",
    });

    expect(prismaMock.contextGraphObject.findMany.mock.calls[0][0]).not.toHaveProperty("take");
    expect(prismaMock.contextGraphObject.findMany.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ status: { notIn: ["archived", "stale"] } }),
    });
  });

  it("does not infer map-agent targets from ambiguous single-word titles", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "step-1", workspaceId: "ws-1", objectType: "ProcessStep", title: "Step", status: "approved", properties: {} },
    ]);

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      instruction: "Set next action to check status for this step",
    })).resolves.toMatchObject({
      mode: "needs_clarification",
    });

    expect(prismaMock.contextGraphProposedDiff.create).not.toHaveBeenCalled();
  });

  it("asks for clarification instead of connecting an ambiguous target set", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "step-1", workspaceId: "ws-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
      { id: "step-2", workspaceId: "ws-1", objectType: "ProcessStep", title: "Start date defined", status: "approved", properties: {} },
      { id: "step-3", workspaceId: "ws-1", objectType: "ProcessStep", title: "Holdco formed", status: "approved", properties: {} },
    ]);

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["step-1", "step-2", "step-3"],
      instruction: "Connect these selected steps",
    })).resolves.toMatchObject({
      mode: "needs_clarification",
      message: "Select exactly two process items before asking to connect them.",
    });

    expect(prismaMock.contextGraphProposedDiff.create).not.toHaveBeenCalled();
  });

  it("asks for clarification instead of proposing no-op selected map-agent updates", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "step-1", workspaceId: "ws-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
    ]);

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["step-1"],
      instruction: "Update this step",
    })).resolves.toMatchObject({
      mode: "needs_clarification",
    });

    expect(prismaMock.contextGraphProposedDiff.create).not.toHaveBeenCalled();
  });

  it("creates one archive proposal for every explicitly selected map-agent target", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "step-1", workspaceId: "ws-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
      { id: "step-2", workspaceId: "ws-1", objectType: "ProcessStep", title: "Start date defined", status: "approved", properties: {} },
    ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-archive-1",
      status: "pending",
      reason: "Map change request for Decision to proceed, Start date defined: Archive selected steps",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: {
        objectUpdates: [
          { id: "step-1", status: "archived" },
          { id: "step-2", status: "archived" },
        ],
      },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["step-1", "step-2"],
      instruction: "Archive selected steps",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-archive-1",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objectUpdates: [
            expect.objectContaining({ id: "step-1", status: "archived" }),
            expect.objectContaining({ id: "step-2", status: "archived" }),
          ],
        }),
      }),
    }));
  });

  it("honors explicitly selected non-process canvas objects for archive proposals", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "task-1", workspaceId: "ws-1", objectType: "Task", title: "Review materials", status: "approved", properties: {} },
      ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-archive-task-1",
      status: "pending",
      reason: "Map change request for Review materials: Archive selected item",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: { objectUpdates: [{ id: "task-1", status: "archived" }] },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["task-1"],
      instruction: "Archive selected item",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-archive-task-1",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objectUpdates: [expect.objectContaining({ id: "task-1", status: "archived" })],
        }),
      }),
    }));
  });

  it("preserves add-step titles containing in or to", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "process-1", workspaceId: "ws-1", objectType: "Process", title: "Buying", status: "approved", properties: {} },
    ]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-add-step-1",
      status: "pending",
      reason: "Map change request for Buying: Add step Move to legal review",
      createdAt: new Date("2026-05-25T00:00:00.000Z"),
      diffJson: {
        objects: [{ ref: "requested-step", objectType: "ProcessStep", title: "Move to legal review" }],
      },
    });

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      selectedObjectIds: ["process-1"],
      instruction: "Add step Move to legal review",
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-add-step-1",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objects: [expect.objectContaining({ title: "Move to legal review" })],
        }),
      }),
    }));
  });

  it("asks for clarification instead of proposing ambiguous map-agent changes", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "map-1",
      workspaceId: "ws-1",
      name: "CRNA Critical Path",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      { id: "step-1", workspaceId: "ws-1", objectType: "ProcessStep", title: "Decision to proceed", status: "approved", properties: {} },
      { id: "step-2", workspaceId: "ws-1", objectType: "ProcessStep", title: "Start date defined", status: "approved", properties: {} },
    ]);

    await expect(createContextMapChangeProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      instruction: "Update this process",
    })).resolves.toMatchObject({
      mode: "needs_clarification",
    });

    expect(prismaMock.contextGraphProposedDiff.create).not.toHaveBeenCalled();
  });

  it("uses bounded canonical missing-fact dedupe keys per target and gap kind", async () => {
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([
      {
        id: "task-2",
        workspaceId: "ws-1",
        objectType: "Task",
        title: "Duplicate task title",
        status: "approved",
        properties: {},
      },
      {
        id: "task-1",
        workspaceId: "ws-1",
        objectType: "Task",
        title: "Duplicate task title",
        status: "approved",
        properties: {},
      },
    ]);
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphEvidenceRef.findMany.mockResolvedValueOnce([]);
    prismaMock.knowledgeChunk.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphProposedDiff.create.mockResolvedValue({
      id: "diff-missing-2",
      status: "pending",
      reason: "Propose missing tasks, risks, or owners from the selected map region.",
    });

    await createMissingRegionFactsProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      objectIds: ["task-2", "task-1"],
    });

    const diffJson = prismaMock.contextGraphProposedDiff.create.mock.calls[0]?.[0]?.data.diffJson as any;
    const ownerProposals = diffJson.objects.filter((object: any) => (
      object.title === "Assign owner: Duplicate task title" && object.properties?.missingFactKind === "owner"
    ));
    const dedupeKeys = diffJson.objects.map((object: any) => object.dedupeKey);

    expect(ownerProposals).toHaveLength(2);
    expect(dedupeKeys.every((key: string) => key.length < 180)).toBe(true);
    expect(dedupeKeys.every((key: string) => !key.includes("task-1-task-2") && !key.includes("task-2-task-1"))).toBe(true);
    expect(new Set(dedupeKeys).size).toBe(dedupeKeys.length);
    expect(diffJson.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetObjectId: "task-1", relationshipType: "supports" }),
      expect.objectContaining({ targetObjectId: "task-2", relationshipType: "supports" }),
    ]));
    expect(diffJson.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "REGION_CONTEXT", sourceId: "map-1:task-1,task-2" }),
    ]));
  });

  it("ensures process, organization, and agent master views before listing maps", async () => {
    prismaMock.contextMapView.findFirst.mockReset();
    prismaMock.contextMapView.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.contextMapView.create
      .mockResolvedValueOnce({
        id: "process-master",
        workspaceId: "ws-1",
        name: "Critical path process map",
        viewType: "process",
        query: {},
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "org-master",
        workspaceId: "ws-1",
        name: "Organization map",
        viewType: "org",
        query: {},
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "agent-master",
        workspaceId: "ws-1",
        name: "Agent governance map",
        viewType: "agent",
        query: {},
        createdByUserId: null,
      });
    prismaMock.contextMapView.findMany.mockResolvedValueOnce([
      { id: "process-master", viewType: "process", createdByUserId: null },
      { id: "org-master", viewType: "org", createdByUserId: null },
      { id: "agent-master", viewType: "agent", createdByUserId: null },
    ]);

    await expect(listContextMapViews(actor, "ws-1")).resolves.toHaveLength(3);

    expect(prismaMock.contextMapView.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        name: "Critical path process map",
        viewType: "process",
        createdByUserId: null,
        query: expect.objectContaining({
          mode: "criticalPath",
          defaultMapKey: "critical-path",
          evidenceBacked: true,
        }),
      }),
    }));
    expect(prismaMock.contextMapView.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        name: "Organization map",
        viewType: "org",
        createdByUserId: null,
        query: expect.objectContaining({
          mode: "organization",
          defaultMapKey: "org-structure",
          evidenceBacked: true,
          objectTypes: ["Team", "Role", "Person"],
          relationshipTypes: ["part_of", "member_of", "reports_to", "owns", "assigned_to"],
        }),
      }),
    }));
    expect(prismaMock.contextMapView.create).toHaveBeenNthCalledWith(3, expect.objectContaining({
      data: expect.objectContaining({
        name: "Agent governance map",
        viewType: "agent",
        createdByUserId: null,
        query: expect.objectContaining({
          mode: "agentGovernance",
          defaultMapKey: "agent-governance",
          evidenceBacked: true,
          objectTypes: ["Agent", "Policy", "Tool", "Team", "Role", "Meeting", "Document", "Task", "Decision", "Risk", "Evidence"],
          relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks", "member_of", "assigned_to"],
        }),
      }),
    }));
  });

  it("marks aged approved facts stale without touching fresh or non-approved facts", async () => {
    prismaMock.contextGraphObject.updateMany.mockResolvedValueOnce({ count: 3 });
    prismaMock.contextGraphRelationship.updateMany.mockResolvedValueOnce({ count: 2 });

    const now = new Date("2026-06-09T00:00:00.000Z");
    const result = await markStaleContextGraphFacts(actor, {
      workspaceId: "ws-1",
      staleAfterDays: 30,
      now,
    });

    const cutoff = new Date("2026-05-10T00:00:00.000Z");
    const expectedWhere = {
      workspaceId: "ws-1",
      status: "approved",
      OR: [
        { lastVerifiedAt: { lt: cutoff } },
        { lastVerifiedAt: null, updatedAt: { lt: cutoff } },
      ],
    };
    expect(prismaMock.contextGraphObject.updateMany).toHaveBeenCalledWith({
      where: expectedWhere,
      data: { status: "stale" },
    });
    expect(prismaMock.contextGraphRelationship.updateMany).toHaveBeenCalledWith({
      where: expectedWhere,
      data: { status: "stale" },
    });
    expect(result).toEqual({ staleObjects: 3, staleRelationships: 2, cutoff });
  });

  it("refreshes drifted master default view queries to the current built-in config", async () => {
    prismaMock.contextMapView.findFirst.mockReset();
    prismaMock.contextMapView.findFirst
      .mockResolvedValueOnce({
        id: "process-master",
        workspaceId: "ws-1",
        name: "Critical path process map",
        viewType: "process",
        query: {
          mode: "criticalPath",
          defaultMapKey: "critical-path",
          evidenceBacked: true,
          objectTypes: ["Process", "ProcessStep", "Decision", "Task", "Risk", "Metric", "Question", "Hypothesis", "Tool", "Team", "Role", "Meeting"],
          relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
        },
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "custom-org-master",
        workspaceId: "ws-1",
        name: "Imported org map",
        viewType: "org",
        query: { objectIds: ["object-1"] },
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "agent-master",
        workspaceId: "ws-1",
        name: "Agent governance map",
        viewType: "agent",
        query: {
          mode: "agentGovernance",
          defaultMapKey: "agent-governance",
          evidenceBacked: true,
          objectTypes: ["Agent", "Policy", "Tool", "Team", "Role", "Meeting", "Document", "Task", "Decision", "Risk", "Evidence"],
          relationshipTypes: ["input_to", "output_of", "uses", "supports", "needs_approval_from", "created_in", "has_evidence", "blocks", "member_of", "assigned_to"],
        },
        createdByUserId: null,
      });
    prismaMock.contextMapView.update.mockResolvedValueOnce({
      id: "process-master",
      workspaceId: "ws-1",
      name: "Critical path process map",
      viewType: "process",
      query: {},
      createdByUserId: null,
    });
    prismaMock.contextMapView.findMany.mockResolvedValueOnce([
      { id: "process-master", viewType: "process", createdByUserId: null },
      { id: "custom-org-master", viewType: "org", createdByUserId: null },
      { id: "agent-master", viewType: "agent", createdByUserId: null },
    ]);

    await expect(listContextMapViews(actor, "ws-1")).resolves.toHaveLength(3);

    expect(prismaMock.contextMapView.create).not.toHaveBeenCalled();
    expect(prismaMock.contextMapView.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.contextMapView.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "process-master" },
      data: {
        query: expect.objectContaining({
          defaultMapKey: "critical-path",
          objectTypes: expect.arrayContaining(["Goal"]),
        }),
      },
    }));
  });

  it("exposes context map schema and example import payloads for external agents", () => {
    const schema = getContextGraphMapSchema();

    expect(schema.objectTypes).toEqual(expect.arrayContaining(["Team", "Agent", "Evidence", "Goal"]));
    expect(schema.relationshipTypes).toEqual(expect.arrayContaining(["owns", "depends_on", "has_evidence"]));
    expect(schema.defaultMaps.map((map) => map.key)).toEqual(["critical-path", "org-structure", "agent-governance"]);
    expect(schema.evidenceRefFormat).toEqual(expect.objectContaining({
      sourceType: expect.any(String),
      sourceId: expect.any(String),
    }));
    expect(schema.layoutItemFormat).toEqual(expect.objectContaining({
      objectRef: expect.any(String),
      x: expect.any(String),
      y: expect.any(String),
    }));
    expect(schema.exampleImportPayloads[0]).toEqual(expect.objectContaining({
      name: "Critical path process map",
      objects: expect.arrayContaining([expect.objectContaining({ ref: "process-onboarding" })]),
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ sourceType: "BrainSource" })]),
    }));
    expect(schema.writePath.auditedImportTool).toBe("import_context_graph_map");
  });

  it("returns evidence-backed guidance for empty default maps", async () => {
    prismaMock.contextMapView.findFirst.mockReset();
    prismaMock.contextMapView.findFirst
      .mockResolvedValueOnce({
        id: "process-master",
        workspaceId: "ws-1",
        name: "Critical path process map",
        viewType: "process",
        query: {
          mode: "criticalPath",
          defaultMapKey: "critical-path",
          evidenceBacked: true,
          objectTypes: ["Process", "Decision"],
          relationshipTypes: ["supports"],
        },
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "org-master",
        workspaceId: "ws-1",
        name: "Organization map",
        viewType: "org",
        query: {},
        createdByUserId: null,
      })
      .mockResolvedValueOnce({
        id: "agent-master",
        workspaceId: "ws-1",
        name: "Agent governance map",
        viewType: "agent",
        query: {},
        createdByUserId: null,
      });
    prismaMock.contextMapView.update.mockResolvedValueOnce({
      id: "process-master",
      workspaceId: "ws-1",
      name: "Critical path process map",
      viewType: "process",
      query: {
        mode: "criticalPath",
        defaultMapKey: "critical-path",
        evidenceBacked: true,
        objectTypes: ["Goal", "Process", "ProcessStep", "Decision", "Task", "Risk", "Metric", "Question", "Hypothesis", "Tool", "Team", "Role", "Meeting"],
        relationshipTypes: ["part_of", "depends_on", "blocks", "owns", "assigned_to", "supports", "uses", "created_in", "decided_in", "needs_approval_from"],
      },
      createdByUserId: null,
    });
    prismaMock.contextGraphObject.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphRelationship.findMany.mockResolvedValueOnce([]);
    prismaMock.contextMapView.findMany.mockResolvedValueOnce([]);
    prismaMock.contextMapLayoutItem.findMany.mockResolvedValueOnce([]);
    prismaMock.contextGraphProposedDiff.findMany.mockResolvedValueOnce([]);

    await expect(getContextMapData(actor, { workspaceId: "ws-1" })).resolves.toMatchObject({
      guidance: {
        evidenceBacked: true,
        defaultMapKey: "critical-path",
        emptyTitle: "Critical path process map needs evidence",
        emptyDescription: expect.stringContaining("current goals"),
      },
    });
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

  it("creates a manual standard-card proposal with object-ref layout", async () => {
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-manual-card-1",
      status: "pending",
      reason: "Manual map edit: add standard card \"Confirm QA owner\".",
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      diffJson: {},
    });

    await expect(createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      edit: {
        action: "add-card",
        cardKind: "standard",
        title: "Confirm QA owner",
        position: { x: 300, y: 220 },
      },
    })).resolves.toMatchObject({
      mode: "proposed",
      proposedDiffId: "diff-manual-card-1",
      status: "pending",
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objects: [expect.objectContaining({
            ref: "manual-card",
            objectType: "ProcessStep",
            title: "Confirm QA owner",
            properties: expect.objectContaining({
              manualMapEdit: true,
              cardKind: "standard",
              sourceMapViewId: "map-1",
            }),
          })],
          mapLayoutUpdates: [expect.objectContaining({
            mapViewId: "map-1",
            items: [expect.objectContaining({
              objectRef: "manual-card",
              x: 300,
              y: 220,
            })],
          })],
        }),
      }),
    }));
  });

  it("omits manual card layout updates for personal map views", async () => {
    prismaMock.contextMapView.findFirst.mockResolvedValueOnce({
      id: "personal-map-1",
      workspaceId: "ws-1",
      name: "My process map",
      viewType: "process",
      query: {},
      createdByUserId: "user-1",
    });
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-personal-card-1",
      status: "pending",
      reason: "Manual map edit: add standard card \"Personal card\".",
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      diffJson: {},
    });

    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "personal-map-1",
      edit: {
        action: "add-card",
        cardKind: "standard",
        title: "Personal card",
        position: { x: 180, y: 90 },
      },
    });

    const diffJson = prismaMock.contextGraphProposedDiff.create.mock.calls[0]?.[0]?.data?.diffJson;
    expect(diffJson).toEqual(expect.objectContaining({
      objects: [expect.objectContaining({ ref: "manual-card", objectType: "ProcessStep" })],
    }));
    expect(diffJson).not.toHaveProperty("mapLayoutUpdates");
  });

  it("creates a manual alert blocker proposal connected to an existing node", async () => {
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce({
      id: "step-1",
      title: "Decision to proceed",
      objectType: "ProcessStep",
    });
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-alert-blocker-1",
      status: "pending",
      reason: "Manual map edit: add alert card \"Pilot approval risk\".",
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      diffJson: {},
    });

    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      edit: {
        action: "add-card",
        cardKind: "alert",
        title: "Pilot approval risk",
        position: { x: 640, y: 240 },
        sourceObjectId: "step-1",
        relationIntent: "blocks",
      },
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          objects: [expect.objectContaining({ ref: "manual-card", objectType: "Risk" })],
          relationships: [expect.objectContaining({
            sourceRef: "manual-card",
            targetObjectId: "step-1",
            relationshipType: "blocks",
            properties: expect.objectContaining({ manualMapEdit: true, relationIntent: "blocks" }),
          })],
        }),
      }),
    }));
  });

  it("applies a proposed manual card with layout resolved by objectRef", async () => {
    prismaMock.contextGraphProposedDiff.findFirst.mockResolvedValue({
      id: "diff-manual-layout-1",
      workspaceId: "ws-1",
      status: "pending",
      reviewedAt: null,
      proposedByAgentRunId: null,
      diffJson: {
        objects: [{
          ref: "manual-card",
          objectType: "ProcessStep",
          title: "Manual card",
          properties: { manualMapEdit: true },
        }],
        mapLayoutUpdates: [{
          mapViewId: "map-1",
          items: [{ objectRef: "manual-card", x: 111, y: 222, width: 250, height: 128 }],
        }],
      },
    });
    prismaMock.contextGraphObject.create.mockResolvedValueOnce({
      id: "manual-card-1",
      objectType: "ProcessStep",
      title: "Manual card",
      status: "approved",
    });
    prismaMock.contextGraphObject.findFirst.mockResolvedValueOnce({ id: "manual-card-1" });

    await expect(applyContextGraphProposedDiff(actor, {
      workspaceId: "ws-1",
      proposedDiffId: "diff-manual-layout-1",
    })).resolves.toMatchObject({ id: "diff-1", status: "applied" });

    expect(prismaMock.contextMapLayoutItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { mapViewId_objectId: { mapViewId: "map-1", objectId: "manual-card-1" } },
      update: expect.objectContaining({ x: 111, y: 222 }),
    }));
  });

  it("maps manual enables connections to depends_on with reversed storage direction", async () => {
    prismaMock.contextGraphObject.findFirst
      .mockResolvedValueOnce({ id: "step-a", title: "Step A", objectType: "ProcessStep" })
      .mockResolvedValueOnce({ id: "step-b", title: "Step B", objectType: "ProcessStep" });
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-enables-1",
      status: "pending",
      reason: "Manual map edit: add enables connection.",
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      diffJson: {},
    });

    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      edit: {
        action: "add-connection",
        sourceObjectId: "step-a",
        targetObjectId: "step-b",
        relationIntent: "enables",
      },
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          relationships: [expect.objectContaining({
            sourceObjectId: "step-b",
            targetObjectId: "step-a",
            relationshipType: "depends_on",
            properties: expect.objectContaining({ relationIntent: "enables" }),
          })],
        }),
      }),
    }));
  });

  it("validates manual connections against stale-visible map objects when requested", async () => {
    prismaMock.contextGraphObject.findFirst
      .mockResolvedValueOnce({ id: "stale-a", title: "Stale A", objectType: "ProcessStep" })
      .mockResolvedValueOnce({ id: "stale-b", title: "Stale B", objectType: "ProcessStep" });
    prismaMock.contextGraphProposedDiff.create.mockResolvedValueOnce({
      id: "diff-stale-connection-1",
      status: "pending",
      reason: "Manual map edit: add supports connection.",
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      diffJson: {},
    });

    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      includeStale: true,
      edit: {
        action: "add-connection",
        sourceObjectId: "stale-a",
        targetObjectId: "stale-b",
        relationIntent: "supports",
      },
    });

    expect(prismaMock.contextGraphObject.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: {
        AND: [
          expect.objectContaining({ status: { not: "archived" } }),
          { id: "stale-a" },
        ],
      },
    }));
    expect(prismaMock.contextGraphObject.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {
        AND: [
          expect.objectContaining({ status: { not: "archived" } }),
          { id: "stale-b" },
        ],
      },
    }));
  });

  it("creates proposed relationship updates for archive and connection-type changes", async () => {
    prismaMock.contextGraphRelationship.findFirst
      .mockResolvedValueOnce({
        id: "rel-1",
        sourceObjectId: "risk-1",
        targetObjectId: "step-1",
        relationshipType: "blocks",
      })
      .mockResolvedValueOnce({
        id: "rel-2",
        sourceObjectId: "step-a",
        targetObjectId: "step-b",
        relationshipType: "supports",
        properties: { provenance: "seed", workflowId: "workflow-1" },
      });
    prismaMock.contextGraphObject.findFirst
      .mockResolvedValueOnce({ id: "risk-1", title: "Risk", objectType: "Risk" })
      .mockResolvedValueOnce({ id: "step-1", title: "Step", objectType: "ProcessStep" })
      .mockResolvedValueOnce({ id: "step-a", title: "Step A", objectType: "ProcessStep" })
      .mockResolvedValueOnce({ id: "step-b", title: "Step B", objectType: "ProcessStep" });
    prismaMock.contextGraphProposedDiff.create
      .mockResolvedValueOnce({
        id: "diff-archive-rel-1",
        status: "pending",
        reason: "Manual map edit: archive connection.",
        createdAt: new Date("2026-05-26T12:00:00.000Z"),
        diffJson: {},
      })
      .mockResolvedValueOnce({
        id: "diff-change-rel-1",
        status: "pending",
        reason: "Manual map edit: change connection to needs approval from.",
        createdAt: new Date("2026-05-26T12:01:00.000Z"),
        diffJson: {},
      });

    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      edit: { action: "update-connection", relationshipId: "rel-1", archive: true },
    });
    await createContextMapManualEditProposal(actor, {
      workspaceId: "ws-1",
      mapViewId: "map-1",
      edit: { action: "update-connection", relationshipId: "rel-2", relationIntent: "needs_approval_from" },
    });

    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          relationshipUpdates: [expect.objectContaining({ id: "rel-1", status: "archived" })],
        }),
      }),
    }));
    expect(prismaMock.contextGraphProposedDiff.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        diffJson: expect.objectContaining({
          relationshipUpdates: [expect.objectContaining({
            id: "rel-2",
            relationshipType: "needs_approval_from",
            sourceObjectId: "step-a",
            targetObjectId: "step-b",
            properties: expect.objectContaining({
              provenance: "seed",
              workflowId: "workflow-1",
              manualMapEdit: true,
              relationIntent: "needs_approval_from",
            }),
          })],
        }),
      }),
    }));
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
