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
    spendRequest: {
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ledgerAccount: {
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ledgerEntry: {
      count: vi.fn(),
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
    prismaMock.workspaceArchiveRecord.create.mockResolvedValue({});
    prismaMock.workspaceArchiveRecord.update.mockResolvedValue({});
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

  it("refuses to purge submitted spend requests", async () => {
    prismaMock.spendRequest.findFirst.mockResolvedValue({
      id: "spend-1",
      workspaceId: "workspace-1",
      description: "Submitted spend",
      archivedAt: new Date("2026-04-25T12:00:00.000Z"),
      status: "OPEN",
    });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue({ id: "archive-1" });

    const { purgeWorkspaceArtifact } = await import("./archive");
    await expect(purgeWorkspaceArtifact(actor, {
      workspaceId: "workspace-1",
      entityType: "SpendRequest",
      entityId: "spend-1",
      reason: "mistake",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_STATE",
    });
    expect(prismaMock.spendRequest.delete).not.toHaveBeenCalled();
  });

  it("lets requesters archive only their own draft spend requests", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "requester-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.spendRequest.findFirst.mockResolvedValue({
      id: "spend-1",
      workspaceId: "workspace-1",
      requesterUserId: "requester-1",
      description: "Draft spend",
      archivedAt: null,
      status: "DRAFT",
    });
    prismaMock.spendRequest.update.mockResolvedValue({ id: "spend-1", archivedAt: new Date("2026-04-25T12:00:00.000Z") });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(contributorActor, {
      workspaceId: "workspace-1",
      entityType: "SpendRequest",
      entityId: "spend-1",
      reason: "mistake",
    })).resolves.toMatchObject({ id: "spend-1" });

    expect(prismaMock.spendRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "spend-1" },
      data: expect.objectContaining({
        archivedByUserId: "requester-1",
      }),
    }));
  });

  it("blocks contributors from archiving another requester's draft spend", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "requester-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.spendRequest.findFirst.mockResolvedValue({
      id: "spend-1",
      workspaceId: "workspace-1",
      requesterUserId: "requester-2",
      description: "Other draft spend",
      archivedAt: null,
      status: "DRAFT",
    });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(contributorActor, {
      workspaceId: "workspace-1",
      entityType: "SpendRequest",
      entityId: "spend-1",
      reason: "mistake",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(prismaMock.spendRequest.update).not.toHaveBeenCalled();
  });

  it("blocks contributors from archiving their own non-draft spend", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "requester-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.spendRequest.findFirst.mockResolvedValue({
      id: "spend-1",
      workspaceId: "workspace-1",
      requesterUserId: "requester-1",
      description: "Submitted spend",
      archivedAt: null,
      status: "OPEN",
    });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(contributorActor, {
      workspaceId: "workspace-1",
      entityType: "SpendRequest",
      entityId: "spend-1",
      reason: "mistake",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    expect(prismaMock.spendRequest.update).not.toHaveBeenCalled();
  });

  it("lets finance stewards archive submitted spend requests", async () => {
    prismaMock.member.findUnique.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "requester-1",
      role: "FINANCE_STEWARD",
      isActive: true,
    });
    prismaMock.spendRequest.findFirst.mockResolvedValue({
      id: "spend-1",
      workspaceId: "workspace-1",
      requesterUserId: "requester-2",
      description: "Submitted spend",
      archivedAt: null,
      status: "OPEN",
    });
    prismaMock.spendRequest.update.mockResolvedValue({ id: "spend-1", archivedAt: new Date("2026-04-25T12:00:00.000Z") });

    const { archiveWorkspaceArtifact } = await import("./archive");
    await expect(archiveWorkspaceArtifact(contributorActor, {
      workspaceId: "workspace-1",
      entityType: "SpendRequest",
      entityId: "spend-1",
      reason: "finance cleanup",
    })).resolves.toMatchObject({ id: "spend-1" });

    expect(prismaMock.spendRequest.update).toHaveBeenCalled();
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
