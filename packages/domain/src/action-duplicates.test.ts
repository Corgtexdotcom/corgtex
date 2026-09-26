import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, archiveWorkspaceArtifact, requireWorkspaceMembership, acquireWorkItemAdvisoryLock, recordWorkItemVersion, recordAudit, appendEvents } = vi.hoisted(() => {
  const count = () => ({ count: vi.fn().mockResolvedValue(0) });
  const db = {
    $transaction: vi.fn(),
    action: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0), update: vi.fn() },
    actionChecklistItem: count(),
    workItemEvidence: count(),
    workspaceExternalResourceAttachment: count(),
    communicationEntityLink: count(),
    meetingInsight: { ...count(), updateMany: vi.fn() },
    actionCreationSource: { updateMany: vi.fn() },
    deliberationEntry: count(),
    goalLink: count(),
    adviceProcess: count(),
    approvalFlow: count(),
    auditLog: { create: vi.fn() },
  };
  return {
    db, archiveWorkspaceArtifact: vi.fn(), requireWorkspaceMembership: vi.fn(), acquireWorkItemAdvisoryLock: vi.fn(),
    recordWorkItemVersion: vi.fn().mockResolvedValue(2), recordAudit: vi.fn(), appendEvents: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({ prisma: db }));
vi.mock("./archive", () => ({ archiveWorkspaceArtifact }));
vi.mock("./auth", () => ({ requireWorkspaceMembership }));
vi.mock("./work-item-versions", () => ({ acquireWorkItemAdvisoryLock, recordWorkItemVersion, pickJsonSnapshot: (row: Record<string, unknown>) => row }));
vi.mock("./audit-trail", () => ({ recordAudit }));
vi.mock("./events", () => ({ appendEvents }));

import { previewActionDuplicateResolution, resolveActionDuplicate } from "./action-duplicates";

const actor = { kind: "user" as const, user: { id: "admin-1", email: "admin@example.test", displayName: "Admin" } };
const pair = { workspaceId: "ws-1", canonicalId: "action-1", duplicateId: "action-2" };
const action = (id: string) => ({
  id, workspaceId: "ws-1", title: "Send summary", bodyMd: "The same work.", status: "OPEN", isPrivate: false,
  assigneeMemberId: null, circleId: null, dueAt: null, proposalId: null, priority: 1, completedVia: null,
  archivedAt: null, duplicateOfActionId: null, version: 1,
});

describe("Action duplicate resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((callback) => callback(db));
    db.action.findMany.mockResolvedValue([action("action-1"), action("action-2")]);
    db.action.count.mockResolvedValue(0);
    for (const delegate of [db.actionChecklistItem, db.workItemEvidence, db.workspaceExternalResourceAttachment,
      db.communicationEntityLink, db.meetingInsight, db.deliberationEntry, db.goalLink, db.adviceProcess, db.approvalFlow]) {
      delegate.count.mockResolvedValue(0);
    }
  });

  it("previews an exact pair and archives only the explicitly confirmed duplicate", async () => {
    await expect(previewActionDuplicateResolution(actor, pair)).resolves.toMatchObject({ eligible: true });
    await expect(resolveActionDuplicate(actor, {
      ...pair, expectedCanonicalVersion: 1, expectedDuplicateVersion: 1, confirmDuplicateId: "action-2",
    })).resolves.toEqual({ canonicalActionId: "action-1", archivedDuplicateActionId: "action-2" });
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1", allowedRoles: ["ADMIN"] });
    expect(archiveWorkspaceArtifact).toHaveBeenCalledWith(actor, expect.objectContaining({
      workspaceId: "ws-1", entityType: "Action", entityId: "action-2", _tx: db,
    }));
    expect(db.action.update).toHaveBeenCalledWith({ where: { id: "action-2" }, data: { duplicateOfActionId: "action-1" } });
  });

  it("blocks differing content and linked work without archiving", async () => {
    db.action.findMany.mockResolvedValue([action("action-1"), { ...action("action-2"), bodyMd: "Unique note" }]);
    db.actionChecklistItem.count.mockResolvedValue(1);
    const preview = await previewActionDuplicateResolution(actor, pair);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers).toEqual(expect.arrayContaining([
      "Different text requires the same meeting source and a closely related title.",
      "The duplicate has checklist items or linked work; merge those explicitly before archiving it.",
    ]));
    await expect(resolveActionDuplicate(actor, {
      ...pair, expectedCanonicalVersion: 1, expectedDuplicateVersion: 1, confirmDuplicateId: "action-2",
    })).rejects.toMatchObject({ code: "ACTION_DUPLICATE_NOT_SAFE" });
    expect(archiveWorkspaceArtifact).not.toHaveBeenCalled();
  });

  it("merges related notes from the same meeting and retains insight links", async () => {
    const meeting = "/workspaces/ws-1/meetings/11111111-1111-4111-8111-111111111111";
    db.action.findMany.mockResolvedValue([
      { ...action("action-1"), title: "Continue safety review", bodyMd: `Continue safeguards. [Meeting](${meeting})` },
      { ...action("action-2"), title: "Continue safety and safeguard review", bodyMd: `Continue safeguards and update the checklist. [Meeting](${meeting})` },
    ]);
    const preview = await previewActionDuplicateResolution(actor, pair);
    expect(preview.eligible).toBe(true);
    expect(preview.sameMeetingSource).toBe(true);
    expect(preview.mergedBodyMd).toContain("update the checklist");

    await resolveActionDuplicate(actor, {
      ...pair, expectedCanonicalVersion: 1, expectedDuplicateVersion: 1, confirmDuplicateId: "action-2",
    });
    expect(db.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1", version: 1 }),
      data: expect.objectContaining({ version: 2, bodyMd: expect.stringContaining("update the checklist") }),
    }));
    expect(db.meetingInsight.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", appliedEntityType: "Action", appliedEntityId: "action-2" },
      data: { appliedEntityId: "action-1" },
    });
    expect(db.actionCreationSource.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", actionId: "action-2" },
      data: { actionId: "action-1" },
    });
  });

  it("rejects an unconfirmed target and actions outside the workspace", async () => {
    await expect(resolveActionDuplicate(actor, {
      ...pair, expectedCanonicalVersion: 1, expectedDuplicateVersion: 1, confirmDuplicateId: "action-1",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    db.action.findMany.mockResolvedValue([action("action-1")]);
    await expect(previewActionDuplicateResolution(actor, pair)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(archiveWorkspaceArtifact).not.toHaveBeenCalled();
  });
});
