import { describe, expect, it, vi, beforeEach } from "vitest";
import { addKeyResult, createGoal, recomputeGoalProgress, updateGoal } from "./goals";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    goal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    circle: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
    },
    keyResult: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    goalUpdate: {
      create: vi.fn(),
    },
    goalLink: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
  AppActor: {},
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({
    id: "member-1",
    workspaceId: "ws-1",
    userId: "user-1",
    role: "MEMBER",
    isActive: true,
  }),
}));

vi.mock("./events", () => ({
  appendEvents: vi.fn().mockResolvedValue(true),
}));

vi.mock("./audit-trail", () => ({
  recordAudit: vi.fn().mockResolvedValue(true),
}));

describe("Goals Domain", () => {
  const actor = {
    kind: "user",
    user: { id: "user-1", email: "user@example.com", displayName: "User" },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createGoal", () => {
    it("creates a goal successfully", async () => {
      vi.mocked(prisma.goal.create).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Test Goal",
      } as any);

      const result = await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Test Goal",
        level: "COMPANY",
      });

      expect(result.id).toBe("goal-1");
      expect(prisma.goal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Test Goal",
            level: "COMPANY",
            status: "ACTIVE",
          }),
        })
      );
    });

    it("creates key results and derives initial progress", async () => {
      vi.mocked(prisma.goal.create).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Revenue Goal",
      } as any);
      vi.mocked(prisma.keyResult.createMany).mockResolvedValueOnce({ count: 2 } as any);

      await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Revenue Goal",
        keyResults: [
          { title: "Close 5 customers", currentValue: 2, targetValue: 5, unit: "customers" },
          { title: "Reach $100k ARR", currentValue: 100000, targetValue: 100000, unit: "USD" },
        ],
      });

      expect(prisma.goal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            progressPercent: 70,
          }),
        }),
      );
      expect(prisma.keyResult.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ goalId: "goal-1", title: "Close 5 customers", progressPercent: 40 }),
            expect.objectContaining({ goalId: "goal-1", title: "Reach $100k ARR", progressPercent: 100 }),
          ]),
        }),
      );
    });

    it("rejects parent goals from another workspace", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "parent-goal",
        workspaceId: "ws-other",
        archivedAt: null,
      } as any);

      await expect(createGoal(actor, {
        workspaceId: "ws-1",
        title: "Child Goal",
        parentGoalId: "parent-goal",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(prisma.goal.create).not.toHaveBeenCalled();
    });

    it("rejects archived parent goals", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "parent-goal",
        workspaceId: "ws-1",
        archivedAt: new Date(),
      } as any);

      await expect(createGoal(actor, {
        workspaceId: "ws-1",
        title: "Child Goal",
        parentGoalId: "parent-goal",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(prisma.goal.create).not.toHaveBeenCalled();
    });
  });

  describe("updateGoal", () => {
    it("rejects using itself as the parent goal", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
      } as any);

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        parentGoalId: "goal-1",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(prisma.goal.update).not.toHaveBeenCalled();
    });

    it("updates status and progress for an active goal", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        status: "ON_TRACK",
        progressPercent: 65,
      } as any);

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        status: "ON_TRACK",
        progressPercent: 65,
      })).resolves.toMatchObject({
        id: "goal-1",
        status: "ON_TRACK",
        progressPercent: 65,
      });

      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "goal-1" },
        data: { status: "ON_TRACK", progressPercent: 65 },
      }));
    });
  });

  describe("addKeyResult", () => {
    it("rejects key results for archived goals", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: new Date(),
      } as any);

      await expect(addKeyResult(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        title: "Archived key result",
      })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(prisma.keyResult.create).not.toHaveBeenCalled();
    });
  });

  describe("recomputeGoalProgress", () => {
    it("computes average KR progress and optionally updates parent goal", async () => {
      // Mock the initial target goal find
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "child-goal",
        parentGoalId: "parent-goal",
        progressPercent: 0,
        keyResults: [
          { progressPercent: 50 },
          { progressPercent: 100 },
        ],
        childGoals: [],
      } as any);

      // Mock goal update response
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "child-goal",
        progressPercent: 75,
      } as any);

      // Recomputing child goal should then trigger a recomputation on parent goal
      // For recursive call on parent goal:
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "parent-goal",
        parentGoalId: null,
        progressPercent: 0,
        keyResults: [],
        childGoals: [{ progressPercent: 75, id: "child-goal" }],
      } as any);

      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "parent-goal",
        progressPercent: 75,
      } as any);

      await recomputeGoalProgress("child-goal");

      expect(prisma.goal.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: { id: "child-goal" },
        data: { progressPercent: 75 },
      }));

      // Recursive call for parent goal
      expect(prisma.goal.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: { id: "parent-goal" },
        data: { progressPercent: 75 },
      }));
    });
  });
});
