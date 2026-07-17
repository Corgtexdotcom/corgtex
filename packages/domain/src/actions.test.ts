import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    action: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    adviceProcess: {
      findMany: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    workItemEvidence: {
      createMany: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    workItemVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
  },
}));

const appendEvents = vi.fn();
const recordAudit = vi.fn();
const requireWorkspaceMembership = vi.fn();

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace: vi.fn(async () => "user-1"),
  requireWorkspaceMembership,
}));

vi.mock("./audit-trail", () => ({
  recordAudit,
}));

vi.mock("./events", () => ({
  appendEvents,
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};

describe("action domain lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    recordAudit.mockResolvedValue(undefined);
    appendEvents.mockResolvedValue(undefined);
    prismaMock.$executeRaw.mockResolvedValue({});
    prismaMock.workItemVersion.create.mockResolvedValue({});
    prismaMock.workItemVersion.findUnique.mockResolvedValue(null);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.member.findFirst.mockResolvedValue({ id: "member-2" });
    prismaMock.adviceProcess.findMany.mockResolvedValue([]);
  });

  it("creates form-submitted actions as private drafts by default", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-private",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: " Follow up ",
      bodyMd: " Notes ",
      priority: 4,
    })).resolves.toMatchObject({
      id: "action-private",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Follow up",
        bodyMd: "Notes",
        priority: 4,
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.created",
      entityId: "action-private",
    }));
    expect(recordAudit).not.toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.published",
    }));
  });

  it("creates an action with a valid assignee member", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-assigned",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      assigneeMemberId: "member-2",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      assigneeMemberId: "member-2",
    })).resolves.toMatchObject({
      id: "action-assigned",
      assigneeMemberId: "member-2",
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-2",
        workspaceId: "workspace-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assigneeMemberId: "member-2",
      }),
    });
  });

  it("rejects invalid action assignees", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce(null);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      assigneeMemberId: "missing-member",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });

  it("combines member filters with the existing privacy filter", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([{ id: "action-1" }]);
    prismaMock.action.count.mockResolvedValueOnce(0);
    prismaMock.adviceProcess.findMany.mockResolvedValueOnce([
      {
        subjectId: "action-1",
        requests: [
          { status: "ACTIVE" },
          { status: "COMPLETED" },
        ],
      },
    ]);

    const { listActions } = await import("./actions");
    await expect(listActions(actor, "workspace-1", { memberId: "member-1", circleId: "circle-1", sort: "alpha" })).resolves.toMatchObject({
      items: [
        {
          id: "action-1",
          inputRequestCount: 2,
          activeInputRequestCount: 1,
        },
      ],
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        circleId: "circle-1",
        AND: [
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
            ],
          },
          {
            OR: [
              { assigneeMemberId: { in: ["member-1"] } },
              {
                author: {
                  memberships: {
                    some: {
                      id: { in: ["member-1"] },
                      workspaceId: "workspace-1",
                      isActive: true,
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
      orderBy: [
        { title: "asc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
    }));
    expect(prismaMock.adviceProcess.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        subjectType: "ACTION",
        subjectId: { in: ["action-1"] },
      },
      select: {
        subjectId: true,
        requests: {
          select: { status: true },
        },
      },
    });
  });

  it("creates unchecked-private actions as open public records", async () => {
    prismaMock.action.create.mockResolvedValueOnce({
      id: "action-public",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-05-26T12:00:00.000Z"),
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      isPrivate: false,
    })).resolves.toMatchObject({
      id: "action-public",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.created",
      entityId: "action-public",
    }));
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.published",
      entityId: "action-public",
    }));
    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "action.published",
        aggregateId: "action-public",
        payload: { actionId: "action-public" },
      }),
    ]);
  });

  it("opens an existing public draft action to recover records created by the bad form default", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: false,
      publishedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
    });

    const { publishAction } = await import("./actions");
    await expect(publishAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    }));
  });

  it("returns an open action to draft for the draft owner", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    const { returnActionToDraft } = await import("./actions");
    await expect(returnActionToDraft(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      }),
    }));
  });

  it("returns a completed action to draft and clears completion state", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "COMPLETED",
      completedVia: "Done",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      status: "DRAFT",
      isPrivate: true,
      completedVia: null,
      publishedAt: null,
    });

    const { returnActionToDraft } = await import("./actions");
    await expect(returnActionToDraft(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        completedVia: null,
      }),
    }));
  });

  it("allows an author to edit an open action and snapshots the previous version", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      bodyMd: "Old notes",
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up now",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Follow up now",
      priority: 5,
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        version: 1,
        changedFields: ["title", "priority"],
        previousState: expect.objectContaining({
          title: "Follow up",
          priority: 1,
          version: 1,
        }),
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: { title: "Follow up now", priority: 5, version: 2 },
    }));
  });

  it("updates an action assignee and snapshots the previous version", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      bodyMd: "Old notes",
      assigneeMemberId: null,
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      assigneeMemberId: "member-2",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      assigneeMemberId: "member-2",
    })).resolves.toMatchObject({
      assigneeMemberId: "member-2",
      version: 2,
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-2",
        workspaceId: "workspace-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        changedFields: ["assigneeMemberId"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: { assigneeMemberId: "member-2", version: 2 },
    }));
  });

  it("allows an assigned member to edit an open action and snapshots the previous version", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Follow up",
      bodyMd: "Old notes",
      priority: 1,
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Assignee update",
      status: "OPEN",
      version: 2,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-2",
        email: "assignee@example.com",
        displayName: "Assignee",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Assignee update",
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        version: 1,
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: { title: "Assignee update", version: 2 },
    }));
  });

  it("blocks unrelated members from editing an open action", async () => {
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-3",
      workspaceId: "workspace-1",
      userId: "user-3",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-3",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Not allowed",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("requires a completion note when completing an action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: "   ",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("links completion evidence when completing an action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "IN_PROGRESS",
      version: 1,
      completedVia: null,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "COMPLETED",
      version: 1,
      completedVia: "Delivered and checked.",
    });
    prismaMock.document.findMany.mockResolvedValue([{ id: "doc-1" }]);
    prismaMock.workItemEvidence.createMany.mockResolvedValue({ count: 1 });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: " Delivered and checked. ",
      evidenceDocumentIds: ["doc-1", "doc-1"],
    })).resolves.toMatchObject({
      id: "action-1",
      status: "COMPLETED",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        completedVia: "Delivered and checked.",
      }),
    }));
    expect(prismaMock.document.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        archivedAt: null,
        id: { in: ["doc-1"] },
      },
      select: { id: true },
    });
    expect(prismaMock.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "workspace-1",
        entityType: "Action",
        entityId: "action-1",
        documentId: "doc-1",
        purpose: "completion_evidence",
      }],
      skipDuplicates: true,
    });
  });

  it("allows a draft action to move directly to completed with a completion note", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      version: 1,
      completedVia: null,
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
    });
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      status: "COMPLETED",
      completedVia: "Done from draft.",
      isPrivate: false,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      status: "COMPLETED",
      completedVia: " Done from draft. ",
    })).resolves.toMatchObject({
      id: "action-1",
      status: "COMPLETED",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "action-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        isPrivate: false,
        publishedAt: expect.any(Date),
        completedVia: "Done from draft.",
      }),
    }));
  });

  it("blocks non-managers from editing another member's draft action", async () => {
    prismaMock.action.findUnique.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Follow up",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
    });
    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });

    const { updateAction } = await import("./actions");
    await expect(updateAction({
      kind: "user",
      user: {
        id: "user-2",
        email: "other@example.com",
        displayName: "Other",
        globalRole: "USER",
      },
    }, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Changed",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.action.update).not.toHaveBeenCalled();
  });

  it("rejects hidden, missing, archived, or cross-workspace linked proposals before creating an action", async () => {
    prismaMock.proposal.findFirst.mockResolvedValueOnce(null);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Follow up",
      proposalId: "proposal-missing",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prismaMock.proposal.findFirst).toHaveBeenCalledWith({
      where: {
        id: "proposal-missing",
        workspaceId: "workspace-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      },
      select: { id: true },
    });
    expect(prismaMock.action.create).not.toHaveBeenCalled();
  });
});
