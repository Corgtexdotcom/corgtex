import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock } = vi.hoisted(() => {
  const tx = {
    tension: { findFirst: vi.fn() },
    workItemVersion: { findMany: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({
    id: "member-1",
    workspaceId: "ws-1",
    userId: "user-1",
    role: "CONTRIBUTOR",
    isActive: true,
  }),
}));

vi.mock("./privacy", () => ({
  privacyFilter: vi.fn(() => ({ isPrivate: false })),
}));

describe("work item versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.tension.findFirst.mockResolvedValue({ id: "tension-1", version: 2 });
    txMock.workItemVersion.findMany.mockResolvedValue([]);
  });

  it("requires active non-archived access before listing historical snapshots", async () => {
    const { listWorkItemVersions } = await import("./work-item-versions");

    await listWorkItemVersions(
      { kind: "user", user: { id: "user-1" } } as any,
      { workspaceId: "ws-1", entityType: "TENSION", entityId: "tension-1" },
    );

    expect(txMock.tension.findFirst).toHaveBeenCalledWith({
      where: {
        id: "tension-1",
        workspaceId: "ws-1",
        archivedAt: null,
        isPrivate: false,
      },
      select: { id: true, version: true },
    });
    expect(txMock.workItemVersion.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        entityType: "Tension",
        entityId: "tension-1",
      },
      orderBy: { version: "desc" },
    });
  });
});
