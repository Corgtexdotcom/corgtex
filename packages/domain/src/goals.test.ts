import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  addKeyResult,
  createGoal,
  createGoalFinanceProjectLink,
  createGoalLink,
  deleteGoalFinanceProjectLink,
  getMyGoalSlice,
  listGoalFinanceProjectLinks,
  listCompanyDirectionFromBrain,
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
    vi.mocked((prisma as any).$executeRaw).mockResolvedValue({});
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
            title: "Test Goal",
            level: "COMPANY",
            status: "DRAFT",
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

  describe("createGoalFinanceProjectLink", () => {
    it("creates a goal link to an existing same-workspace practice project", async () => {
      vi.mocked(prisma.practiceProject.findFirst).mockResolvedValueOnce({
        id: "project-1",
      } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
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
          status: "ACTIVE",
          poValueCents: 1000000,
          serviceBudgetCents: 600000,
          expenseBudgetCents: 100000,
          usedCents: 250000,
          weeklyBurnCents: 50000,
          targetMarginBps: 3000,
          currentMarginBps: 2500,
        },
      ] as any);

      const result = await listGoalFinanceProjectLinks(actor, {
        workspaceId: "ws-1",
        goalIds: ["goal-1", "goal-1", " "],
      });

      expect(prisma.goalLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          goalId: { in: ["goal-1"] },
          entityType: "PracticeProject",
          goal: {
            workspaceId: "ws-1",
            archivedAt: null,
          },
        },
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

    it("short-circuits when no goal ids are provided", async () => {
      await expect(listGoalFinanceProjectLinks(actor, {
        workspaceId: "ws-1",
        goalIds: [" "],
      })).resolves.toEqual([]);

      expect(prisma.goalLink.findMany).not.toHaveBeenCalled();
      expect(prisma.practiceProject.findMany).not.toHaveBeenCalled();
    });
  });

  describe("deleteGoalFinanceProjectLink", () => {
    it("deletes only practice-project goal links in the workspace", async () => {
      vi.mocked(prisma.goalLink.findUnique).mockResolvedValueOnce({
        id: "link-1",
        entityType: "PracticeProject",
        goal: { workspaceId: "ws-1" },
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
        goal: { workspaceId: "ws-1" },
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

    it("returns an active goal to draft for the owner", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        parentGoalId: null,
        ownerMemberId: "member-1",
        status: "ACTIVE",
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
        data: { status: "DRAFT" },
      }));
    });

    it("allows the owner to edit active goal content and snapshots the previous version", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
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
        where: {
          workspaceId: "ws-1",
          ownerMemberId: "member-1",
          archivedAt: null,
          status: { in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] },
        },
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
