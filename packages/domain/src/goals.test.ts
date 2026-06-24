import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  addKeyResult,
  createGoal,
  createGoalLink,
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
      findMany: vi.fn(),
      upsert: vi.fn(),
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
