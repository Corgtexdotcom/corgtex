import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";


const { prismaMock, requireWorkspaceMembershipMock, captureMock, finishMock } = vi.hoisted(() => ({
  prismaMock: {
    workspacePermalink: {
      findFirst: vi.fn(),
    },
    workspaceArchiveRecord: {
      findFirst: vi.fn(),
    },
    action: { findFirst: vi.fn() },
    tension: { findFirst: vi.fn() },
    proposal: { findFirst: vi.fn() },
    brainArticle: { findFirst: vi.fn() },
    meeting: { findFirst: vi.fn() },
    goal: { findFirst: vi.fn() },
  },
  requireWorkspaceMembershipMock: vi.fn(),
  captureMock: vi.fn(), finishMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

vi.mock("./digest-lineage", () => ({
  DigestReadRelease: class {
    capture = captureMock;
    finish = finishMock;
  },
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

describe("workspace permalinks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    captureMock.mockImplementation(async (_kind, records) => ({records}));
    finishMock.mockImplementation(async value => value);
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.workspaceArchiveRecord.findFirst.mockResolvedValue(null);
  });

  it("applies goal privacy when resolving permanent links", async () => {
    prismaMock.workspacePermalink.findFirst.mockResolvedValueOnce({
      id: "permalink-1",
      workspaceId: "ws-1",
      entityType: "Goal",
      entityId: "goal-private",
      canonicalPath: "/workspaces/ws-1/goals?goalId=goal-private",
    });
    prismaMock.goal.findFirst.mockResolvedValueOnce(null);

    const { resolveWorkspacePermalink } = await import("./permalinks");
    await expect(resolveWorkspacePermalink(actor, {
      workspaceId: "ws-1",
      permalinkId: "permalink-1",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    expect(prismaMock.goal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "goal-private",
        workspaceId: "ws-1",
        OR: expect.arrayContaining([
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
        ]),
      }),
    }));
  });

  it("does not return a saved canonical path for an article with unknown lineage", async () => {
    prismaMock.workspacePermalink.findFirst.mockResolvedValueOnce({
      id: "permalink-2", workspaceId: "ws-1", entityType: "BrainArticle", entityId: "article-1",
      canonicalPath: "/workspaces/ws-1/brain/secret-title",
    });
    prismaMock.brainArticle.findFirst.mockResolvedValueOnce({ id: "article-1", workspaceId: "ws-1",
      slug: "secret-title", isPrivate: false, archivedAt: null });
    captureMock.mockResolvedValueOnce({records: []});
    const { resolveWorkspacePermalink } = await import("./permalinks");
    await expect(resolveWorkspacePermalink(actor, { workspaceId: "ws-1", permalinkId: "permalink-2" }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
  it.each(["Action", "Tension", "Proposal", "BrainArticle", "Meeting", "Goal"] as const)("requires full canonical %s admission and final release before returning a redirect", async entityType => {
    const name = entityType === "BrainArticle" ? "brainArticle" : entityType[0].toLowerCase() + entityType.slice(1);
    const row = {id: "target", workspaceId: "ws-1", title: "Canonical body", bodyMd: "Original", transcript: "Original", archivedAt: null, isPrivate: false};
    prismaMock.workspacePermalink.findFirst.mockResolvedValue({id: "link", workspaceId: "ws-1", entityType, entityId: row.id});
    const delegate = prismaMock[name as "action"];
    delegate.findFirst.mockResolvedValue(row);
    const {resolveWorkspacePermalink} = await import("./permalinks");
    const result = await resolveWorkspacePermalink(actor, {workspaceId: "ws-1", permalinkId: "link"});
    expect(result.status).toBe("ACTIVE");
    expect(delegate.findFirst.mock.calls[0][0]).not.toHaveProperty("select");
    expect(captureMock).toHaveBeenCalledWith(entityType, [row]);
    expect(finishMock).toHaveBeenCalledWith(result);
    captureMock.mockResolvedValueOnce({records: []});
    await expect(resolveWorkspacePermalink(actor, {workspaceId: "ws-1", permalinkId: "link"})).rejects.toMatchObject({status: 404});
    finishMock.mockRejectedValueOnce(new Error("Source changed during release"));
    await expect(resolveWorkspacePermalink(actor, {workspaceId: "ws-1", permalinkId: "link"})).rejects.toThrow("Source changed during release");
  });

});
