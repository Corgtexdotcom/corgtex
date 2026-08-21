import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, storageDeleteMock, appendEventsMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    action: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    crmActivity: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    crmAccount: { findFirst: vi.fn(), findMany: vi.fn() }, crmContact: { findFirst: vi.fn(), findMany: vi.fn() }, crmDeal: { findFirst: vi.fn(), findMany: vi.fn() },
    goal: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    approvalFlow: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    workspaceArchiveRecord: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workspacePermalink: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    workItemVersion: {
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledgeChunk: {
      deleteMany: vi.fn(),
    },
    document: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    brainSource: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    financeImportBatch: {
      findFirst: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  };
  return { prismaMock: prisma, storageDeleteMock: vi.fn(), appendEventsMock: vi.fn() };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

vi.mock("@corgtex/storage", () => ({
  defaultStorage: {
    delete: storageDeleteMock,
  },
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "admin-1",
    email: "admin@example.com",
    displayName: "Admin",
    globalRole: "OPERATOR",
  },
};

describe("workspace archive domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.approvalFlow.findFirst.mockResolvedValue(null);
    prismaMock.approvalFlow.update.mockResolvedValue({});
    prismaMock.approvalFlow.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.goal.findFirst.mockResolvedValue(null);
    prismaMock.goal.findUnique.mockResolvedValue(null);
    prismaMock.goal.update.mockResolvedValue({});
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});
    prismaMock.workspaceArchiveRecord.update.mockResolvedValue({});
    prismaMock.workspacePermalink.findMany.mockResolvedValue([]);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.workItemVersion.findUnique.mockResolvedValue(null);
    prismaMock.workItemVersion.create.mockResolvedValue({});
    prismaMock.workItemVersion.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.knowledgeChunk.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.financeImportBatch.findFirst.mockResolvedValue(null);
    prismaMock.crmAccount.findMany.mockResolvedValue([]);
    prismaMock.crmContact.findMany.mockResolvedValue([]);
    prismaMock.crmDeal.findMany.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$queryRaw.mockResolvedValue([]);
    storageDeleteMock.mockResolvedValue(undefined);
    appendEventsMock.mockResolvedValue(undefined);
  });

  it("archives artifacts with metadata and an audit record", async () => {
    const action = {
      id: "action-1",
      workspaceId: "workspace-1",
      title: "Follow up",
      archivedAt: null,
      status: "OPEN",
    };
    prismaMock.action.findFirst.mockResolvedValue(action);
    prismaMock.action.update.mockResolvedValue({ ...action, archivedAt: new Date("2026-04-25T12:00:00.000Z") });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Action",
      entityId: "action-1",
      reason: "test cleanup",
    })).resolves.toMatchObject({ id: "action-1" });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedByUserId: "admin-1",
        archiveReason: "test cleanup",
      }),
    }));
    expect(prismaMock.workspaceArchiveRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        entityLabel: "Follow up",
        previousState: expect.objectContaining({ status: "OPEN" }),
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "workspace-artifact.archived" }),
    }));
  });

  it("archives and restores CRM activities through one reversible ledger", async () => {
    const active = { id: "activity-1", workspaceId: "workspace-1", title: "Follow up", archivedAt: null },
      archived = { ...active, archivedAt: new Date("2026-08-11T18:00:00.000Z") };
    prismaMock.crmActivity.findFirst.mockResolvedValueOnce(active).mockResolvedValueOnce(archived).mockResolvedValueOnce(archived).mockResolvedValueOnce(active);
    prismaMock.crmActivity.update.mockResolvedValueOnce(archived).mockResolvedValueOnce(active);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-activity-1", previousState: active });
    const { archiveWorkspaceArtifact, restoreWorkspaceArtifact } = await import("./archive");
    const params = { workspaceId: "workspace-1", entityType: "CrmActivity", entityId: "activity-1" };
    await expect(archiveWorkspaceArtifact(actor, { ...params, reason: "test cleanup" })).resolves.toMatchObject(archived);
    await expect(archiveWorkspaceArtifact(actor, params)).resolves.toMatchObject(archived);
    await expect(restoreWorkspaceArtifact(actor, params)).resolves.toMatchObject(active);
    await expect(restoreWorkspaceArtifact(actor, params)).rejects.toThrow("CrmActivity is not archived");
    expect(prismaMock.workspaceArchiveRecord.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "workspace_archive:CrmActivity:activity-1");
    expect(prismaMock.workspaceArchiveRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      entityType: "CrmActivity", entityId: "activity-1", entityLabel: "Follow up" }) }));
    expect(prismaMock.workspaceArchiveRecord.update).toHaveBeenCalledWith({ where: { id: "archive-activity-1" }, data: {
      restoredAt: expect.any(Date), restoredByUserId: "admin-1" } });
  });
  it("keeps the child archived and ledger open when restore has an archived parent", async () => {
    prismaMock.crmActivity.findFirst.mockResolvedValue({ id: "activity-1", workspaceId: "workspace-1", accountId: "account-1", archivedAt: new Date() });
    prismaMock.crmAccount.findMany.mockResolvedValue([]); prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-activity-1", previousState: {} });
    const { restoreWorkspaceArtifact } = await import("./archive");
    await expect(restoreWorkspaceArtifact(actor, { workspaceId: "workspace-1", entityType: "CrmActivity", entityId: "activity-1" }))
      .rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
    expect(prismaMock.crmActivity.update).not.toHaveBeenCalled();
    expect(prismaMock.workspaceArchiveRecord.update).not.toHaveBeenCalled();
  });
  it.each([
    ["CrmAccount", "crmAccount", { accountId: "parent-1", contactId: null, dealId: null, archivedAt: null }],
    ["CrmContact", "crmContact", { accountId: null, contactId: "parent-1", dealId: null, archivedAt: new Date() }],
    ["CrmDeal", "crmDeal", { accountId: null, contactId: null, dealId: "parent-1", archivedAt: new Date() }],
  ] as const)("blocks %s purge when it would orphan an active or restorable activity", async (entityType, delegate, activity) => {
    prismaMock[delegate].findFirst.mockResolvedValue({ id: "parent-1", workspaceId: "workspace-1", archivedAt: new Date() });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-parent" });
    prismaMock.crmActivity.findFirst.mockResolvedValue({ id: "activity-1", ...activity });
    const { purgeWorkspaceArtifact } = await import("./archive");
    await expect(purgeWorkspaceArtifact(actor, { workspaceId: "workspace-1", entityType,
      entityId: "parent-1", reason: "cleanup" })).rejects.toMatchObject({ code: "CRM_ACTIVITY_ORPHAN" });
    const where = prismaMock.crmActivity.findFirst.mock.calls.at(-1)?.[0].where;
    expect(where).not.toHaveProperty("archivedAt");
    expect(JSON.stringify(where)).toContain("parent-1");
  });
  it("rejects activity restore when a linked deal has an archived required contact", async () => {
    prismaMock.crmActivity.findFirst.mockResolvedValue({ id: "activity-1", workspaceId: "workspace-1", dealId: "deal-1", archivedAt: new Date() });
    prismaMock.crmDeal.findMany.mockResolvedValue([{ id: "deal-1", archivedAt: null, contactId: "contact-1", accountId: null }]);
    prismaMock.crmContact.findMany.mockResolvedValue([{ id: "contact-1", archivedAt: new Date(), accountId: null }]);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-activity-1", previousState: {} });
    const { restoreWorkspaceArtifact } = await import("./archive");
    await expect(restoreWorkspaceArtifact(actor, { workspaceId: "workspace-1", entityType: "CrmActivity", entityId: "activity-1" }))
      .rejects.toMatchObject({ code: "ARCHIVED_PARENT" });
    expect(prismaMock.crmDeal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: { in: ["deal-1"] }, workspaceId: "workspace-1",
    }) }));
    expect(prismaMock.crmContact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: { in: ["contact-1"] }, workspaceId: "workspace-1",
    }) }));
  });
  it("rejects unsupported archive entity types", async () => {
    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, { workspaceId: "workspace-1", entityType: "CrmUnknown", entityId: "unknown-1" }))
      .rejects.toThrow("Unsupported archive entity type");
  });
  it("restores proposals to their previous status", async () => {
    prismaMock.proposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      workspaceId: "workspace-1",
      title: "Proposal",
      archivedAt: new Date("2026-04-25T12:00:00.000Z"),
      status: "RESOLVED",
    });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({
      id: "archive-1",
      previousState: { status: "APPROVED" },
    });
    prismaMock.proposal.update.mockResolvedValue({ id: "proposal-1", status: "RESOLVED", archivedAt: null });

    const { restoreWorkspaceArtifact } = await import("./archive");
    await expect(restoreWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Proposal",
      entityId: "proposal-1",
    })).resolves.toMatchObject({ id: "proposal-1", status: "RESOLVED" });

    expect(prismaMock.proposal.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        archivedAt: null,
        archivedByUserId: null,
        archiveReason: null,
        status: "RESOLVED",
      }),
    }));
  });

  it("recomputes parent progress when goal children are archived", async () => {
    const childGoal = {
      id: "child-goal",
      workspaceId: "workspace-1",
      title: "Child goal",
      archivedAt: null,
      parentGoalId: "parent-goal",
    };
    prismaMock.goal.findFirst.mockResolvedValue(childGoal);
    prismaMock.goal.update
      .mockResolvedValueOnce({ ...childGoal, archivedAt: new Date("2026-04-25T12:00:00.000Z") })
      .mockResolvedValueOnce({ id: "parent-goal", progressPercent: 20 });
    prismaMock.goal.findUnique.mockResolvedValueOnce({
      id: "parent-goal",
      workspaceId: "workspace-1",
      parentGoalId: null,
      progressPercent: 80,
      version: 3,
      keyResults: [],
      childGoals: [{ id: "remaining-child", progressPercent: 20 }],
    });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Goal",
      entityId: "child-goal",
      reason: "completed elsewhere",
    });

    expect(prismaMock.goal.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "parent-goal" },
      include: expect.objectContaining({
        childGoals: expect.objectContaining({
          where: expect.objectContaining({
            archivedAt: null,
          }),
        }),
      }),
    }));
    expect(prismaMock.goal.update).toHaveBeenNthCalledWith(2, {
      where: { id: "parent-goal", version: 3 },
      data: { progressPercent: 20, version: 4 },
    });
  });

  it("recomputes parent progress when archived goal children are restored", async () => {
    const childGoal = {
      id: "child-goal",
      workspaceId: "workspace-1",
      title: "Child goal",
      archivedAt: new Date("2026-04-25T12:00:00.000Z"),
      parentGoalId: "parent-goal",
    };
    prismaMock.goal.findFirst.mockResolvedValue(childGoal);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({
      id: "archive-1",
      previousState: { parentGoalId: "parent-goal" },
    });
    prismaMock.goal.update
      .mockResolvedValueOnce({ ...childGoal, archivedAt: null })
      .mockResolvedValueOnce({ id: "parent-goal", progressPercent: 60 });
    prismaMock.goal.findUnique.mockResolvedValueOnce({
      id: "parent-goal",
      workspaceId: "workspace-1",
      parentGoalId: null,
      progressPercent: 20,
      version: 6,
      keyResults: [],
      childGoals: [
        { id: "remaining-child", progressPercent: 20 },
        { id: "child-goal", progressPercent: 100 },
      ],
    });

    const { restoreWorkspaceArtifact } = await import("./archive");
    await restoreWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Goal",
      entityId: "child-goal",
    });

    expect(prismaMock.goal.update).toHaveBeenNthCalledWith(2, {
      where: { id: "parent-goal", version: 6 },
      data: { progressPercent: 60, version: 7 },
    });
  });

  it("locks generic Proposal archive and restore before the authoritative read", async () => {
    const proposal = {
      id: "proposal-locked",
      workspaceId: "workspace-1",
      title: "Locked proposal",
      archivedAt: null,
      status: "OPEN",
    };
    prismaMock.proposal.findFirst.mockResolvedValueOnce(proposal);
    prismaMock.proposal.update.mockResolvedValueOnce({ ...proposal, archivedAt: new Date() });

    const { archiveWorkspaceArtifact, restoreWorkspaceArtifact } = await import("./archive");
    await archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Proposal",
      entityId: proposal.id,
    });

    const archiveLockOrder = prismaMock.$executeRaw.mock.invocationCallOrder[0];
    const archiveReadOrder = prismaMock.proposal.findFirst.mock.invocationCallOrder[0];
    expect(archiveLockOrder).toBeLessThan(archiveReadOrder);
    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Proposal:proposal-locked");

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({ ...proposal, archivedAt: new Date() });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValueOnce({ id: "archive-locked", previousState: { status: "OPEN" } });
    prismaMock.proposal.update.mockResolvedValueOnce(proposal);
    prismaMock.workspaceArchiveRecord.update.mockResolvedValueOnce({});
    prismaMock.auditLog.create.mockResolvedValueOnce({});

    await restoreWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Proposal",
      entityId: proposal.id,
    });

    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.proposal.findFirst.mock.invocationCallOrder[0]);
  });

  it("keeps Goal archive and recursive parent version history in one transaction and rejects on parent CAS failure", async () => {
    const child = {
      id: "child-rollback",
      workspaceId: "workspace-1",
      title: "Child",
      archivedAt: null,
      parentGoalId: "parent-rollback",
    };
    const parent = {
      id: "parent-rollback",
      workspaceId: "workspace-1",
      title: "Parent",
      parentGoalId: "ancestor-rollback",
      progressPercent: 80,
      version: 4,
      keyResults: [],
      childGoals: [{ id: "remaining", progressPercent: 20 }],
    };
    const ancestor = {
      id: "ancestor-rollback",
      workspaceId: "workspace-1",
      title: "Ancestor",
      parentGoalId: null,
      progressPercent: 70,
      version: 8,
      keyResults: [],
      childGoals: [{ id: "parent-rollback", progressPercent: 20 }],
    };
    prismaMock.goal.findFirst.mockResolvedValueOnce(child);
    prismaMock.goal.findUnique
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(ancestor);
    prismaMock.goal.update
      .mockResolvedValueOnce({ ...child, archivedAt: new Date() })
      .mockResolvedValueOnce({ ...parent, progressPercent: 20, version: 5 })
      .mockRejectedValueOnce({ code: "P2025" });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Goal",
      entityId: child.id,
    })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityId: "parent-rollback", version: 4, changedFields: ["progressPercent"] }),
    }));
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityId: "ancestor-rollback", version: 8, changedFields: ["progressPercent"] }),
    }));
    expect(prismaMock.workspaceArchiveRecord.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();

    const firstLockFor = (entityId: string) => prismaMock.$executeRaw.mock.calls
      .findIndex((call) => call[1] === `Goal:${entityId}`);
    expect(firstLockFor("child-rollback")).toBeLessThan(firstLockFor("parent-rollback"));
    expect(firstLockFor("parent-rollback")).toBeLessThan(firstLockFor("ancestor-rollback"));
    const parentLockOrder = prismaMock.$executeRaw.mock.invocationCallOrder[firstLockFor("parent-rollback")];
    const parentReadOrder = prismaMock.goal.findUnique.mock.invocationCallOrder[0];
    expect(parentLockOrder).toBeLessThan(parentReadOrder);
  });

  it("withdraws active proposal approval flows when proposals are archived", async () => {
    const proposal = {
      id: "proposal-1",
      workspaceId: "workspace-1",
      title: "Proposal",
      archivedAt: null,
      status: "OPEN",
    };
    prismaMock.proposal.findFirst.mockResolvedValue(proposal);
    prismaMock.proposal.update.mockResolvedValue({ ...proposal, archivedAt: new Date("2026-04-25T12:00:00.000Z") });
    prismaMock.approvalFlow.findFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "workspace-1",
      subjectType: "PROPOSAL",
      subjectId: "proposal-1",
    });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Proposal",
      entityId: "proposal-1",
      reason: "obsolete",
    })).resolves.toMatchObject({ id: "proposal-1" });

    expect(prismaMock.approvalFlow.updateMany).toHaveBeenCalledWith({
      where: { id: "flow-1", status: "ACTIVE" },
      data: expect.objectContaining({
        status: "WITHDRAWN",
        resultJson: expect.objectContaining({ cleanupReason: "Proposal archived" }),
      }),
    });
  });

  it("purges work item version snapshots when purging a work item", async () => {
    const action = {
      id: "action-1",
      workspaceId: "workspace-1",
      title: "Follow up",
      archivedAt: new Date("2026-04-25T12:00:00.000Z"),
      status: "DRAFT",
    };
    prismaMock.action.findFirst.mockResolvedValue(action);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-1" });
    prismaMock.action.delete.mockResolvedValue(action);

    const { purgeWorkspaceArtifact } = await import("./archive");
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Action",
      entityId: "action-1",
      reason: "cleanup",
    })).resolves.toEqual({ id: "action-1" });

    expect(prismaMock.workItemVersion.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        entityType: "Action",
        entityId: "action-1",
      },
    });
    expect(prismaMock.action.delete).toHaveBeenCalledWith({ where: { id: "action-1" } });
  });

  it("locks Proposal purge in proposal-then-corpus order before the authoritative read", async () => {
    const proposal = {
      id: "proposal-purge-locked",
      workspaceId: "workspace-1",
      title: "Archived accepted proposal",
      archivedAt: new Date("2026-04-25T12:00:00.000Z"),
      status: "RESOLVED",
    };
    prismaMock.proposal.findFirst.mockResolvedValue(proposal);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-proposal" });
    prismaMock.proposal.delete.mockResolvedValue(proposal);

    const { purgeWorkspaceArtifact } = await import("./archive");
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Proposal",
      entityId: proposal.id,
      reason: "retention window elapsed",
    })).resolves.toEqual({ id: proposal.id });

    expect(prismaMock.$executeRaw).toHaveBeenNthCalledWith(1, expect.anything(), `Proposal:${proposal.id}`);
    expect(prismaMock.$executeRaw).toHaveBeenNthCalledWith(2, expect.anything(), "workspace-1");
    const [proposalLockOrder, corpusLockOrder] = prismaMock.$executeRaw.mock.invocationCallOrder;
    const proposalReadOrder = prismaMock.proposal.findFirst.mock.invocationCallOrder[0];
    expect(proposalLockOrder).toBeLessThan(corpusLockOrder);
    expect(corpusLockOrder).toBeLessThan(proposalReadOrder);
  });

  it.each([
    ["Document", "document", "documentId"],
    ["BrainSource", "brainSource", "brainSourceId"],
  ] as const)("blocks generic archive and purge for linked %s records", async (entityType, delegateName, linkField) => {
    const delegate = prismaMock[delegateName];
    const record = {
      id: `${delegateName}-1`,
      workspaceId: "workspace-1",
      title: "Synthetic report",
      archivedAt: null,
      storageKey: "private/report",
      fileStorageKey: "private/report",
    };
    delegate.findFirst.mockResolvedValue(record);
    prismaMock.financeImportBatch.findFirst.mockResolvedValue({ id: "batch-1" });

    const { archiveWorkspaceArtifact, purgeWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType,
      entityId: record.id,
    })).rejects.toMatchObject({ code: "FINANCE_IMPORT_ARTIFACT_MANAGED" });
    expect(delegate.update).not.toHaveBeenCalled();

    delegate.findFirst.mockResolvedValue({ ...record, archivedAt: new Date() });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-1" });
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType,
      entityId: record.id,
      reason: "synthetic cleanup",
    })).rejects.toMatchObject({ code: "FINANCE_IMPORT_ARTIFACT_MANAGED" });

    expect(prismaMock.financeImportBatch.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", [linkField]: record.id },
      select: { id: true },
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(delegate.delete).not.toHaveBeenCalled();
  });

  it("allows admins and source authors through the generic BrainSource archive path", async () => {
    const source = {
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Author source",
      authorMemberId: "author-member",
      archivedAt: null,
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.update.mockResolvedValue({ ...source, archivedAt: new Date("2026-08-20T10:00:00.000Z") });
    const { archiveWorkspaceArtifact } = await import("./archive");

    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "admin-member",
      workspaceId: "workspace-1",
      userId: "admin-user",
      role: "ADMIN",
      isActive: true,
    });
    await expect(archiveWorkspaceArtifact({
      kind: "user",
      user: { id: "admin-user", email: "admin@example.com", displayName: "Admin" },
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    })).resolves.toMatchObject({ id: "source-1" });

    prismaMock.brainSource.update.mockClear();
    prismaMock.member.findUnique.mockResolvedValueOnce({
      id: "author-member",
      workspaceId: "workspace-1",
      userId: "author-user",
      role: "MEMBER",
      isActive: true,
    });
    await expect(archiveWorkspaceArtifact({
      kind: "user",
      user: { id: "author-user", email: "author@example.com", displayName: "Author" },
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    })).resolves.toMatchObject({ id: "source-1" });

    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-1" },
    }));
  });

  it("blocks non-author contributors and legacy authorless sources through the generic BrainSource archive path", async () => {
    const { archiveWorkspaceArtifact } = await import("./archive");
    prismaMock.member.findUnique.mockResolvedValue({
      id: "other-member",
      workspaceId: "workspace-1",
      userId: "other-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainSource.findFirst.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Author source",
      authorMemberId: "author-member",
      archivedAt: null,
    });

    await expect(archiveWorkspaceArtifact({
      kind: "user",
      user: { id: "other-user", email: "other@example.com", displayName: "Other" },
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    prismaMock.brainSource.findFirst.mockResolvedValue({
      id: "source-legacy",
      workspaceId: "workspace-1",
      title: "Legacy source",
      authorMemberId: null,
      archivedAt: null,
    });
    await expect(archiveWorkspaceArtifact({
      kind: "user",
      user: { id: "other-user", email: "other@example.com", displayName: "Other" },
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-legacy",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect(prismaMock.brainSource.update).not.toHaveBeenCalled();
  });

  it.each([
    ["brain:write"],
    ["support:write"],
  ])("allows credential agents with %s through the generic BrainSource archive path", async (scope) => {
    const source = {
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Agent source",
      authorMemberId: "author-member",
      archivedAt: null,
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.update.mockResolvedValue({ ...source, archivedAt: new Date("2026-08-20T10:00:00.000Z") });
    const { archiveWorkspaceArtifact } = await import("./archive");

    await expect(archiveWorkspaceArtifact({
      kind: "agent",
      authProvider: "credential",
      workspaceIds: ["workspace-1"],
      scopes: [scope],
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    })).resolves.toMatchObject({ id: "source-1" });
  });

  it("blocks read-only credential agents through the generic BrainSource archive path", async () => {
    prismaMock.brainSource.findFirst.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Agent source",
      authorMemberId: "author-member",
      archivedAt: null,
    });
    const { archiveWorkspaceArtifact } = await import("./archive");

    await expect(archiveWorkspaceArtifact({
      kind: "agent",
      authProvider: "credential",
      workspaceIds: ["workspace-1"],
      scopes: ["brain:read"],
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect(prismaMock.brainSource.update).not.toHaveBeenCalled();
  });

  it("requires finance write scope before credential agents archive Finance BrainSources", async () => {
    const source = {
      id: "source-finance",
      workspaceId: "workspace-1",
      title: "Finance source",
      authorMemberId: "author-member",
      accessDomain: "FINANCE",
      archivedAt: null,
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.update.mockResolvedValue({ ...source, archivedAt: new Date("2026-08-20T10:00:00.000Z") });
    const { archiveWorkspaceArtifact } = await import("./archive");

    await expect(archiveWorkspaceArtifact({
      kind: "agent",
      authProvider: "credential",
      workspaceIds: ["workspace-1"],
      scopes: ["brain:write"],
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-finance",
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    await expect(archiveWorkspaceArtifact({
      kind: "agent",
      authProvider: "credential",
      workspaceIds: ["workspace-1"],
      scopes: ["brain:write", "finance:write"],
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-finance",
    })).resolves.toMatchObject({ id: "source-finance" });
  });

  it("locks BrainSource archive state before reading and updating the source", async () => {
    const source = {
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Locked source",
      authorMemberId: "author-member",
      archivedAt: null,
    };
    prismaMock.member.findUnique.mockResolvedValue({
      id: "author-member",
      workspaceId: "workspace-1",
      userId: "author-user",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.update.mockResolvedValue({ ...source, archivedAt: new Date("2026-08-20T10:00:00.000Z") });
    const { archiveWorkspaceArtifact } = await import("./archive");

    await archiveWorkspaceArtifact({
      kind: "user",
      user: { id: "author-user", email: "author@example.com", displayName: "Author" },
    } as AppActor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-1",
    });

    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.brainSource.findFirst.mock.invocationCallOrder[0]);
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.brainSource.update.mock.invocationCallOrder[0]);
  });

  it("requeues BrainSource processing when a source is restored", async () => {
    const source = {
      id: "source-restored",
      workspaceId: "workspace-1",
      title: "Restored source",
      authorMemberId: "author-member",
      absorbedAt: new Date("2026-08-20T10:05:00.000Z"),
      archivedAt: new Date("2026-08-20T10:00:00.000Z"),
    };
    prismaMock.member.findUnique.mockResolvedValue({
      id: "admin-member",
      workspaceId: "workspace-1",
      userId: "admin-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-source", previousState: {} });
    prismaMock.brainSource.update.mockResolvedValue({ ...source, archivedAt: null });
    const { restoreWorkspaceArtifact } = await import("./archive");

    await restoreWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: "source-restored",
    });

    expect(appendEventsMock).toHaveBeenCalledWith(prismaMock, [
      {
        workspaceId: "workspace-1",
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: "source-restored",
        payload: { sourceId: "source-restored" },
      },
    ]);
  });

  it("retains generic lifecycle behavior for unlinked knowledge artifacts", async () => {
    const document = {
      id: "document-1",
      workspaceId: "workspace-1",
      title: "Unlinked",
      archivedAt: null,
      storageKey: "private/unlinked",
    };
    prismaMock.document.findFirst.mockResolvedValue(document);
    prismaMock.document.update.mockResolvedValue({ ...document, archivedAt: new Date() });
    const { archiveWorkspaceArtifact, purgeWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "Document",
      entityId: document.id,
    })).resolves.toMatchObject({ id: document.id });

    const source = {
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Unlinked",
      archivedAt: new Date(),
      fileStorageKey: "private/unlinked",
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.delete.mockResolvedValue(source);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-1" });
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: source.id,
      reason: "synthetic cleanup",
    })).resolves.toEqual({ id: source.id });

    expect(prismaMock.document.update).toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalled();
    expect(storageDeleteMock).toHaveBeenCalledWith("private/unlinked");
    expect(prismaMock.brainSource.delete).toHaveBeenCalledWith({ where: { id: source.id } });
  });

  it("leaves private storage intact when the database purge fails", async () => {
    const source = {
      id: "source-1",
      workspaceId: "workspace-1",
      title: "Unlinked",
      archivedAt: new Date(),
      fileStorageKey: "private/unlinked",
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-1" });
    prismaMock.brainSource.delete.mockRejectedValue(new Error("database failure"));
    const { purgeWorkspaceArtifact } = await import("./archive");
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "BrainSource",
      entityId: source.id,
      reason: "synthetic cleanup",
    })).rejects.toThrow("database failure");
    expect(storageDeleteMock).not.toHaveBeenCalled();
  });

  it("lists active archive records by default", async () => {
    prismaMock.workspaceArchiveRecord.findMany.mockResolvedValue([{ id: "archive-1" }]);

    const { listArchivedWorkspaceArtifacts } = await import("./archive");
    await expect(listArchivedWorkspaceArtifacts(actor, {
      workspaceId: "workspace-1",
      entityType: "Action",
    })).resolves.toEqual([{ id: "archive-1", permanentPath: null }]);

    expect(prismaMock.workspaceArchiveRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        entityType: "Action",
        restoredAt: null,
        purgedAt: null,
      }),
    }));
  });

  it("can look up purged archive records for typed link status pages", async () => {
    const purgedAt = new Date("2026-06-24T12:00:00.000Z");
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({
      id: "archive-1",
      entityType: "Tension",
      entityId: "tension-1",
      purgedAt,
    });

    const { getWorkspaceArchiveRecord } = await import("./archive");
    await expect(getWorkspaceArchiveRecord(actor, {
      workspaceId: "workspace-1",
      entityType: "Tension",
      entityId: "tension-1",
      includePurged: true,
    })).resolves.toMatchObject({ id: "archive-1", purgedAt });

    expect(prismaMock.workspaceArchiveRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        entityType: "Tension",
        entityId: "tension-1",
        restoredAt: null,
      }),
    }));
    expect(prismaMock.workspaceArchiveRecord.findFirst.mock.calls.at(-1)?.[0].where).not.toHaveProperty("purgedAt");
  });
});
