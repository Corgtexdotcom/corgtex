import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const { listGoalsMock, findManyTensionsMock, findManyActionsMock } = vi.hoisted(() => ({
  listGoalsMock: vi.fn(),
  findManyTensionsMock: vi.fn(),
  findManyActionsMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    tension: { findMany: findManyTensionsMock },
    action: { findMany: findManyActionsMock },
  },
}));

vi.mock("@corgtex/domain", () => ({
  listGoals: listGoalsMock,
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ role: "MEMBER" }),
  privacyFilter: (a: any, m?: any) =>
    m?.role === "ADMIN"
      ? { OR: [{ isPrivate: false }, { isPrivate: true, status: "DRAFT" }] }
      : a?.kind === "user"
      ? { OR: [{ isPrivate: false }, { isPrivate: true, status: "DRAFT", authorUserId: a.user.id }] }
      : { isPrivate: false },
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

describe("workspace agent tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listGoalsMock.mockResolvedValue([
      {
        id: "goal-1",
        title: "Launch goal",
        descriptionMd: "Launch safely.",
        cadence: "QUARTERLY",
        level: "COMPANY",
        status: "ACTIVE",
        progressPercent: 25,
        targetDate: null,
        startDate: null,
        circle: { name: "General" },
        ownerMember: { user: { displayName: "Owner" } },
        keyResults: [
          {
            title: "Ship the rollout",
            currentValue: 1,
            targetValue: 4,
            unit: "milestones",
            progressPercent: 25,
          },
        ],
      },
    ]);
  });

  it("queries goals through the actor-aware domain list", async () => {
    const { queryGoals } = await import("./workspace");

    const result = await queryGoals(actor, "ws-1", "QUARTERLY", "COMPANY", "ACTIVE");

    expect(listGoalsMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      take: 20,
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "goal-1",
        title: "Launch goal",
        owner: "Owner",
        keyResults: [
          expect.objectContaining({
            title: "Ship the rollout",
            progressPercent: 25,
          }),
        ],
      }),
    ]);
  });
});

describe("agent query tools version requirements", () => {
  it("documents the version handoff to update tools", async () => {
    const { queryTensionsTool, queryActionsTool } = await import("./workspace");
    expect(queryTensionsTool.function.description).toContain("update_tension");
    expect(queryActionsTool.function.description).toContain("update_action");
  });

  it("exposes exact-ID filters", async () => {
    const { queryTensionsTool, queryActionsTool } = await import("./workspace");
    expect((queryTensionsTool.function.parameters.properties as any).tensionId).toBeDefined();
    expect((queryActionsTool.function.parameters.properties as any).actionId).toBeDefined();
  });

  it("returns versions from exact-ID reads without broadening anonymous privacy", async () => {
    const { queryTensions, queryActions } = await import("./workspace");
    findManyTensionsMock.mockResolvedValueOnce([
      { id: "t-99", version: 4, title: "Tension", status: "OPEN", priority: "HIGH", author: { displayName: "Author" } },
    ]);
    findManyActionsMock.mockResolvedValueOnce([
      { id: "a-99", version: 5, title: "Action", status: "OPEN", author: { displayName: "Author" } },
    ]);
    expect((await queryTensions("ws-1", undefined, undefined, "t-99"))[0]).toMatchObject({ id: "t-99", version: 4 });
    expect((await queryActions("ws-1", undefined, undefined, "a-99"))[0]).toMatchObject({ id: "a-99", version: 5 });
    expect(findManyTensionsMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "t-99", isPrivate: false }),
    }));
    expect(findManyActionsMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "a-99", isPrivate: false }),
    }));
  });

  it("uses canonical member and admin privacy filters for exact-ID reads", async () => {
    const { queryTensions, queryActions } = await import("./workspace");
    const { requireWorkspaceMembership } = await import("@corgtex/domain");
    const member = { kind: "user", user: { id: "u-1", email: "test@example.com", displayName: "Test", globalRole: "USER" } } as AppActor;
    const memberPrivacy = { OR: [
      { isPrivate: false }, { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
    ] };
    findManyTensionsMock.mockResolvedValue([]);
    findManyActionsMock.mockResolvedValue([]);
    await queryTensions("ws-1", undefined, undefined, "t-99", member);
    await queryActions("ws-1", undefined, undefined, "a-99", member);
    expect(findManyTensionsMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "t-99", ...memberPrivacy }),
    }));
    expect(findManyActionsMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "a-99", ...memberPrivacy }),
    }));

    const admin = { id: "m-1", workspaceId: "ws-1", userId: "u-1", role: "ADMIN", isActive: true } as const;
    vi.mocked(requireWorkspaceMembership).mockResolvedValue(admin);
    await queryTensions("ws-1", undefined, undefined, "t-99");
    await queryTensions("ws-1", undefined, undefined, "t-99", member);
    expect(findManyTensionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "t-99", OR: expect.arrayContaining([{ isPrivate: true, status: "DRAFT" }]) }) })
    );
  });
});
