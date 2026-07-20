import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import { invariant } from "./errors";
import { requireDraftManager } from "./draft-permissions";
import { humanMemberIdentityWhere } from "./member-identity";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardMergeText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";
import {
  listNativePracticeProjectHealthByIds,
} from "./practice-finance";
import type { GoalLevel, GoalCadence, GoalStatus, PracticeProjectStatus, Prisma } from "@prisma/client";
import {
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
  requireSubmittedWorkItemAuthor,
  resolveWorkspaceMemberUserId,
} from "./work-item-versions";

type GoalKeyResultInput = {
  title: string;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
  sortOrder?: number | null;
};

type CreateGoalParams = {
  workspaceId: string;
  title: string;
  descriptionMd?: string | null;
  level?: GoalLevel;
  cadence?: GoalCadence;
  status?: GoalStatus;
  targetDate?: Date | null;
  startDate?: Date | null;
  parentGoalId?: string | null;
  circleId?: string | null;
  ownerMemberId?: string | null;
  keyResults?: GoalKeyResultInput[];
  duplicateGuard?: DuplicateGuardOptions | null;
  _membership?: MembershipSummary | null;
};

const COMPANY_UNDERSTANDING_SOURCE = "company-understanding";
const SHORT_TERM_DIRECTION_CADENCES = new Set<GoalCadence>(["WEEKLY", "MONTHLY", "QUARTERLY"]);
export const GOAL_FINANCE_PROJECT_ENTITY_TYPE = "PracticeProject";
const GOAL_FINANCE_PROJECT_SOURCE = "practice-finance";

export type CompanyDirectionEvidenceLink = {
  id: string;
  entityType: string;
  entityId: string;
  confidence: number;
  label: string;
  detail: string | null;
  quote: string | null;
  articleSlug: string | null;
};

export type CompanyDirectionGoal = {
  id: string;
  title: string;
  descriptionMd: string | null;
  cadence: GoalCadence;
  status: GoalStatus;
  confidence: number | null;
  updatedAt: Date;
  evidenceLinks: CompanyDirectionEvidenceLink[];
};

export type CompanyDirectionQuestion = {
  id: string;
  questionText: string;
  priority: number;
  confidence: number | null;
  reason: string | null;
  responseUsePolicy: string;
  createdAt: Date;
  relatedEvidence: Omit<CompanyDirectionEvidenceLink, "id" | "confidence" | "quote"> | null;
};

export type CompanyDirectionFromBrain = {
  decisionsNow: CompanyDirectionGoal[];
  strategyLater: CompanyDirectionGoal[];
  openQuestions: CompanyDirectionQuestion[];
  generatedGoalCount: number;
  evidenceLinkCount: number;
};

export type GoalFinanceProjectSummary = {
  id: string;
  code: string;
  name: string;
  clientName: string;
  status: PracticeProjectStatus;
  poValueCents: number;
  usedCents: number;
  remainingCents: number;
  serviceBudgetCents: number;
  expenseBudgetCents: number;
  weeklyBurnCents: number;
  usedRatio: number;
  budgetRunwayWeeks: number | null;
  targetMarginBps: number | null;
  currentMarginBps: number | null;
};

export type GoalFinanceProjectLink = {
  id: string;
  goalId: string;
  entityId: string;
  confidence: number;
  source: string | null;
  createdAt: Date;
  project: GoalFinanceProjectSummary;
};

function jsonRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataString(value: Prisma.JsonValue | null | undefined, key: string) {
  const record = jsonRecord(value);
  const raw = record?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function clampProgressPercent(value: number, fieldName = "Progress") {
  invariant(Number.isFinite(value), 400, "INVALID_INPUT", `${fieldName} must be a number.`);
  const rounded = Math.round(value);
  invariant(rounded >= 0 && rounded <= 100, 400, "INVALID_INPUT", `${fieldName} must be between 0 and 100.`);
  return rounded;
}

function clampConfidence(value: number | undefined, fieldName = "Confidence") {
  if (value === undefined) return undefined;
  invariant(Number.isFinite(value), 400, "INVALID_INPUT", `${fieldName} must be a number.`);
  invariant(value >= 0 && value <= 1, 400, "INVALID_INPUT", `${fieldName} must be between 0 and 1.`);
  return value;
}

function keyResultProgress(keyResult: GoalKeyResultInput) {
  if (keyResult.targetValue && keyResult.targetValue > 0) {
    return clampProgressPercent(((keyResult.currentValue || 0) / keyResult.targetValue) * 100, "Key result progress");
  }
  return 0;
}

async function assertGoalInWorkspace(tx: Prisma.TransactionClient, workspaceId: string, goalId: string) {
  const goal = await tx.goal.findUnique({
    where: { id: goalId },
    select: {
      id: true,
      workspaceId: true,
      archivedAt: true,
      title: true,
      descriptionMd: true,
      level: true,
      cadence: true,
      targetDate: true,
      startDate: true,
      parentGoalId: true,
      circleId: true,
      ownerMemberId: true,
      status: true,
      progressPercent: true,
      version: true,
    },
  });
  invariant(goal && goal.workspaceId === workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  return goal;
}

async function validateGoalReferences(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    currentGoalId?: string;
    parentGoalId?: string | null;
    circleId?: string | null;
    ownerMemberId?: string | null;
  },
) {
  if (params.parentGoalId) {
    invariant(params.parentGoalId !== params.currentGoalId, 400, "INVALID_INPUT", "Goal cannot be its own parent.");
    const parentGoal = await tx.goal.findUnique({
      where: { id: params.parentGoalId },
      select: { workspaceId: true, archivedAt: true },
    });
    invariant(
      parentGoal && parentGoal.workspaceId === params.workspaceId && !parentGoal.archivedAt,
      400,
      "INVALID_INPUT",
      "Parent goal must be an active goal in the same workspace.",
    );
  }

  if (params.circleId) {
    const circle = await tx.circle.findUnique({
      where: { id: params.circleId },
      select: { workspaceId: true, archivedAt: true },
    });
    invariant(
      circle && circle.workspaceId === params.workspaceId && !circle.archivedAt,
      400,
      "INVALID_INPUT",
      "Goal circle must be an active circle in the same workspace.",
    );
  }

  if (params.ownerMemberId) {
    const owner = await tx.member.findFirst({
      where: {
        id: params.ownerMemberId,
        ...humanMemberIdentityWhere(),
      },
      select: { workspaceId: true, isActive: true },
    });
    invariant(
      owner && owner.workspaceId === params.workspaceId && owner.isActive,
      400,
      "INVALID_INPUT",
      "Goal owner must be an active human member in the same workspace.",
    );
  }
}

function normalizeKeyResults(keyResults: GoalKeyResultInput[] | undefined) {
  return (keyResults ?? []).map((keyResult, index) => {
    const title = keyResult.title.trim();
    invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");
    return {
      title,
      targetValue: keyResult.targetValue ?? null,
      currentValue: keyResult.currentValue ?? 0,
      unit: keyResult.unit || null,
      progressPercent: keyResultProgress(keyResult),
      sortOrder: keyResult.sortOrder ?? index,
    };
  });
}

export async function createGoal(
  actor: AppActor,
  params: CreateGoalParams
) {
  const membership = params._membership ?? await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Goal title is required.");
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Goal",
    title,
    body: params.descriptionMd,
    ownerMemberId: params.ownerMemberId,
    circleId: params.circleId,
    parentGoalId: params.parentGoalId,
    cadence: params.cadence ?? "QUARTERLY",
    level: params.level ?? "COMPANY",
    targetDate: params.targetDate,
    startDate: params.startDate,
    actorUserId: actor.kind === "user" ? actor.user.id : null,
    membershipId: membership?.id ?? null,
    includePrivate: actor.kind === "agent" || membership?.role === "ADMIN",
  }, params.duplicateGuard);
  if (duplicateDecision?.resolution === "use_existing") {
    return getGoal(actor, { workspaceId: params.workspaceId, goalId: duplicateDecision.match.entityId });
  }
  if (duplicateDecision?.resolution === "update_existing") {
    const existing = await getGoal(actor, { workspaceId: params.workspaceId, goalId: duplicateDecision.match.entityId });
    const mergedDescription = duplicateGuardMergeText(existing.descriptionMd, params.descriptionMd);
    const updateParams: Parameters<typeof updateGoal>[1] = {
      workspaceId: params.workspaceId,
      goalId: duplicateDecision.match.entityId,
      _membership: params._membership,
    };
    if ((mergedDescription ?? null) !== (existing.descriptionMd ?? null)) updateParams.descriptionMd = mergedDescription;
    if (!existing.ownerMemberId && params.ownerMemberId) updateParams.ownerMemberId = params.ownerMemberId;
    if (!existing.circleId && params.circleId) updateParams.circleId = params.circleId;
    if (!existing.parentGoalId && params.parentGoalId) updateParams.parentGoalId = params.parentGoalId;
    if (!existing.targetDate && params.targetDate) updateParams.targetDate = params.targetDate;
    if (!existing.startDate && params.startDate) updateParams.startDate = params.startDate;
    return Object.keys(updateParams).length > 3 ? updateGoal(actor, updateParams) : existing;
  }

  return prisma.$transaction(async (tx) => {
    await validateGoalReferences(tx, params);
    const keyResults = normalizeKeyResults(params.keyResults);
    const progressPercent = keyResults.length > 0
      ? Math.round(keyResults.reduce((total, keyResult) => total + keyResult.progressPercent, 0) / keyResults.length)
      : 0;

    const goal = await tx.goal.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        descriptionMd: params.descriptionMd || null,
        level: params.level ?? "COMPANY",
        cadence: params.cadence ?? "QUARTERLY",
        status: params.status ?? "DRAFT",
        progressPercent,
        targetDate: params.targetDate || null,
        startDate: params.startDate || null,
        parentGoalId: params.parentGoalId || null,
        circleId: params.circleId || null,
        ownerMemberId: params.ownerMemberId || null,
      },
    });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Goal", goal),
    });

    if (keyResults.length > 0) {
      await tx.keyResult.createMany({
        data: keyResults.map((keyResult) => ({
          goalId: goal.id,
          ...keyResult,
        })),
      });
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.created",
      entityType: "Goal",
      entityId: goal.id,
      meta: { title: goal.title, ...duplicateGuardAuditMeta(duplicateDecision) },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal.created",
        aggregateType: "Goal",
        aggregateId: goal.id,
        payload: {
          goalId: goal.id,
          title: goal.title,
        },
      },
    ]);

    return goal;
  });
}

export async function updateGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    title?: string;
    descriptionMd?: string | null;
    level?: GoalLevel;
    cadence?: GoalCadence;
    status?: GoalStatus;
    progressPercent?: number;
    targetDate?: Date | null;
    startDate?: Date | null;
    parentGoalId?: string | null;
    circleId?: string | null;
    ownerMemberId?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    const goal = await assertGoalInWorkspace(tx, params.workspaceId, params.goalId);
    await validateGoalReferences(tx, {
      workspaceId: params.workspaceId,
      currentGoalId: params.goalId,
      parentGoalId: params.parentGoalId,
      circleId: params.circleId,
      ownerMemberId: params.ownerMemberId,
    });

    const data: Record<string, unknown> = {};
    const editsDraftContent = params.title !== undefined
      || params.descriptionMd !== undefined
      || params.level !== undefined
      || params.cadence !== undefined
      || params.targetDate !== undefined
      || params.startDate !== undefined
      || params.parentGoalId !== undefined
      || params.circleId !== undefined
      || params.ownerMemberId !== undefined;
    const changesWorkflow = params.status !== undefined || params.progressPercent !== undefined;

    if (editsDraftContent) {
      if (goal.status === "DRAFT") {
        await requireDraftManager({ actor, workspaceId: params.workspaceId, record: goal, resolvedMembership: membership });
      } else {
        invariant(["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"].includes(goal.status), 400, "INVALID_STATE", "Only draft or active goals can be edited.");
        const ownerUserId = goal.ownerMemberId
          ? await resolveWorkspaceMemberUserId(tx, params.workspaceId, goal.ownerMemberId, "Goal owner must be an active member of this workspace.")
          : null;
        requireSubmittedWorkItemAuthor(actor, ownerUserId);
      }
    }
    if (changesWorkflow) {
      if (params.status === "DRAFT") {
        invariant(["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"].includes(goal.status), 400, "INVALID_STATE", "Only active goals can be returned to draft.");
      } else if (goal.status === "COMPLETED" || goal.status === "ABANDONED") {
        invariant(params.progressPercent === undefined && params.status === undefined, 400, "INVALID_STATE", "Completed or abandoned goals cannot be changed.");
      }
      await requireDraftManager({ actor, workspaceId: params.workspaceId, record: goal, resolvedMembership: membership });
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Goal title is required.");
      data.title = title;
    }
    if (params.descriptionMd !== undefined) data.descriptionMd = params.descriptionMd || null;
    if (params.level !== undefined) data.level = params.level;
    if (params.cadence !== undefined) data.cadence = params.cadence;
    if (params.status !== undefined) data.status = params.status;
    if (params.progressPercent !== undefined) data.progressPercent = clampProgressPercent(params.progressPercent);
    if (params.targetDate !== undefined) data.targetDate = params.targetDate || null;
    if (params.startDate !== undefined) data.startDate = params.startDate || null;
    if (params.parentGoalId !== undefined) data.parentGoalId = params.parentGoalId || null;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.ownerMemberId !== undefined) data.ownerMemberId = params.ownerMemberId || null;

    const contentFields = ["title", "descriptionMd", "level", "cadence", "targetDate", "startDate", "parentGoalId", "circleId", "ownerMemberId"];
    const changedFields = changedDataFields(goal as unknown as Record<string, unknown>, data)
      .filter((field) => contentFields.includes(field));
    if (changedFields.length > 0) {
      data.version = await recordWorkItemVersion(tx, actor, {
        workspaceId: params.workspaceId,
        entityType: "Goal",
        entityId: goal.id,
        currentVersion: goal.version,
        changedFields,
        previousState: pickJsonSnapshot(goal as unknown as Record<string, unknown>, [
          "id",
          "workspaceId",
          "title",
          "descriptionMd",
          "level",
          "cadence",
          "targetDate",
          "startDate",
          "parentGoalId",
          "circleId",
          "ownerMemberId",
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(goal as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return goal;

    const updated = await tx.goal.update({
      where: { id: params.goalId },
      data,
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.updated",
      entityType: "Goal",
      entityId: updated.id,
      meta: { fields: changedUpdateFields, version: updated.version },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal.updated",
        aggregateType: "Goal",
        aggregateId: updated.id,
        payload: {
          goalId: updated.id,
          fields: changedUpdateFields,
        },
      },
    ]);

    return updated;
  });
}

export async function returnGoalToDraft(actor: AppActor, params: {
  workspaceId: string;
  goalId: string;
  _membership?: MembershipSummary | null;
}) {
  return updateGoal(actor, {
    workspaceId: params.workspaceId,
    goalId: params.goalId,
    status: "DRAFT",
    _membership: params._membership,
  });
}

export async function deleteGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    includeArchived?: boolean;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Goal",
    entityId: params.goalId,
    reason: "Archived from goal delete path.",
  });
}

export async function getGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    includeArchived?: boolean;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
    include: {
      ownerMember: {
        include: {
          user: {
            select: { displayName: true, email: true },
          },
        },
      },
      childGoals: true,
      keyResults: {
        orderBy: { sortOrder: "asc" },
      },
      updates: {
        orderBy: { createdAt: "desc" },
        include: {
          authorMember: {
            include: {
              user: {
                select: { displayName: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  invariant(goal && goal.workspaceId === params.workspaceId && (params.includeArchived || !goal.archivedAt), 404, "NOT_FOUND", "Goal not found.");
  return goal;
}

export async function listGoals(
  actor: AppActor,
  params: {
    workspaceId: string;
    level?: GoalLevel;
    cadence?: GoalCadence;
    circleId?: string | null;
    ownerMemberId?: string | null;
    status?: GoalStatus;
    parentGoalId?: string | null;
    take?: number;
    skip?: number;
    archiveFilter?: ArchiveFilter;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const query: any = { workspaceId: params.workspaceId, ...archiveFilterWhere(params.archiveFilter) };
  if (params.level !== undefined) query.level = params.level;
  if (params.cadence !== undefined) query.cadence = params.cadence;
  if (params.circleId !== undefined) query.circleId = params.circleId;
  if (params.ownerMemberId !== undefined) query.ownerMemberId = params.ownerMemberId;
  if (params.status !== undefined) query.status = params.status;
  if (params.parentGoalId !== undefined) query.parentGoalId = params.parentGoalId;

  return prisma.goal.findMany({
    where: query,
    take: params.take,
    skip: params.skip,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    include: {
      ownerMember: {
        include: {
          user: { select: { displayName: true, email: true } },
        },
      },
      keyResults: true,
      circle: true,
    },
  });
}

export async function listCompanyDirectionFromBrain(
  actor: AppActor,
  params: {
    workspaceId: string;
    take?: number;
    questionTake?: number;
    _membership?: MembershipSummary | null;
  },
): Promise<CompanyDirectionFromBrain> {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });
  const take = Math.min(Math.max(params.take ?? 24, 1), 100);
  const questionTake = Math.min(Math.max(params.questionTake ?? 8, 1), 25);

  const [goals, questions] = await Promise.all([
    prisma.goal.findMany({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        links: {
          some: {
            source: COMPANY_UNDERSTANDING_SOURCE,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take,
      include: {
        links: {
          where: {
            source: COMPANY_UNDERSTANDING_SOURCE,
          },
          orderBy: [{ createdAt: "asc" }],
        },
      },
    }),
    membership
      ? prisma.checkIn.findMany({
          where: {
            workspaceId: params.workspaceId,
            memberId: membership.id,
            questionType: "COMPANY_UNDERSTANDING",
            status: "OPEN",
          },
          orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
          take: questionTake,
        })
      : Promise.resolve([]),
  ]);

  const brainSourceIds = new Set<string>();
  const brainArticleIds = new Set<string>();
  for (const goal of goals) {
    for (const link of goal.links) {
      if (link.entityType === "BrainSource") brainSourceIds.add(link.entityId);
      if (link.entityType === "BrainArticle") brainArticleIds.add(link.entityId);
    }
  }
  for (const question of questions) {
    if (question.relatedEntityType === "BrainSource" && question.relatedEntityId) brainSourceIds.add(question.relatedEntityId);
    if (question.relatedEntityType === "BrainArticle" && question.relatedEntityId) brainArticleIds.add(question.relatedEntityId);
  }

  const [brainSources, brainArticles] = await Promise.all([
    brainSourceIds.size > 0
      ? prisma.brainSource.findMany({
          where: {
            workspaceId: params.workspaceId,
            id: { in: Array.from(brainSourceIds) },
            archivedAt: null,
          },
          select: {
            id: true,
            sourceType: true,
            title: true,
            fileName: true,
            channel: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    brainArticleIds.size > 0
      ? prisma.brainArticle.findMany({
          where: {
            workspaceId: params.workspaceId,
            id: { in: Array.from(brainArticleIds) },
            archivedAt: null,
          },
          select: {
            id: true,
            slug: true,
            title: true,
            type: true,
            authority: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const sourceById = new Map(brainSources.map((source) => [source.id, source]));
  const articleById = new Map(brainArticles.map((article) => [article.id, article]));

  const evidenceDisplay = (entityType: string, entityId: string) => {
    if (entityType === "BrainSource") {
      const source = sourceById.get(entityId);
      return {
        label: source?.title || source?.fileName || source?.channel || (source ? `${source.sourceType} source` : `Brain source ${entityId.slice(0, 8)}`),
        detail: source ? `${source.sourceType} source` : "Brain source",
        articleSlug: null,
      };
    }
    if (entityType === "BrainArticle") {
      const article = articleById.get(entityId);
      return {
        label: article?.title || `Brain article ${entityId.slice(0, 8)}`,
        detail: article ? `${article.type} article - ${article.authority.toLowerCase()}` : "Brain article",
        articleSlug: article?.slug ?? null,
      };
    }
    return {
      label: `${entityType} ${entityId.slice(0, 8)}`,
      detail: entityType,
      articleSlug: null,
    };
  };

  const mapEvidenceLink = (link: (typeof goals)[number]["links"][number]): CompanyDirectionEvidenceLink => {
    const display = evidenceDisplay(link.entityType, link.entityId);
    return {
      id: link.id,
      entityType: link.entityType,
      entityId: link.entityId,
      confidence: link.confidence,
      label: metadataString(link.metadata, "label") ?? display.label,
      detail: display.detail,
      quote: metadataString(link.metadata, "quote"),
      articleSlug: display.articleSlug,
    };
  };

  const mappedGoals = goals.map((goal): CompanyDirectionGoal => {
    const evidenceLinks = goal.links.map(mapEvidenceLink);
    const confidence = evidenceLinks.length > 0
      ? Math.max(...evidenceLinks.map((link) => link.confidence))
      : null;
    return {
      id: goal.id,
      title: goal.title,
      descriptionMd: goal.descriptionMd,
      cadence: goal.cadence,
      status: goal.status,
      confidence,
      updatedAt: goal.updatedAt,
      evidenceLinks,
    };
  });

  const mappedQuestions = questions.map((question): CompanyDirectionQuestion => {
    const relatedEvidence = question.relatedEntityType && question.relatedEntityId
      ? {
          entityType: question.relatedEntityType,
          entityId: question.relatedEntityId,
          ...evidenceDisplay(question.relatedEntityType, question.relatedEntityId),
        }
      : null;
    return {
      id: question.id,
      questionText: question.questionText,
      priority: question.priority,
      confidence: question.confidence,
      reason: metadataString(question.metadata, "reason"),
      responseUsePolicy: question.responseUsePolicy,
      createdAt: question.createdAt,
      relatedEvidence,
    };
  });

  return {
    decisionsNow: mappedGoals.filter((goal) => SHORT_TERM_DIRECTION_CADENCES.has(goal.cadence)),
    strategyLater: mappedGoals.filter((goal) => !SHORT_TERM_DIRECTION_CADENCES.has(goal.cadence)),
    openQuestions: mappedQuestions,
    generatedGoalCount: mappedGoals.length,
    evidenceLinkCount: mappedGoals.reduce((count, goal) => count + goal.evidenceLinks.length, 0),
  };
}

export async function addKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    title: string;
    targetValue?: number | null;
    currentValue?: number | null;
    unit?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
    select: { id: true, workspaceId: true, archivedAt: true, ownerMemberId: true, status: true },
  });
  invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  invariant(goal.status === "DRAFT", 400, "INVALID_STATE", "Only draft goals can be edited.");
  await requireDraftManager({ actor, workspaceId: params.workspaceId, record: goal, resolvedMembership: membership });

  const progressPercent = keyResultProgress(params);

  const kr = await prisma.keyResult.create({
    data: {
      goalId: params.goalId,
      title,
      targetValue: params.targetValue || null,
      currentValue: params.currentValue || 0,
      unit: params.unit || null,
      progressPercent,
    },
  });

  await recomputeGoalProgress(params.goalId);

  return kr;
}

export async function updateKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    krId: string;
    title?: string;
    targetValue?: number | null;
    currentValue?: number | null;
    unit?: string | null;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const kr = await prisma.keyResult.findUnique({
    where: { id: params.krId },
    include: { goal: true },
  });
  invariant(kr && kr.goal.workspaceId === params.workspaceId && !kr.goal.archivedAt, 404, "NOT_FOUND", "Key Result not found.");
  invariant(kr.goal.status === "DRAFT", 400, "INVALID_STATE", "Only draft goals can be edited.");
  await requireDraftManager({ actor, workspaceId: params.workspaceId, record: kr.goal, resolvedMembership: membership });

  const data: any = {};
  if (params.title !== undefined) {
    const title = params.title.trim();
    invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");
    data.title = title;
  }
  if (params.targetValue !== undefined) data.targetValue = params.targetValue;
  if (params.currentValue !== undefined) data.currentValue = params.currentValue;
  if (params.unit !== undefined) data.unit = params.unit;

  const newTarget = params.targetValue !== undefined ? params.targetValue : kr.targetValue;
  const newCurrent = params.currentValue !== undefined ? params.currentValue : kr.currentValue;

  data.progressPercent = keyResultProgress({
    title: data.title ?? kr.title,
    targetValue: newTarget,
    currentValue: newCurrent,
  });

  const updated = await prisma.keyResult.update({
    where: { id: params.krId },
    data,
  });

  await recomputeGoalProgress(updated.goalId);

  return updated;
}

export async function deleteKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    krId: string;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const kr = await prisma.keyResult.findUnique({
    where: { id: params.krId },
    include: { goal: true },
  });
  invariant(kr && kr.goal.workspaceId === params.workspaceId && !kr.goal.archivedAt, 404, "NOT_FOUND", "Key Result not found.");
  invariant(kr.goal.status === "DRAFT", 400, "INVALID_STATE", "Only draft goals can be edited.");
  await requireDraftManager({ actor, workspaceId: params.workspaceId, record: kr.goal, resolvedMembership: membership });

  await prisma.keyResult.delete({ where: { id: params.krId } });
  await recomputeGoalProgress(kr.goalId);
}

export async function postGoalUpdate(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    bodyMd: string;
    authorMemberId?: string | null;
    statusChange?: GoalStatus | null;
    newProgress?: number | null;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
  });
  invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  const bodyMd = params.bodyMd.trim();
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Goal update body is required.");
  const newProgress = params.newProgress !== undefined && params.newProgress !== null
    ? clampProgressPercent(params.newProgress, "Goal progress")
    : null;

  if (params.authorMemberId) {
    const author = await prisma.member.findUnique({
      where: { id: params.authorMemberId },
      select: { workspaceId: true, isActive: true },
    });
    invariant(
      author && author.workspaceId === params.workspaceId && author.isActive,
      400,
      "INVALID_INPUT",
      "Goal update author must be an active member in the same workspace.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const update = await tx.goalUpdate.create({
      data: {
        goalId: params.goalId,
        bodyMd,
        authorMemberId: params.authorMemberId ?? membership?.id ?? null,
        statusChange: params.statusChange,
        newProgress,
      },
    });

    const updateData: any = {};
    if (params.statusChange) updateData.status = params.statusChange;
    if (newProgress !== null) updateData.progressPercent = newProgress;
    
    if (Object.keys(updateData).length > 0) {
      await tx.goal.update({
        where: { id: params.goalId },
        data: updateData,
      });

      if (updateData.progressPercent !== undefined && goal.parentGoalId) {
        // Since we update progress, trigger recompute for parent independently after transaction
        process.nextTick(() => recomputeGoalProgress(goal.parentGoalId!));
      }
    }

    return update;
  });
}

export async function createGoalLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    entityType: string;
    entityId: string;
    confidence?: number;
    linkedBy?: string;
    source?: string | null;
    metadata?: Prisma.InputJsonValue;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findUnique({
    where: { id: params.goalId },
  });
  invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  const confidence = clampConfidence(params.confidence) ?? 1;
  const linkedBy = params.linkedBy?.trim() || "human";
  const source = params.source?.trim() || null;

  return prisma.$transaction(async (tx) => {
    const link = await tx.goalLink.upsert({
      where: {
        goalId_entityType_entityId: {
          goalId: params.goalId,
          entityType: params.entityType,
          entityId: params.entityId,
        },
      },
      create: {
        goalId: params.goalId,
        entityType: params.entityType,
        entityId: params.entityId,
        confidence,
        linkedBy,
        source,
        metadata: params.metadata,
      },
      update: {
        confidence,
        linkedBy,
        source,
        metadata: params.metadata,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal-link.created",
        aggregateType: "GoalLink",
        aggregateId: link.id,
        payload: {
          goalId: link.goalId,
          entityType: link.entityType,
          entityId: link.entityId,
          confidence: link.confidence,
          source: link.source,
        },
      },
    ]);

    return link;
  });
}

export async function createGoalFinanceProjectLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    projectId: string;
    _membership?: MembershipSummary | null;
  },
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const project = await prisma.practiceProject.findFirst({
    where: {
      id: params.projectId,
      workspaceId: params.workspaceId,
    },
    select: { id: true },
  });
  invariant(project, 404, "NOT_FOUND", "Practice project not found.");

  return createGoalLink(actor, {
    workspaceId: params.workspaceId,
    goalId: params.goalId,
    entityType: GOAL_FINANCE_PROJECT_ENTITY_TYPE,
    entityId: params.projectId,
    confidence: 1,
    linkedBy: "human",
    source: GOAL_FINANCE_PROJECT_SOURCE,
    _membership: membership,
  });
}

export async function listGoalFinanceProjectLinks(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalIds: string[];
    _membership?: MembershipSummary | null;
  },
): Promise<GoalFinanceProjectLink[]> {
  const goalIds = Array.from(new Set(params.goalIds.map((id) => id.trim()).filter(Boolean)));
  if (goalIds.length === 0) return [];

  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const links = await prisma.goalLink.findMany({
    where: {
      goalId: { in: goalIds },
      entityType: GOAL_FINANCE_PROJECT_ENTITY_TYPE,
      goal: {
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
    },
    select: {
      id: true,
      goalId: true,
      entityId: true,
      confidence: true,
      source: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (links.length === 0) return [];

  const projectIds = Array.from(new Set(links.map((link) => link.entityId)));
  const projectHealthById = await listNativePracticeProjectHealthByIds(actor, params.workspaceId, projectIds);

  return links.flatMap((link) => {
    const health = projectHealthById.get(link.entityId);
    if (!health) return [];
    return [{
      id: link.id,
      goalId: link.goalId,
      entityId: link.entityId,
      confidence: link.confidence,
      source: link.source,
      createdAt: link.createdAt,
      project: {
        id: health.projectId,
        code: health.projectCode,
        name: health.projectName,
        clientName: health.clientName,
        status: health.status,
        poValueCents: health.budgetCents,
        usedCents: health.usedBudgetCents,
        remainingCents: health.remainingBudgetCents,
        serviceBudgetCents: health.serviceBudgetCents,
        expenseBudgetCents: health.expenseBudgetCents,
        weeklyBurnCents: health.recentBudgetBurnPerWeekCents,
        usedRatio: health.budgetCents > 0 ? Math.max(health.usedBudgetCents / health.budgetCents, 0) : 0,
        budgetRunwayWeeks: health.weeksToBudgetExhaustion,
        targetMarginBps: health.targetMarginBps,
        currentMarginBps: health.grossMarginBps,
      },
    }];
  });
}

export async function deleteGoalFinanceProjectLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    linkId: string;
    _membership?: MembershipSummary | null;
  },
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const link = await prisma.goalLink.findUnique({
    where: { id: params.linkId },
    include: { goal: true },
  });
  invariant(
    link
      && link.goal.workspaceId === params.workspaceId
      && link.entityType === GOAL_FINANCE_PROJECT_ENTITY_TYPE,
    404,
    "NOT_FOUND",
    "Link not found.",
  );

  await prisma.goalLink.delete({ where: { id: params.linkId } });
}

export async function deleteGoalLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    linkId: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const link = await prisma.goalLink.findUnique({
    where: { id: params.linkId },
    include: { goal: true },
  });
  invariant(link && link.goal.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Link not found.");

  await prisma.goalLink.delete({ where: { id: params.linkId } });
}

export async function findGoalLinksForEntity(entityType: string, entityId: string) {
  return prisma.goalLink.findMany({
    where: {
      entityType,
      entityId,
    },
    include: {
      goal: true,
    },
  });
}

export async function recomputeGoalProgress(goalId: string) {
  const goal = await prisma.goal.findUnique({
    where: { id: goalId },
    include: {
      keyResults: true,
      childGoals: true,
    },
  });

  if (!goal) return;

  let computedProgress = 0;

  if (goal.keyResults.length > 0) {
    const total = goal.keyResults.reduce((acc, kr) => acc + kr.progressPercent, 0);
    computedProgress = Math.round(total / goal.keyResults.length);
  } else if (goal.childGoals.length > 0) {
    const total = goal.childGoals.reduce((acc, g) => acc + g.progressPercent, 0);
    computedProgress = Math.round(total / goal.childGoals.length);
  } else {
    // leave as is if no drivers
    computedProgress = goal.progressPercent;
  }

  if (computedProgress !== goal.progressPercent) {
    await prisma.goal.update({
      where: { id: goalId },
      data: { progressPercent: computedProgress },
    });

    if (goal.parentGoalId) {
      await recomputeGoalProgress(goal.parentGoalId);
    }
  }
}

export async function getGoalTree(actor: AppActor, workspaceId: string, opts?: { cadence?: GoalCadence }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  
  const query: any = { workspaceId, archivedAt: null };
  if (opts?.cadence) query.cadence = opts.cadence;
  
  const allGoals = await prisma.goal.findMany({
    where: query,
    include: {
      ownerMember: { include: { user: { select: { displayName: true, email: true } } } },
      keyResults: true,
      circle: true,
    },
    orderBy: { sortOrder: "asc" }
  });

  const goalsById = new Map<string, any>();
  for (const g of allGoals) {
    goalsById.set(g.id, { ...g, childGoals: [] });
  }

  const rootGoals: any[] = [];
  for (const g of allGoals) {
    const mapped = goalsById.get(g.id);
    if (g.parentGoalId && goalsById.has(g.parentGoalId)) {
      goalsById.get(g.parentGoalId).childGoals.push(mapped);
    } else {
      rootGoals.push(mapped);
    }
  }

  return rootGoals;
}

export async function getMyGoalSlice(actor: AppActor, memberId: string, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const myGoals = await prisma.goal.findMany({
    where: {
      workspaceId,
      ownerMemberId: memberId,
      archivedAt: null,
      status: { in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] },
    },
    include: {
      circle: true,
      parentGoal: {
        include: {
          circle: true,
          parentGoal: {
            include: { circle: true },
          },
        },
      },
    },
    orderBy: [
      { targetDate: "asc" },
      { updatedAt: "desc" },
    ],
  });

  return myGoals;
}

export async function createRecognition(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId?: string | null;
    recipientMemberId: string;
    title: string;
    storyMd: string;
    valueTags?: string[];
    visibility?: string;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.recognition.create({
    data: {
      workspaceId: params.workspaceId,
      goalId: params.goalId || null,
      recipientMemberId: params.recipientMemberId,
      authorMemberId: membership!.id,
      title: params.title,
      storyMd: params.storyMd,
      valueTags: params.valueTags || [],
      visibility: params.visibility || "WORKSPACE",
    },
  });
}

export async function listRecognitions(
  actor: AppActor,
  params: {
    workspaceId: string;
    recipientMemberId?: string;
    _membership?: MembershipSummary | null;
  }
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const query: any = { workspaceId: params.workspaceId };
  if (params.recipientMemberId) query.recipientMemberId = params.recipientMemberId;

  return prisma.recognition.findMany({
    where: query,
    include: {
      author: { include: { user: { select: { displayName: true } } } },
      recipient: { include: { user: { select: { displayName: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
}
