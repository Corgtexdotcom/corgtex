import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    action: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    adviceProcess: {
      findMany: vi.fn(),
    },
    actionChecklistItem: {
      create: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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
    prismaMock.actionChecklistItem.findMany.mockResolvedValue([]);
    prismaMock.actionChecklistItem.findFirst.mockResolvedValue(null);
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

  it("fills a missing proposal link when updating an existing duplicate action", async () => {
    const existingAction = {
      id: "action-existing",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      title: "Send Acme proposal",
      bodyMd: null,
      assigneeMemberId: null,
      dueAt: null,
      proposalId: null,
      circleId: null,
      priority: 1,
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      archivedAt: null,
      version: 1,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.action.findMany.mockResolvedValueOnce([existingAction]);
    prismaMock.action.findFirst.mockResolvedValueOnce(existingAction);
    prismaMock.action.findUnique.mockResolvedValueOnce(existingAction);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({ id: "proposal-1" });
    prismaMock.action.update.mockResolvedValueOnce({
      ...existingAction,
      proposalId: "proposal-1",
      priority: 5,
      version: 2,
    });

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Send Acme proposal",
      proposalId: "proposal-1",
      priority: 5,
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "action-existing",
      },
    })).resolves.toMatchObject({
      id: "action-existing",
      proposalId: "proposal-1",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-existing" }),
      data: expect.objectContaining({
        proposalId: "proposal-1",
        priority: 5,
        version: expect.any(Number),
      }),
    }));
  });

  it("stops likely duplicate actions before creating a new row", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([
      {
        id: "action-existing",
        workspaceId: "workspace-1",
        title: "Send Acme proposal",
        bodyMd: null,
        assigneeMemberId: "member-2",
        dueAt: new Date("2026-07-24T09:00:00.000Z"),
        status: "OPEN",
        isPrivate: false,
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
      },
    ]);

    const { createAction } = await import("./actions");
    await expect(createAction(actor, {
      workspaceId: "workspace-1",
      title: "Send proposal to Acme",
      assigneeMemberId: "member-2",
      dueAt: new Date("2026-07-24T16:00:00.000Z"),
      duplicateGuard: {},
    })).rejects.toMatchObject({
      status: 409,
      code: "DUPLICATE_GUARD_MATCH",
      candidate: expect.objectContaining({
        entityId: "action-existing",
        matchKind: "likely",
      }),
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.action.create).not.toHaveBeenCalled();
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

  it("returns checklist progress only as action summary counts", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([
      { id: "action-1" },
      { id: "action-2" },
    ]);
    prismaMock.action.count.mockResolvedValueOnce(2);
    prismaMock.actionChecklistItem.findMany.mockResolvedValueOnce([
      { actionId: "action-1", completedAt: new Date("2026-07-20T10:00:00.000Z") },
      { actionId: "action-1", completedAt: null },
      { actionId: "action-2", completedAt: null },
    ]);

    const { listActions } = await import("./actions");
    await expect(listActions(actor, "workspace-1")).resolves.toMatchObject({
      items: [
        {
          id: "action-1",
          checklistItemCount: 2,
          checklistCompletedCount: 1,
        },
        {
          id: "action-2",
          checklistItemCount: 1,
          checklistCompletedCount: 0,
        },
      ],
    });

    expect(prismaMock.actionChecklistItem.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        actionId: { in: ["action-1", "action-2"] },
      },
      select: {
        actionId: true,
        completedAt: true,
      },
    });
  });

  it("filters exact assignees separately from broader member involvement", async () => {
    prismaMock.action.findMany.mockResolvedValueOnce([]);
    prismaMock.action.count.mockResolvedValueOnce(0);

    const { listActions } = await import("./actions");
    await listActions(actor, "workspace-1", {
      assigneeMemberIds: ["member-2", "member-2", ""],
    });

    expect(prismaMock.action.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        assigneeMemberId: { in: ["member-2"] },
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ],
      }),
    }));
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
      data: { title: "Assignee update", version: 2 },
    }));
  });

  it("allows any active member to edit a public open action", async () => {
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
    prismaMock.action.update.mockResolvedValue({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "agent-user",
      assigneeMemberId: "member-2",
      title: "Allowed update",
      status: "OPEN",
      version: 2,
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
      title: "Allowed update",
    })).resolves.toMatchObject({
      id: "action-1",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Action",
        entityId: "action-1",
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "action-1" }),
      data: { title: "Allowed update", version: 2 },
    }));
  });

  it("rejects stale collaborative action edits when the action changes before write", async () => {
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
      title: "Follow up",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.action.update.mockRejectedValueOnce({ code: "P2025" });

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
      title: "Stale edit",
    })).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });

    expect(prismaMock.action.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "action-1",
        workspaceId: "workspace-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      }),
      data: { title: "Stale edit", version: 2 },
    }));
    expect(recordAudit).not.toHaveBeenCalled();
    expect(appendEvents).not.toHaveBeenCalled();
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
      where: expect.objectContaining({ id: "action-1" }),
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
      where: expect.objectContaining({ id: "action-1" }),
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

  it("creates checklist items after verifying action edit access", async () => {
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "OPEN",
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({ sortOrder: 2 });
    prismaMock.actionChecklistItem.create.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
      sortOrder: 3,
    });

    const { createActionChecklistItem } = await import("./actions");
    await expect(createActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: " Call the supplier ",
    })).resolves.toMatchObject({
      id: "checklist-1",
      title: "Call the supplier",
      sortOrder: 3,
    });

    expect(prismaMock.actionChecklistItem.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        actionId: "action-1",
        title: "Call the supplier",
        sortOrder: 3,
      },
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.created",
      entityId: "action-1",
    }));
    expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        type: "action.checklist_item.created",
        aggregateId: "action-1",
      }),
    ]);
  });

  it("marks checklist items complete with the acting user", async () => {
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
      completedAt: null,
    });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "IN_PROGRESS",
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.update.mockResolvedValueOnce({
      id: "checklist-1",
      title: "Call the supplier",
      completedAt: new Date("2026-07-20T10:00:00.000Z"),
    });

    const { updateActionChecklistItem } = await import("./actions");
    await expect(updateActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
      completed: true,
    })).resolves.toMatchObject({
      id: "checklist-1",
    });

    expect(prismaMock.actionChecklistItem.update).toHaveBeenCalledWith({
      where: { id: "checklist-1" },
      data: expect.objectContaining({
        completedAt: expect.any(Date),
        completedBy: { connect: { id: "user-1" } },
      }),
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.updated",
      meta: expect.objectContaining({
        fields: ["completed"],
      }),
    }));
  });

  it("deletes checklist items after verifying action edit access", async () => {
    prismaMock.actionChecklistItem.findFirst.mockResolvedValueOnce({
      id: "checklist-1",
      workspaceId: "workspace-1",
      actionId: "action-1",
      title: "Call the supplier",
    });
    prismaMock.action.findFirst.mockResolvedValueOnce({
      id: "action-1",
      workspaceId: "workspace-1",
      authorUserId: "user-1",
      status: "OPEN",
      archivedAt: null,
      isPrivate: false,
      assigneeMemberId: null,
    });
    prismaMock.actionChecklistItem.delete.mockResolvedValueOnce({ id: "checklist-1" });

    const { deleteActionChecklistItem } = await import("./actions");
    await expect(deleteActionChecklistItem(actor, {
      workspaceId: "workspace-1",
      checklistItemId: "checklist-1",
    })).resolves.toEqual({ id: "checklist-1" });

    expect(prismaMock.actionChecklistItem.delete).toHaveBeenCalledWith({ where: { id: "checklist-1" } });
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
      action: "action.checklist_item.deleted",
      entityId: "action-1",
    }));
  });
});
