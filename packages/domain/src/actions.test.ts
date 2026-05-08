import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    action: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
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
