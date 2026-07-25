import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  addKeyResult,
  createGoal,
  createGoalFinanceProjectLink,
  createGoalLink,
  deleteGoal,
  deleteGoalFinanceProjectLink,
  getGoal,
  getMyGoalSlice,
  listGoalFinanceProjectLinks,
  listCompanyDirectionFromBrain,
  postGoalUpdate,
  recomputeGoalProgress,
  returnGoalToDraft,
  updateGoal,
} from "./goals";
import { prisma } from "@corgtex/shared";

vi.mock("@corgtex/shared", () => ({
  prisma: {
    goal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    circle: {
      findUnique: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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
      delete: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    practiceProject: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    brainSource: {
      findMany: vi.fn(),
    },
    brainArticle: {
      findMany: vi.fn(),
    },
    checkIn: {
      findMany: vi.fn(),
    },
    workItemVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn((fn) => fn(prisma)),
  },
  AppActor: {},
}));

vi.mock("./auth", () => ({
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("user-1"),
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

  beforeEach(async () => {
    vi.clearAllMocks();
    const { actorUserIdForWorkspace, requireWorkspaceMembership } = await import("./auth");
    vi.mocked(actorUserIdForWorkspace).mockReset();
    vi.mocked(actorUserIdForWorkspace).mockResolvedValue("user-1");
    vi.mocked(requireWorkspaceMembership).mockReset();
    vi.mocked(requireWorkspaceMembership).mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    } as any);
    vi.mocked(prisma.goal.create).mockReset();
    vi.mocked(prisma.goal.findUnique).mockReset();
    vi.mocked(prisma.goal.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.goal.findFirst).mockReset();
    vi.mocked(prisma.goal.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.goal.findMany).mockReset();
    vi.mocked(prisma.goal.findMany).mockResolvedValue([]);
    vi.mocked(prisma.goal.update).mockReset();
    vi.mocked(prisma.keyResult.create).mockReset();
    vi.mocked(prisma.keyResult.createMany).mockReset();
    vi.mocked(prisma.keyResult.findMany).mockReset();
    vi.mocked(prisma.keyResult.findMany).mockResolvedValue([]);
    vi.mocked(prisma.keyResult.findUnique).mockReset();
    vi.mocked(prisma.keyResult.update).mockReset();
    vi.mocked(prisma.keyResult.delete).mockReset();
    vi.mocked(prisma.goalUpdate.create).mockReset();
    vi.mocked(prisma.goalLink.delete).mockReset();
    vi.mocked(prisma.goalLink.findUnique).mockReset();
    vi.mocked(prisma.goalLink.findMany).mockReset();
    vi.mocked(prisma.goalLink.findMany).mockResolvedValue([]);
    vi.mocked(prisma.goalLink.upsert).mockReset();
    vi.mocked(prisma.practiceProject.findFirst).mockReset();
    vi.mocked(prisma.practiceProject.findMany).mockReset();
    vi.mocked(prisma.practiceProject.findMany).mockResolvedValue([]);
    vi.mocked(prisma.brainSource.findMany).mockReset();
    vi.mocked(prisma.brainSource.findMany).mockResolvedValue([]);
    vi.mocked(prisma.brainArticle.findMany).mockReset();
    vi.mocked(prisma.brainArticle.findMany).mockResolvedValue([]);
    vi.mocked(prisma.checkIn.findMany).mockReset();
    vi.mocked(prisma.checkIn.findMany).mockResolvedValue([]);
    vi.mocked((prisma as any).$executeRaw).mockResolvedValue({});
    vi.mocked((prisma as any).$queryRaw).mockResolvedValue([]);
    vi.mocked((prisma as any).workItemVersion.create).mockResolvedValue({});
    vi.mocked((prisma as any).workItemVersion.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "member-1",
      userId: "user-1",
    } as any);
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
            authorUserId: "user-1",
            title: "Test Goal",
            level: "COMPANY",
            status: "DRAFT",
            isPrivate: true,
            publishedAt: null,
          }),
        })
      );
    });

    it("does not emit context graph events for private draft goals", async () => {
      const { appendEvents } = await import("./events");
      vi.mocked(prisma.goal.create).mockResolvedValueOnce({
        id: "goal-private",
        workspaceId: "ws-1",
        title: "Private goal draft",
        isPrivate: true,
        status: "DRAFT",
      } as any);

      await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Private goal draft",
      });

      expect(appendEvents).not.toHaveBeenCalled();
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

    it("adds missing key results when updating an existing duplicate goal", async () => {
      const existingGoal = {
        id: "goal-existing",
        workspaceId: "ws-1",
        title: "Grow revenue",
        descriptionMd: null,
        level: "COMPANY",
        cadence: "QUARTERLY",
        status: "DRAFT",
        authorUserId: "user-1",
        isPrivate: true,
        ownerMemberId: "member-1",
        circleId: null,
        parentGoalId: null,
        targetDate: null,
        startDate: null,
        progressPercent: 40,
        version: 1,
        archivedAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        updatedAt: new Date("2026-07-20T10:05:00.000Z"),
        keyResults: [
          { title: "Close 5 customers", progressPercent: 40, sortOrder: 0 },
        ],
      };
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([existingGoal] as any);
      vi.mocked(prisma.goal.findFirst)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce({
          ...existingGoal,
          cadence: "ANNUAL",
          level: "PERSONAL",
          status: "ACTIVE",
          isPrivate: false,
          progressPercent: 20,
          version: 3,
          keyResults: [
            { title: "Close 5 customers", progressPercent: 40, sortOrder: 0 },
            { title: "Launch partner motion", progressPercent: 0, sortOrder: 1 },
          ],
        } as any);
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce(existingGoal as any);
      vi.mocked(prisma.keyResult.findMany).mockResolvedValueOnce([
        { title: "Close 5 customers", progressPercent: 40, sortOrder: 0 },
      ] as any);
      vi.mocked(prisma.keyResult.createMany).mockResolvedValueOnce({ count: 1 } as any);
      vi.mocked(prisma.goal.update)
        .mockResolvedValueOnce({
          ...existingGoal,
          cadence: "ANNUAL",
          level: "PERSONAL",
          status: "ACTIVE",
          version: 2,
        } as any)
        .mockResolvedValueOnce({
          ...existingGoal,
          cadence: "ANNUAL",
          level: "PERSONAL",
          status: "ACTIVE",
          progressPercent: 20,
          version: 3,
        } as any);

      const result = await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Grow revenue",
        cadence: "ANNUAL",
        level: "PERSONAL",
        status: "ACTIVE",
        keyResults: [
          { title: "Close 5 customers", currentValue: 2, targetValue: 5 },
          { title: "Launch partner motion", currentValue: 0, targetValue: 1 },
        ],
        duplicateGuard: {
          resolution: "update_existing",
          targetEntityId: "goal-existing",
        },
      });

      expect(prisma.keyResult.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({
          goalId: "goal-existing",
          title: "Launch partner motion",
          sortOrder: 1,
        })],
      });
      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: { id: "goal-existing" },
        data: expect.objectContaining({
          cadence: "ANNUAL",
          level: "PERSONAL",
          status: "ACTIVE",
          isPrivate: false,
        }),
      });
      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: { id: "goal-existing" },
        data: { progressPercent: 20 },
      });
      expect(result).toMatchObject({
        id: "goal-existing",
        cadence: "ANNUAL",
        level: "PERSONAL",
        status: "ACTIVE",
        progressPercent: 20,
      });
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

    it("rejects system identities as goal owners", async () => {
      vi.mocked(prisma.member.findFirst).mockResolvedValueOnce(null);

      await expect(createGoal(actor, {
        workspaceId: "ws-1",
        title: "Human-owned Goal",
        ownerMemberId: "system-member",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(prisma.member.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "system-member",
          NOT: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ kind: "SYSTEM" }),
              ]),
            }),
          ]),
        }),
      }));
      expect(prisma.goal.create).not.toHaveBeenCalled();
    });
  });

  describe("createGoalLink", () => {
    it("stores evidence confidence and generated source metadata", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
      } as any);
      vi.mocked(prisma.goalLink.upsert).mockResolvedValueOnce({
        id: "link-1",
        goalId: "goal-1",
        entityType: "BrainSource",
        entityId: "source-1",
        confidence: 0.86,
        linkedBy: "agent",
        source: "company-understanding",
      } as any);

      const result = await createGoalLink(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        entityType: "BrainSource",
        entityId: "source-1",
        confidence: 0.86,
        linkedBy: "agent",
        source: "company-understanding",
        metadata: { snippet: "Expand customer onboarding" },
      });

      expect(result.id).toBe("link-1");
      expect(prisma.goalLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          goalId: "goal-1",
          entityType: "BrainSource",
          entityId: "source-1",
          confidence: 0.86,
          linkedBy: "agent",
          source: "company-understanding",
          metadata: { snippet: "Expand customer onboarding" },
        }),
        update: expect.objectContaining({
          confidence: 0.86,
          linkedBy: "agent",
          source: "company-understanding",
          metadata: { snippet: "Expand customer onboarding" },
        }),
      }));
    });
  });

  describe("goal privacy reads and archive", () => {
    it("filters private child goals from focused goal reads", async () => {
      vi.mocked(prisma.goal.findFirst).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Visible goal",
        childGoals: [],
      } as any);

      await getGoal(actor, { workspaceId: "ws-1", goalId: "goal-1" });

      expect(prisma.goal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "goal-1",
          workspaceId: "ws-1",
          OR: expect.arrayContaining([
            { isPrivate: false },
            { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
          ]),
        }),
        include: expect.objectContaining({
          childGoals: expect.objectContaining({
            where: expect.objectContaining({
              archivedAt: null,
              OR: expect.arrayContaining([
                { isPrivate: false },
                { isPrivate: true, status: "DRAFT", authorUserId: "user-1" },
              ]),
            }),
          }),
        }),
      }));
    });

    it("omits invisible private parents from the personal goal slice", async () => {
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([
        {
          id: "goal-child",
          workspaceId: "ws-1",
          title: "Visible child",
          parentGoal: {
            id: "goal-private-parent",
            title: "Private parent",
            isPrivate: true,
            status: "DRAFT",
            authorUserId: "other-user",
            parentGoal: null,
          },
        },
      ] as any);

      await expect(getMyGoalSlice(actor, "member-1", "ws-1")).resolves.toEqual([
        expect.objectContaining({
          id: "goal-child",
          parentGoal: null,
        }),
      ]);
    });

    it("blocks non-authors from archiving another member's private draft goal", async () => {
      vi.mocked(prisma.goal.findFirst).mockResolvedValueOnce({
        id: "goal-private",
        workspaceId: "ws-1",
        status: "DRAFT",
        isPrivate: true,
        authorUserId: "other-user",
        archivedAt: null,
      } as any);

      await expect(deleteGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-private",
      })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("createGoalFinanceProjectLink", () => {
    it("creates a goal link to an existing same-workspace practice project", async () => {
      vi.mocked(prisma.practiceProject.findFirst).mockResolvedValueOnce({
        id: "project-1",
      } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
      } as any);
      vi.mocked(prisma.goalLink.upsert).mockResolvedValueOnce({
        id: "link-1",
        goalId: "goal-1",
        entityType: "PracticeProject",
        entityId: "project-1",
        confidence: 1,
        linkedBy: "human",
        source: "practice-finance",
      } as any);

      await expect(createGoalFinanceProjectLink(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        projectId: "project-1",
      })).resolves.toMatchObject({
        id: "link-1",
        entityType: "PracticeProject",
        entityId: "project-1",
      });

      expect(prisma.practiceProject.findFirst).toHaveBeenCalledWith({
        where: {
          id: "project-1",
          workspaceId: "ws-1",
        },
        select: { id: true },
      });
      expect(prisma.goalLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          entityType: "PracticeProject",
          entityId: "project-1",
          linkedBy: "human",
          source: "practice-finance",
        }),
      }));
    });

    it("rejects practice projects outside the workspace", async () => {
      vi.mocked(prisma.practiceProject.findFirst).mockResolvedValueOnce(null);

      await expect(createGoalFinanceProjectLink(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        projectId: "project-other",
      })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(prisma.goalLink.upsert).not.toHaveBeenCalled();
    });
  });

  describe("listGoalFinanceProjectLinks", () => {
    it("resolves same-workspace practice project evidence and derives budget fields", async () => {
      const createdAt = new Date("2026-07-11T09:00:00.000Z");
      vi.mocked(prisma.goalLink.findMany).mockResolvedValueOnce([
        {
          id: "link-1",
          goalId: "goal-1",
          entityId: "project-1",
          confidence: 1,
          source: "practice-finance",
          createdAt,
        },
        {
          id: "link-unresolved",
          goalId: "goal-1",
          entityId: "project-other",
          confidence: 1,
          source: "practice-finance",
          createdAt,
        },
      ] as any);
      vi.mocked(prisma.practiceProject.findMany).mockResolvedValueOnce([
        {
          id: "project-1",
          code: "DEMO-Q3",
          name: "Demo Q3 enablement",
          clientName: "Demo Client",
          clientId: "client-1",
          status: "ACTIVE",
          currency: "USD",
          poValueCents: 1000000,
          serviceBudgetCents: 600000,
          expenseBudgetCents: 100000,
          usedCents: 250000,
          weeklyBurnCents: 50000,
          targetMarginBps: 3000,
          currentMarginBps: 2500,
          sourceSatelliteId: null,
        },
      ] as any);

      const result = await listGoalFinanceProjectLinks(actor, {
        workspaceId: "ws-1",
        goalIds: ["goal-1", "goal-1", " "],
      });

      expect(prisma.goalLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          goalId: { in: ["goal-1"] },
          entityType: "PracticeProject",
          goal: expect.objectContaining({
            workspaceId: "ws-1",
            archivedAt: null,
          }),
        }),
      }));
      expect(prisma.practiceProject.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          id: { in: ["project-1", "project-other"] },
        },
      }));
      expect(result).toEqual([
        expect.objectContaining({
          id: "link-1",
          goalId: "goal-1",
          entityId: "project-1",
          project: expect.objectContaining({
            id: "project-1",
            remainingCents: 750000,
            usedRatio: 0.25,
            budgetRunwayWeeks: 15,
          }),
        }),
      ]);
    });

    it("uses native practice ledger health for linked finance projects", async () => {
      const createdAt = new Date("2026-07-11T09:00:00.000Z");
      vi.mocked(prisma.goalLink.findMany).mockResolvedValueOnce([
        {
          id: "link-1",
          goalId: "goal-1",
          entityId: "project-1",
          confidence: 1,
          source: "practice-finance",
          createdAt,
        },
      ] as any);
      vi.mocked(prisma.practiceProject.findMany).mockResolvedValueOnce([
        {
          id: "project-1",
          code: "DEMO-Q3",
          name: "Demo Q3 enablement",
          clientName: "Demo Client",
          clientId: "client-1",
          status: "ACTIVE",
          currency: "USD",
          poValueCents: 1000000,
          serviceBudgetCents: 600000,
          expenseBudgetCents: 100000,
          usedCents: 250000,
          weeklyBurnCents: 50000,
          targetMarginBps: 3000,
          currentMarginBps: 6000,
          sourceSatelliteId: null,
        },
      ] as any);
      vi.mocked((prisma as any).$queryRaw)
        .mockResolvedValueOnce([{
          projectId: "project-1",
          timeRevenueCents: 150000n,
          timeCostCents: 80000n,
          recentTimeRevenueCents: 150000n,
          recentTimeCostCents: 80000n,
          invalidHoursRows: 0n,
          invalidCurrencyRows: 0n,
          timeEntryCount: 1n,
        }])
        .mockResolvedValueOnce([{
          projectId: "project-1",
          billableExpenseCents: 40000n,
          directExpenseCents: 40000n,
          recentBillableExpenseCents: 40000n,
          recentDirectExpenseCents: 40000n,
          invalidCurrencyRows: 0n,
          expenseCount: 1n,
        }]);

      const result = await listGoalFinanceProjectLinks(actor, {
        workspaceId: "ws-1",
        goalIds: ["goal-1"],
      });

      expect(result[0]?.project).toMatchObject({
        id: "project-1",
        usedCents: 440000,
        remainingCents: 560000,
        weeklyBurnCents: 97500,
        usedRatio: 0.44,
        currentMarginBps: 5000,
      });
      expect(result[0]?.project.budgetRunwayWeeks).toBeCloseTo(5.744, 3);
    });

    it("short-circuits when no goal ids are provided", async () => {
      await expect(listGoalFinanceProjectLinks(actor, {
        workspaceId: "ws-1",
        goalIds: [" "],
      })).resolves.toEqual([]);

      expect(prisma.goalLink.findMany).not.toHaveBeenCalled();
      expect(prisma.practiceProject.findMany).not.toHaveBeenCalled();
      expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("deleteGoalFinanceProjectLink", () => {
    it("deletes only practice-project goal links in the workspace", async () => {
      vi.mocked(prisma.goalLink.findUnique).mockResolvedValueOnce({
        id: "link-1",
        entityType: "PracticeProject",
        goal: {
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "user-1",
          isPrivate: false,
          status: "ACTIVE",
        },
      } as any);
      vi.mocked(prisma.goalLink.delete).mockResolvedValueOnce({ id: "link-1" } as any);

      await deleteGoalFinanceProjectLink(actor, {
        workspaceId: "ws-1",
        linkId: "link-1",
      });

      expect(prisma.goalLink.delete).toHaveBeenCalledWith({ where: { id: "link-1" } });
    });

    it("rejects non-finance goal links", async () => {
      vi.mocked(prisma.goalLink.findUnique).mockResolvedValueOnce({
        id: "link-1",
        entityType: "BrainSource",
        goal: {
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "user-1",
          isPrivate: false,
          status: "ACTIVE",
        },
      } as any);

      await expect(deleteGoalFinanceProjectLink(actor, {
        workspaceId: "ws-1",
        linkId: "link-1",
      })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(prisma.goalLink.delete).not.toHaveBeenCalled();
    });
  });

  describe("listCompanyDirectionFromBrain", () => {
    it("groups Brain-generated goals by horizon and resolves evidence labels", async () => {
      const now = new Date("2026-06-09T12:00:00.000Z");
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([
        {
          id: "goal-decision",
          title: "Pick the onboarding owner",
          descriptionMd: "A short-term decision from the uploaded plan.",
          cadence: "QUARTERLY",
          status: "ACTIVE",
          updatedAt: now,
          links: [
            {
              id: "link-source",
              entityType: "BrainSource",
              entityId: "source-1",
              confidence: 0.88,
              metadata: { quote: "Operations needs one accountable owner." },
            },
          ],
        },
        {
          id: "goal-strategy",
          title: "Build the managed-client strategy",
          descriptionMd: "A long-term direction from the strategy article.",
          cadence: "ANNUAL",
          status: "DRAFT",
          updatedAt: now,
          links: [
            {
              id: "link-article",
              entityType: "BrainArticle",
              entityId: "article-1",
              confidence: 0.72,
              metadata: { label: "Strategy article" },
            },
          ],
        },
      ] as any);
      vi.mocked(prisma.checkIn.findMany).mockResolvedValueOnce([
        {
          id: "checkin-1",
          questionText: "Which document names the onboarding owner?",
          priority: 5,
          confidence: 0.61,
          metadata: { reason: "Missing owner evidence" },
          responseUsePolicy: "COMPANY_KNOWLEDGE",
          relatedEntityType: "BrainSource",
          relatedEntityId: "source-1",
          createdAt: now,
        },
      ] as any);
      vi.mocked(prisma.brainSource.findMany).mockResolvedValueOnce([
        {
          id: "source-1",
          sourceType: "DOC",
          title: "Q3 onboarding plan",
          fileName: null,
          channel: null,
          createdAt: now,
        },
      ] as any);
      vi.mocked(prisma.brainArticle.findMany).mockResolvedValueOnce([
        {
          id: "article-1",
          slug: "managed-client-strategy",
          title: "Managed client strategy",
          type: "STRATEGY",
          authority: "DRAFT",
        },
      ] as any);

      const result = await listCompanyDirectionFromBrain(actor, { workspaceId: "ws-1" });

      expect(result.decisionsNow).toHaveLength(1);
      expect(result.decisionsNow[0]).toMatchObject({
        id: "goal-decision",
        confidence: 0.88,
        evidenceLinks: [
          expect.objectContaining({
            label: "Q3 onboarding plan",
            quote: "Operations needs one accountable owner.",
          }),
        ],
      });
      expect(result.strategyLater).toHaveLength(1);
      expect(result.strategyLater[0]).toMatchObject({
        id: "goal-strategy",
        confidence: 0.72,
        evidenceLinks: [
          expect.objectContaining({
            label: "Strategy article",
            articleSlug: "managed-client-strategy",
          }),
        ],
      });
      expect(result.openQuestions[0]).toMatchObject({
        questionText: "Which document names the onboarding owner?",
        responseUsePolicy: "COMPANY_KNOWLEDGE",
        relatedEvidence: expect.objectContaining({
          label: "Q3 onboarding plan",
        }),
      });
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
        parentGoalId: null,
        ownerMemberId: "member-1",
        status: "ACTIVE",
        isPrivate: false,
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
        data: expect.objectContaining({ status: "ON_TRACK", progressPercent: 65, isPrivate: false }),
      }));
    });

    it("returns an active goal to a private draft for the author", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        parentGoalId: null,
        ownerMemberId: "member-1",
        status: "ACTIVE",
        isPrivate: false,
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        status: "DRAFT",
      } as any);

      await expect(returnGoalToDraft(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
      })).resolves.toMatchObject({
        id: "goal-1",
        status: "DRAFT",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "goal-1" },
        data: { status: "DRAFT", isPrivate: true, publishedAt: null },
      }));
    });

    it("allows active members to edit public active goal content and snapshots the previous version", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "other-user",
        isPrivate: false,
        title: "Old goal",
        descriptionMd: "Old description",
        level: "COMPANY",
        cadence: "QUARTERLY",
        targetDate: null,
        startDate: null,
        parentGoalId: null,
        circleId: null,
        ownerMemberId: "member-1",
        status: "ACTIVE",
        progressPercent: 0,
        version: 1,
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Updated goal",
        status: "ACTIVE",
        version: 2,
      } as any);

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        title: "Updated goal",
      })).resolves.toMatchObject({
        id: "goal-1",
        version: 2,
      });

      expect((prisma as any).workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          entityType: "Goal",
          entityId: "goal-1",
          version: 1,
          changedFields: ["title"],
        }),
      }));
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "goal-1" },
        data: { title: "Updated goal", version: 2 },
      }));
    });

    it("allows active members to post progress updates to public active goals", async () => {
      const { requireWorkspaceMembership } = await import("./auth");
      vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
        id: "member-2",
        workspaceId: "ws-1",
        userId: "user-2",
        role: "MEMBER",
        isActive: true,
      } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
        parentGoalId: null,
      } as any);
      vi.mocked(prisma.goalUpdate.create).mockResolvedValueOnce({
        id: "update-1",
        goalId: "goal-1",
        bodyMd: "Progress update",
        newProgress: 55,
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
        progressPercent: 55,
      } as any);

      await expect(postGoalUpdate({
        kind: "user",
        user: { id: "user-2", email: "other@example.com", displayName: "Other" },
      } as any, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: " Progress update ",
        newProgress: 55,
      })).resolves.toMatchObject({
        id: "update-1",
      });

      expect(prisma.goalUpdate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          goalId: "goal-1",
          bodyMd: "Progress update",
          authorMemberId: "member-2",
          newProgress: 55,
        }),
      });
      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: { id: "goal-1" },
        data: { progressPercent: 55 },
      });
    });

    it("blocks collaborators from turning another author's active goal back into a draft through progress updates", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Active goal",
        status: "ACTIVE",
        isPrivate: false,
        authorUserId: "other-user",
        archivedAt: null,
      } as any);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: "Return to draft",
        statusChange: "DRAFT",
      })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
      expect(prisma.goal.update).not.toHaveBeenCalled();
    });

    it("returns an authored active goal to a private draft through progress updates", async () => {
      const { appendEvents } = await import("./events");
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        title: "Active goal",
        status: "ACTIVE",
        isPrivate: false,
        authorUserId: "user-1",
        publishedAt: new Date("2026-07-01T10:00:00.000Z"),
        archivedAt: null,
      } as any);
      vi.mocked(prisma.goalUpdate.create).mockResolvedValueOnce({
        id: "goal-update-1",
        goalId: "goal-1",
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
      } as any);

      await postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: "Return to draft",
        statusChange: "DRAFT",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: { id: "goal-1" },
        data: expect.objectContaining({
          status: "DRAFT",
          isPrivate: true,
          publishedAt: null,
        }),
      });
      expect(appendEvents).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({
          type: "goal.updated",
          payload: expect.objectContaining({
            goalId: "goal-1",
            fields: expect.arrayContaining(["status", "isPrivate", "publishedAt"]),
          }),
        }),
      ]);
    });

    it("rejects progress updates for completed goals", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "COMPLETED",
        parentGoalId: null,
      } as any);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: "Closed goal update",
        newProgress: 100,
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_STATE",
      });

      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
      expect(prisma.goal.update).not.toHaveBeenCalled();
    });

    it("rejects reassignment to a system identity", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        title: "Draft goal",
        descriptionMd: null,
        level: "COMPANY",
        cadence: "QUARTERLY",
        targetDate: null,
        startDate: null,
        parentGoalId: null,
        circleId: null,
        ownerMemberId: "member-1",
        status: "DRAFT",
        authorUserId: "user-1",
        isPrivate: true,
        progressPercent: 0,
        version: 1,
      } as any);
      vi.mocked(prisma.member.findFirst).mockResolvedValueOnce(null);

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        ownerMemberId: "system-member",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(prisma.goal.update).not.toHaveBeenCalled();
    });
  });

  describe("getMyGoalSlice", () => {
    it("returns only active owned goals ordered by target date", async () => {
      const activeGoal = {
        id: "goal-active",
        workspaceId: "ws-1",
        ownerMemberId: "member-1",
        status: "ACTIVE",
        archivedAt: null,
      };
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([activeGoal] as any);

      await expect(getMyGoalSlice(actor, "member-1", "ws-1")).resolves.toEqual([activeGoal]);

      expect(prisma.goal.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          ownerMemberId: "member-1",
          archivedAt: null,
          status: { in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] },
        }),
        orderBy: [
          { targetDate: "asc" },
          { updatedAt: "desc" },
        ],
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
