import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock, storageDeleteMock } = vi.hoisted(() => {
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
    auditLog: {
      create: vi.fn(),
    },
    workItemVersion: {
      deleteMany: vi.fn(),
    },
  };
  return { prismaMock: prisma, storageDeleteMock: vi.fn() };
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

const actor: AppActor = {
  kind: "user" as const,
  user: {
    id: "admin-1",
    email: "admin@example.com",
    displayName: "Admin",
    globalRole: "OPERATOR",
  },
};

const contributorActor: AppActor = {
  kind: "user" as const,
  user: {
    id: "requester-1",
    email: "requester@example.com",
    displayName: "Requester",
    globalRole: "USER",
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
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});
    prismaMock.workspaceArchiveRecord.update.mockResolvedValue({});
    prismaMock.workItemVersion.deleteMany.mockResolvedValue({ count: 0 });
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

  it("lists active archive records by default", async () => {
    prismaMock.workspaceArchiveRecord.findMany.mockResolvedValue([{ id: "archive-1" }]);

    const { listArchivedWorkspaceArtifacts } = await import("./archive");
    await expect(listArchivedWorkspaceArtifacts(actor, {
      workspaceId: "workspace-1",
      entityType: "Action",
    })).resolves.toEqual([{ id: "archive-1" }]);

    expect(prismaMock.workspaceArchiveRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        entityType: "Action",
        restoredAt: null,
        purgedAt: null,
      }),
    }));
  });
});
