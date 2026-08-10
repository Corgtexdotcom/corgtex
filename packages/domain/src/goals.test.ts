import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  addKeyResult,
  createGoal,
  createGoalLink,
  deleteGoal,
  getGoal,
  getMyGoalSlice,
  listCompanyDirectionFromBrain,
  postGoalUpdate,
  recomputeGoalProgress,
  returnGoalToDraft,
  updateKeyResult,
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
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    goalLink: {
      delete: vi.fn(),
      findUnique: vi.fn(),
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

    it("defaults status-less agent-created goals to visible active goals", async () => {
      const agentActor = { kind: "agent", authProvider: "bootstrap" } as any;
      vi.mocked(prisma.goal.create).mockResolvedValueOnce({
        id: "goal-agent",
        workspaceId: "ws-1",
        title: "Agent Goal",
      } as any);

      await createGoal(agentActor, {
        workspaceId: "ws-1",
        title: "Agent Goal",
      });

      expect(prisma.goal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authorUserId: "user-1",
            title: "Agent Goal",
            status: "ACTIVE",
            isPrivate: false,
            publishedAt: expect.any(Date),
          }),
        }),
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

    it("omits private draft goal titles from workspace audit metadata", async () => {
      const { recordAudit } = await import("./audit-trail");
      vi.mocked(prisma.goal.create).mockResolvedValueOnce({
        id: "goal-private",
        workspaceId: "ws-1",
        title: "Private acquisition target",
        isPrivate: true,
        status: "DRAFT",
      } as any);

      await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Private acquisition target",
      });

      expect(recordAudit).toHaveBeenCalledWith(expect.anything(), actor, expect.objectContaining({
        action: "goal.created",
        entityId: "goal-private",
        meta: { isPrivate: true },
      }));
      expect(vi.mocked(recordAudit).mock.calls[0]?.[2].meta).not.toHaveProperty("title");
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
          id: "goal-existing",
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
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "goal-existing",
          workspaceId: "ws-1",
          status: "DRAFT",
          isPrivate: true,
          version: 1,
        }),
        data: expect.objectContaining({
          cadence: "ANNUAL",
          level: "PERSONAL",
          status: "ACTIVE",
          isPrivate: false,
        }),
      }));
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: "goal-existing" }),
        data: expect.objectContaining({ progressPercent: 20 }),
      }));
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

    it("rejects reparenting to a private draft parent the actor cannot see", async () => {
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce({
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "user-1",
          parentGoalId: null,
          ownerMemberId: "member-1",
          status: "ACTIVE",
          isPrivate: false,
        } as any)
        .mockResolvedValueOnce({
          id: "private-parent",
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "user-2",
          status: "DRAFT",
          isPrivate: true,
        } as any);

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        parentGoalId: "private-parent",
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
        where: expect.objectContaining({ id: "goal-1", workspaceId: "ws-1", status: "ACTIVE", isPrivate: false }),
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
        where: expect.objectContaining({ id: "goal-1", workspaceId: "ws-1", status: "ACTIVE", isPrivate: false }),
        data: { status: "DRAFT", isPrivate: true, publishedAt: null },
      }));
    });

    it("recomputes parent progress when an active child goal becomes private", async () => {
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce({
          id: "child-goal",
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "user-1",
          parentGoalId: "parent-goal",
          ownerMemberId: "member-1",
          status: "ACTIVE",
          isPrivate: false,
        } as any)
        .mockResolvedValueOnce({
          id: "parent-goal",
          parentGoalId: null,
          progressPercent: 80,
          keyResults: [],
          childGoals: [],
        } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "child-goal",
        workspaceId: "ws-1",
        archivedAt: null,
        parentGoalId: "parent-goal",
        status: "DRAFT",
        isPrivate: true,
      } as any);

      await expect(returnGoalToDraft(actor, {
        workspaceId: "ws-1",
        goalId: "child-goal",
      })).resolves.toMatchObject({
        id: "child-goal",
        status: "DRAFT",
      });

      expect(prisma.goal.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: { id: "parent-goal" },
        include: expect.objectContaining({
          childGoals: expect.objectContaining({
            where: expect.objectContaining({
              archivedAt: null,
            }),
          }),
        }),
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
        where: expect.objectContaining({ id: "goal-1", workspaceId: "ws-1", status: "ACTIVE", isPrivate: false, version: 1 }),
        data: { title: "Updated goal", version: 2 },
      }));
    });

    it("rejects collaborative content edits if the goal changes before commit", async () => {
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
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });

      const { recordAudit } = await import("./audit-trail");
      const { appendEvents } = await import("./events");

      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        progressPercent: 75,
        expectedVersion: 1,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
        message: "The record changed before this update could be applied. Please refresh and try again.",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: {
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          status: "ACTIVE",
          isPrivate: false,
          version: 1,
        },
        data: expect.objectContaining({
          progressPercent: 75,
          version: 2,
        }),
      });
      expect(recordAudit).not.toHaveBeenCalled();
      expect(appendEvents).not.toHaveBeenCalled();
    });

    it("honors expectedVersion and succeeds if it matches current version", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
        progressPercent: 20,
        version: 1,
        parentGoalId: null,
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
        progressPercent: 50,
        version: 2,
      } as any);

      const { updateGoal } = await import("./goals");
      const { recordAudit } = await import("./audit-trail");
      const { appendEvents } = await import("./events");
      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        progressPercent: 50,
        expectedVersion: 1,
      })).resolves.toMatchObject({
        id: "goal-1",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith({
        where: {
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          status: "ACTIVE",
          isPrivate: false,
          version: 1,
        },
        data: expect.objectContaining({
          progressPercent: 50,
          version: 2,
        }),
      });
      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          entityType: "Goal",
          entityId: "goal-1",
          version: 1,
          changedFields: ["progressPercent"],
          previousState: expect.objectContaining({
            progressPercent: 20,
          }),
        }),
      }));
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(appendEvents).toHaveBeenCalledTimes(1);
    });

    it("honors expectedVersion and rejects early if it does not match current version without side effects", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
        version: 3,
        parentGoalId: null,
      } as any);

      const { recordAudit } = await import("./audit-trail");
      const { appendEvents } = await import("./events");
      await expect(updateGoal(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        title: "Versioned edit",
        expectedVersion: 2,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
        message: "The record changed before this update could be applied. Please refresh and try again.",
      });

      expect(prisma.goal.update).not.toHaveBeenCalled();
      expect(prisma.workItemVersion.create).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      expect(appendEvents).not.toHaveBeenCalled();
    });

    it("rejects 0, negative, or fractional expectedVersion as invalid input even on no-op", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValue({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
        version: 1,
        parentGoalId: null,
      } as any);

      for (const invalidVersion of [0, -1, 1.5]) {
        await expect(updateGoal(actor, {
          workspaceId: "ws-1",
          goalId: "goal-1",
          expectedVersion: invalidVersion,
        })).rejects.toMatchObject({
          status: 400,
          code: "INVALID_INPUT",
        });
      }

      expect(prisma.goal.update).not.toHaveBeenCalled();
      expect((prisma as any).workItemVersion.create).not.toHaveBeenCalled();
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
      } as any).mockResolvedValueOnce({
        id: "goal-1",
        progressPercent: 55,
        status: "ACTIVE",
        isPrivate: false,
        archivedAt: null,
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
      expect(prisma.goal.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: expect.objectContaining({
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          status: "ACTIVE",
          isPrivate: false,
        }),
        data: { updatedAt: expect.any(Date) },
        select: { id: true },
      }));
      expect(prisma.goal.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: expect.objectContaining({ id: "goal-1" }),
        data: expect.objectContaining({ progressPercent: 55 }),
      }));
    });

    it("rejects stale progress updates if goal visibility changes before write", async () => {
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
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });

      await expect(postGoalUpdate({
        kind: "user",
        user: { id: "user-2", email: "other@example.com", displayName: "Other" },
      } as any, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: "Progress update",
        newProgress: 55,
      })).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          status: "ACTIVE",
          isPrivate: false,
        }),
        data: { updatedAt: expect.any(Date) },
        select: { id: true },
      }));
      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
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
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce({
          id: "goal-1",
          workspaceId: "ws-1",
          title: "Active goal",
          status: "ACTIVE",
          isPrivate: false,
          authorUserId: "user-1",
          parentGoalId: "parent-goal",
          publishedAt: new Date("2026-07-01T10:00:00.000Z"),
          archivedAt: null,
        } as any)
        .mockResolvedValueOnce({
          id: "parent-goal",
          parentGoalId: null,
          progressPercent: 80,
          keyResults: [],
          childGoals: [],
        } as any);
      vi.mocked(prisma.goalUpdate.create).mockResolvedValueOnce({
        id: "goal-update-1",
        goalId: "goal-1",
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "goal-1",
      } as any).mockResolvedValueOnce({
        id: "goal-1",
        status: "DRAFT",
        isPrivate: true,
        archivedAt: null,
        parentGoalId: "parent-goal",
      } as any);

      await postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        bodyMd: "Return to draft",
        statusChange: "DRAFT",
      });

      expect(prisma.goal.update).toHaveBeenNthCalledWith(2, {
        where: expect.objectContaining({ id: "goal-1" }),
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
      expect(prisma.goal.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: { id: "parent-goal" },
      }));
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
    it("rejects stale collaborative key result creates if the goal changes before commit", async () => {
      const otherActor = {
        kind: "user",
        user: { id: "user-2", email: "other@example.com", displayName: "Other" },
      } as any;
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "goal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        authorUserId: "user-1",
        isPrivate: false,
        status: "ACTIVE",
      } as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });

      await expect(addKeyResult(otherActor, {
        workspaceId: "ws-1",
        goalId: "goal-1",
        title: "New key result",
      })).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
      });

      expect(prisma.keyResult.create).not.toHaveBeenCalled();
    });

    it("locks the authorized goal state before updating key results", async () => {
      vi.mocked(prisma.keyResult.findUnique).mockResolvedValueOnce({
        id: "kr-1",
        goalId: "goal-1",
        title: "Old key result",
        targetValue: 10,
        currentValue: 2,
        goal: {
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          authorUserId: "other-user",
          isPrivate: false,
          status: "ACTIVE",
        },
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ id: "goal-1" } as any);
      vi.mocked(prisma.keyResult.update).mockResolvedValueOnce({
        id: "kr-1",
        goalId: "goal-1",
        title: "Updated key result",
      } as any);

      await expect(updateKeyResult(actor, {
        workspaceId: "ws-1",
        krId: "kr-1",
        title: "Updated key result",
      })).resolves.toMatchObject({
        id: "kr-1",
        title: "Updated key result",
      });

      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          id: "goal-1",
          workspaceId: "ws-1",
          archivedAt: null,
          status: "ACTIVE",
          isPrivate: false,
        }),
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
        select: { id: true },
      }));
      expect(prisma.keyResult.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "kr-1" },
      }));
    });

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
        where: expect.objectContaining({ id: "child-goal" }),
        data: expect.objectContaining({ progressPercent: 75 }),
      }));

      // Recursive call for parent goal
      expect(prisma.goal.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: expect.objectContaining({ id: "parent-goal" }),
        data: expect.objectContaining({ progressPercent: 75 }),
      }));
    });

    it("excludes private draft children from parent progress aggregation", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({
        id: "parent-goal",
        parentGoalId: null,
        progressPercent: 0,
        keyResults: [],
        childGoals: [{ progressPercent: 80, id: "public-child" }],
      } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({
        id: "parent-goal",
        progressPercent: 80,
      } as any);

      await recomputeGoalProgress("parent-goal");

      expect(prisma.goal.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "parent-goal" },
        include: expect.objectContaining({
          childGoals: {
            where: {
              archivedAt: null,
              NOT: {
                isPrivate: true,
                status: "DRAFT",
              },
            },
          },
        }),
      }));
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: "parent-goal" }),
        data: expect.objectContaining({ progressPercent: 80 }),
      }));
    });
  });

  describe("Goal progress versioning regressions", () => {
    const makeGoalFixture = (id: string, overrides: Record<string, unknown> = {}) => ({
      id, workspaceId: "ws-1", title: `Goal ${id}`, descriptionMd: null, level: "COMPANY", cadence: "QUARTERLY",
      status: "ACTIVE", isPrivate: false, progressPercent: 0, version: 1, authorUserId: "user-1", ownerMemberId: "member-1",
      circleId: null, parentGoalId: null, targetDate: null, startDate: null, archivedAt: null, keyResults: [], childGoals: [],
      createdAt: new Date("2026-07-20T10:00:00.000Z"), updatedAt: new Date("2026-07-20T10:05:00.000Z"), ...overrides,
    });

    it("atomically records version history and advances version during duplicate key result merging", async () => {
      const existingGoal = makeGoalFixture("goal-dup", {
        title: "Duplicate target goal",
        version: 3, status: "DRAFT", isPrivate: true, parentGoalId: "parent-goal",
        keyResults: [{ title: "KR 1", progressPercent: 0, sortOrder: 0 }],
      });
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([existingGoal as any]);
      vi.mocked(prisma.goal.findFirst).mockResolvedValue(existingGoal as any);
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce(existingGoal as any)
        .mockResolvedValueOnce(makeGoalFixture("parent-goal", { childGoals: [{ id: "goal-dup", progressPercent: 50 }] }) as any);
      vi.mocked(prisma.keyResult.findMany).mockResolvedValueOnce([{ title: "KR 1", progressPercent: 0, sortOrder: 0 }] as any);
      vi.mocked(prisma.keyResult.createMany).mockResolvedValueOnce({ count: 1 } as any);
      vi.mocked(prisma.goal.update).mockResolvedValue({ id: "goal-dup", version: 4 } as any);

      await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Duplicate target goal",
        keyResults: [{ title: "KR 2", currentValue: 100, targetValue: 100 }],
        duplicateGuard: { resolution: "update_existing", targetEntityId: "goal-dup" },
      });

      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "goal-dup", version: 3, changedFields: expect.arrayContaining(["keyResults", "progressPercent"]) }),
      }));
      expect(prisma.goal.update).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { id: "goal-dup", version: 3 },
        data: expect.objectContaining({ progressPercent: 50, version: 4 }),
      }));
    });

    it("atomically records history and advances version in postGoalUpdate on successful progress update", async () => {
      const activeGoal = makeGoalFixture("goal-post", { progressPercent: 20, version: 2 });
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(activeGoal as any);
      vi.mocked(prisma.goalUpdate.create).mockResolvedValueOnce({ id: "gu-1" } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...activeGoal, progressPercent: 60, version: 3 } as any);

      await postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-post",
        bodyMd: "Progress update",
        newProgress: 60,
        expectedVersion: 2,
      });

      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "goal-post", version: 2, changedFields: ["progressPercent"] }),
      }));
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: "goal-post", version: 2 }),
        data: expect.objectContaining({ progressPercent: 60, version: 3 }),
      }));
    });

    it("rejects postGoalUpdate early with stale expectedVersion and no persisted side effects", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(makeGoalFixture("goal-post", { version: 2 }) as any);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-post",
        bodyMd: "Progress update",
        newProgress: 60,
        expectedVersion: 1,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      expect(prisma.workItemVersion.create).not.toHaveBeenCalled();
      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
      expect(prisma.goal.update).not.toHaveBeenCalled();
    });

    it("recomputeGoalProgress records prior version/history and advances version for directly changed and parent goals", async () => {
      const childGoal = makeGoalFixture("child-1", { parentGoalId: "parent-1", progressPercent: 10, version: 5, keyResults: [{ progressPercent: 90 }] });
      const parentGoal = makeGoalFixture("parent-1", { progressPercent: 20, version: 2, childGoals: [{ id: "child-1", progressPercent: 90 }] });

      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce(childGoal as any)
        .mockResolvedValueOnce(parentGoal as any);
      vi.mocked(prisma.goal.update)
        .mockResolvedValueOnce({ ...childGoal, progressPercent: 90, version: 6 } as any)
        .mockResolvedValueOnce({ ...parentGoal, progressPercent: 90, version: 3 } as any);

      await recomputeGoalProgress("child-1", actor);

      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "child-1", version: 5, changedFields: ["progressPercent"] }),
      }));
      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "parent-1", version: 2, changedFields: ["progressPercent"] }),
      }));
      expect(prisma.goal.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: "child-1", version: 5 }, data: { progressPercent: 90, version: 6 } }));
      expect(prisma.goal.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { id: "parent-1", version: 2 }, data: { progressPercent: 90, version: 3 } }));
    });

    it("maps CAS P2025 in recomputeGoalProgress to 409 VERSION_CONFLICT", async () => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(makeGoalFixture("child-collision", { keyResults: [{ progressPercent: 90 }] }) as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });

      await expect(recomputeGoalProgress("child-collision", actor)).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });
    });

    it("rejects body-only postGoalUpdate with a stale expectedVersion under lock and creates no GoalUpdate, event, or audit row", async () => {
      const { appendEvents } = await import("./events");
      const { recordAudit } = await import("./audit-trail");
      const goal = makeGoalFixture("goal-body-stale", { version: 3 });

      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(goal as any);
      vi.mocked(prisma.goalUpdate.create).mockClear();
      vi.mocked(appendEvents).mockClear();
      vi.mocked(recordAudit).mockClear();

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-body-stale",
        bodyMd: "Just notes body",
        expectedVersion: 2,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      expect(prisma.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Goal:goal-body-stale");
      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
      expect(appendEvents).not.toHaveBeenCalled();
    });

    it("performs reload and rechecks inside transaction before GoalUpdate create in postGoalUpdate", async () => {
      const goal = makeGoalFixture("goal-reload-recheck", { version: 1, archivedAt: new Date() });
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(goal as any);
      vi.mocked(prisma.goalUpdate.create).mockClear();

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "goal-reload-recheck",
        bodyMd: "Notes",
      })).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });

      expect(prisma.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Goal:goal-reload-recheck");
      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
    });

    it("executes addKeyResult, updateKeyResult, and deleteKeyResult atomically with derived goal progress/version write", async () => {
      const { addKeyResult, updateKeyResult, deleteKeyResult } = await import("./goals");
      const goal = makeGoalFixture("goal-kr-atomic", { version: 1, progressPercent: 0, keyResults: [] });

      // 1. addKeyResult
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce(goal as any)
        .mockResolvedValueOnce({ ...goal, keyResults: [{ id: "kr-1", progressPercent: 50 }] } as any);
      vi.mocked(prisma.keyResult.create).mockResolvedValueOnce({ id: "kr-1", goalId: "goal-kr-atomic", progressPercent: 50 } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, progressPercent: 50, version: 2 } as any);

      await addKeyResult(actor, {
        workspaceId: "ws-1",
        goalId: "goal-kr-atomic",
        title: "KR 1",
        targetValue: 100,
        currentValue: 50,
      });

      expect(prisma.keyResult.create).toHaveBeenCalled();
      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "goal-kr-atomic", version: 1 }),
      }));

      // 2. updateKeyResult
      const kr = { id: "kr-1", goalId: "goal-kr-atomic", title: "KR 1", targetValue: 100, currentValue: 50, progressPercent: 50, goal };
      vi.mocked(prisma.keyResult.findUnique).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({ ...goal, progressPercent: 50, version: 2, keyResults: [{ id: "kr-1", progressPercent: 100 }] } as any);
      vi.mocked(prisma.keyResult.update).mockResolvedValueOnce({ ...kr, currentValue: 100, progressPercent: 100 } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, progressPercent: 100, version: 3 } as any);

      await updateKeyResult(actor, {
        workspaceId: "ws-1",
        krId: "kr-1",
        currentValue: 100,
      });

      expect(prisma.keyResult.update).toHaveBeenCalled();

      // 3. deleteKeyResult
      vi.mocked(prisma.keyResult.findUnique).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({ ...goal, progressPercent: 100, version: 3, keyResults: [] } as any);
      vi.mocked(prisma.keyResult.delete).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, progressPercent: 0, version: 4 } as any);

      await deleteKeyResult(actor, {
        workspaceId: "ws-1",
        krId: "kr-1",
      });

      expect(prisma.keyResult.delete).toHaveBeenCalled();
    });

    it("proves nonexistent, unauthorized, or invalid-state Goal guard wins before invalid body/author validation, and stale body-only update creates nothing", async () => {
      // 1. Nonexistent Goal guard wins before invalid body and author validation
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(null);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "nonexistent-goal",
        bodyMd: "",
        authorMemberId: "invalid-author-id",
      })).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });

      // 2. Unauthorized Goal guard wins before invalid body and author validation
      const draftGoalOtherUser = makeGoalFixture("unauthorized-goal", {
        status: "DRAFT",
        isPrivate: true,
        authorUserId: "other-user",
      });
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(draftGoalOtherUser as any);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "unauthorized-goal",
        bodyMd: "",
        authorMemberId: "invalid-author-id",
      })).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });

      // 3. Invalid-state Goal guard wins before invalid body and author validation
      const completedGoal = makeGoalFixture("completed-goal", {
        status: "COMPLETED",
      });
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(completedGoal as any);

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "completed-goal",
        bodyMd: "",
        authorMemberId: "invalid-author-id",
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_STATE",
      });

      // 4. Stale body-only expectedVersion creates no GoalUpdate
      const activeGoal = makeGoalFixture("active-stale-body", {
        status: "ACTIVE",
        version: 3,
      });
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(activeGoal as any);
      vi.mocked(prisma.goalUpdate.create).mockClear();

      await expect(postGoalUpdate(actor, {
        workspaceId: "ws-1",
        goalId: "active-stale-body",
        bodyMd: "Valid body text",
        expectedVersion: 2,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      expect(prisma.goalUpdate.create).not.toHaveBeenCalled();
    });

    it("triggers versioned parent recomputation and history in the same transaction when deleteGoal archives a goal with a parent, and rejects archive transaction on forced parent CAS failure", async () => {
      const { deleteGoal } = await import("./goals");
      const { appendEvents } = await import("./events");
      const { recordAudit } = await import("./audit-trail");
      const childGoal = makeGoalFixture("child-del", { parentGoalId: "parent-del", version: 2 });
      const parentGoal = makeGoalFixture("parent-del", { progressPercent: 50, version: 5, keyResults: [{ id: "kr-p1", progressPercent: 0 }] });

      // 1. Successful delete with parent recompute
      vi.mocked(prisma.goal.findFirst).mockResolvedValueOnce(childGoal as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...childGoal, archivedAt: new Date() } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(parentGoal as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...parentGoal, progressPercent: 0, version: 6 } as any);

      await deleteGoal(actor, { workspaceId: "ws-1", goalId: "child-del" });

      expect(prisma.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entityType: "Goal", entityId: "parent-del", version: 5, changedFields: ["progressPercent"] }),
      }));
      expect(prisma.goal.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "parent-del", version: 5 },
        data: expect.objectContaining({ progressPercent: 0, version: 6 }),
      }));

      // 2. Forced parent CAS failure during recompute rejects archive transaction
      vi.mocked(prisma.goal.findFirst).mockResolvedValueOnce(childGoal as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...childGoal, archivedAt: new Date() } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(parentGoal as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });
      vi.mocked(appendEvents).mockClear();
      vi.mocked(recordAudit).mockClear();
      vi.mocked(prisma.workspaceArchiveRecord.create).mockClear();
      vi.mocked(prisma.$transaction).mockClear();

      await expect(deleteGoal(actor, { workspaceId: "ws-1", goalId: "child-del" })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      expect(recordAudit).not.toHaveBeenCalled();
      expect(prisma.workspaceArchiveRecord.create).not.toHaveBeenCalled();
      expect(appendEvents).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("forces derived Goal/WorkItemVersion path to fail after KR operation in addKeyResult, updateKeyResult, and deleteKeyResult, rejecting the single $transaction promise with no second transaction or survived events/audit", async () => {
      const { addKeyResult, updateKeyResult, deleteKeyResult } = await import("./goals");
      const { appendEvents } = await import("./events");
      const { recordAudit } = await import("./audit-trail");
      const goal = makeGoalFixture("goal-kr-fail", { version: 1, progressPercent: 0, keyResults: [] });
      const kr = { id: "kr-fail-1", goalId: "goal-kr-fail", title: "KR 1", targetValue: 100, currentValue: 50, progressPercent: 50, goal };

      // 1. addKeyResult failure on derived Goal update (after lock update & KR creation)
      vi.mocked(prisma.goal.findUnique)
        .mockResolvedValueOnce(goal as any)
        .mockResolvedValueOnce({ ...goal, keyResults: [{ id: "kr-fail-1", progressPercent: 50 }] } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal } as any);
      vi.mocked(prisma.keyResult.create).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });
      vi.mocked(prisma.keyResult.create).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.$transaction).mockClear();
      vi.mocked(appendEvents).mockClear();
      vi.mocked(recordAudit).mockClear();

      await expect(addKeyResult(actor, {
        workspaceId: "ws-1",
        goalId: "goal-kr-fail",
        title: "KR 1",
        targetValue: 100,
        currentValue: 50,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      const krCreateOrder1 = vi.mocked(prisma.keyResult.create).mock.invocationCallOrder[0];
      const derivedGoalUpdateOrder1 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[1];
      expect(krCreateOrder1).toBeLessThan(derivedGoalUpdateOrder1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(appendEvents).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();

      // 2. updateKeyResult failure on derived Goal update (after lock update & KR update)
      vi.mocked(prisma.keyResult.findUnique).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({ ...goal, keyResults: [{ id: "kr-fail-1", progressPercent: 100 }] } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal } as any);
      vi.mocked(prisma.keyResult.update).mockResolvedValueOnce({ ...kr, currentValue: 100 } as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });
      vi.mocked(prisma.keyResult.update).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.$transaction).mockClear();
      vi.mocked(appendEvents).mockClear();
      vi.mocked(recordAudit).mockClear();

      await expect(updateKeyResult(actor, {
        workspaceId: "ws-1",
        krId: "kr-fail-1",
        currentValue: 100,
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      const krUpdateOrder2 = vi.mocked(prisma.keyResult.update).mock.invocationCallOrder[0];
      const derivedGoalUpdateOrder2 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[1];
      expect(krUpdateOrder2).toBeLessThan(derivedGoalUpdateOrder2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(appendEvents).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();

      // 3. deleteKeyResult failure on derived Goal update (after lock update & KR deletion)
      const goalWithKr = makeGoalFixture("goal-kr-fail", { version: 1, progressPercent: 50, keyResults: [{ id: "kr-fail-1", progressPercent: 50 }, { id: "kr-remaining", progressPercent: 0 }] });
      vi.mocked(prisma.keyResult.findUnique).mockResolvedValueOnce({ ...kr, goal: goalWithKr } as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce({ ...goalWithKr, keyResults: [{ id: "kr-remaining", progressPercent: 0 }] } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goalWithKr } as any);
      vi.mocked(prisma.keyResult.delete).mockResolvedValueOnce(kr as any);
      vi.mocked(prisma.goal.update).mockRejectedValueOnce({ code: "P2025" });
      vi.mocked(prisma.keyResult.delete).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.$transaction).mockClear();
      vi.mocked(appendEvents).mockClear();
      vi.mocked(recordAudit).mockClear();

      await expect(deleteKeyResult(actor, {
        workspaceId: "ws-1",
        krId: "kr-fail-1",
      })).rejects.toMatchObject({
        status: 409,
        code: "VERSION_CONFLICT",
      });

      const krDeleteOrder3 = vi.mocked(prisma.keyResult.delete).mock.invocationCallOrder[0];
      const derivedGoalUpdateOrder3 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[1];
      expect(krDeleteOrder3).toBeLessThan(derivedGoalUpdateOrder3);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(appendEvents).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("verifies advisory $executeRaw occurs before the first goal.update row lock or update for representative Goal writer paths", async () => {
      const { updateGoal, postGoalUpdate, addKeyResult, deleteGoal, createGoal } = await import("./goals");
      const goal = makeGoalFixture("goal-order-test", { version: 1 });
      const dupGoal = makeGoalFixture("goal-order-test", { version: 1, status: "DRAFT", isPrivate: true, authorUserId: "user-1" });

      // 1. updateGoal
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(goal as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, title: "Updated" } as any);
      await updateGoal(actor, { workspaceId: "ws-1", goalId: "goal-order-test", title: "Updated" });
      const lockOrder1 = vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0];
      const updateOrder1 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[0];
      expect(lockOrder1).toBeLessThan(updateOrder1);

      // 2. postGoalUpdate
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.goal.findUnique).mockResolvedValueOnce(goal as any);
      vi.mocked(prisma.goalUpdate.create).mockResolvedValueOnce({ id: "gu-1" } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, updatedAt: new Date() } as any);
      await postGoalUpdate(actor, { workspaceId: "ws-1", goalId: "goal-order-test", bodyMd: "Note" });
      const lockOrder2 = vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0];
      const updateOrder2 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[0];
      expect(lockOrder2).toBeLessThan(updateOrder2);

      // 3. KeyResult (addKeyResult)
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.keyResult.create).mockClear();
      vi.mocked(prisma.goal.findUnique).mockResolvedValue(goal as any);
      vi.mocked(prisma.keyResult.create).mockResolvedValueOnce({ id: "kr-1", goalId: "goal-order-test" } as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, version: 2 } as any);
      await addKeyResult(actor, { workspaceId: "ws-1", goalId: "goal-order-test", title: "KR" });
      const lockOrder3 = vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0];
      const krCreateOrder3 = vi.mocked(prisma.keyResult.create).mock.invocationCallOrder[0];
      const updateOrder3 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[0];
      expect(lockOrder3).toBeLessThan(krCreateOrder3);
      expect(lockOrder3).toBeLessThan(updateOrder3);

      // 4. duplicate/recompute (createGoal duplicate merging)
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.goal.findMany).mockResolvedValueOnce([dupGoal as any]);
      vi.mocked(prisma.goal.findFirst).mockResolvedValue(dupGoal as any);
      vi.mocked(prisma.goal.findUnique).mockResolvedValue(dupGoal as any);
      vi.mocked(prisma.keyResult.findMany).mockResolvedValueOnce([] as any);
      vi.mocked(prisma.keyResult.createMany).mockResolvedValueOnce({ count: 1 } as any);
      vi.mocked(prisma.goal.update).mockResolvedValue({ ...dupGoal, version: 2 } as any);
      await createGoal(actor, {
        workspaceId: "ws-1",
        title: "Goal goal-order-test",
        keyResults: [{ title: "KR New", currentValue: 0, targetValue: 100 }],
        duplicateGuard: { resolution: "update_existing", targetEntityId: "goal-order-test" },
      });
      const lockOrder4 = vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0];
      const updateOrder4 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[0];
      expect(lockOrder4).toBeLessThan(updateOrder4);

      // 5. deleteGoal
      vi.mocked(prisma.$executeRaw).mockClear();
      vi.mocked(prisma.goal.update).mockClear();
      vi.mocked(prisma.goal.findFirst).mockResolvedValueOnce(goal as any);
      vi.mocked(prisma.goal.update).mockResolvedValueOnce({ ...goal, archivedAt: new Date() } as any);
      await deleteGoal(actor, { workspaceId: "ws-1", goalId: "goal-order-test" });
      const lockOrder5 = vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0];
      const updateOrder5 = vi.mocked(prisma.goal.update).mock.invocationCallOrder[0];
      expect(lockOrder5).toBeLessThan(updateOrder5);
    });
  });
});
