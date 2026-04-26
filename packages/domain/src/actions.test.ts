import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    action: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
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
});
