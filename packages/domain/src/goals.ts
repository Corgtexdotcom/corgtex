import { requireCreationInputRoots } from "./draft-permissions";
import { randomUUID } from "node:crypto";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { appendEvents } from "./events";
import { actorUserIdForWorkspace, requireWorkspaceMembership } from "./auth";
import { recordAudit } from "./audit-trail";
import { archiveFilterWhere, type ArchiveFilter } from "./archive";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import { invariant } from "./errors";
import { captureHumanArtifactInputAdvance, advanceHumanArtifactInputLineage, readableArtifactIds, readableBrainSourceIds, type LineageInput, type LineageRoot } from "./source-lineage";
import { DigestReadRelease, captureReadableDigestInputs } from "./digest-lineage";
import { privacyFilter } from "./privacy";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import {
  requireCollaborativeWorkItemEditor,
  requirePrivateDraftEditor,
} from "./collaborative-permissions";
import { humanMemberIdentityWhere } from "./member-identity";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardMergeText,
  normalizeDuplicateGuardText,
  type DuplicateGuardOptions,
} from "./duplicate-guard";
import type { Circle, Goal, GoalLevel, GoalCadence, GoalStatus, Prisma } from "@prisma/client";
import {
  acquireWorkItemAdvisoryLock,
  changedDataFields,
  pickJsonSnapshot,
  recordWorkItemVersion,
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
  authorMemberId?: string | null;
  isPrivate?: boolean;
  keyResults?: GoalKeyResultInput[];
  duplicateGuard?: DuplicateGuardOptions | null;
  _membership?: MembershipSummary | null;
  lineageInputs?: LineageInput[];
  lineageRoots?: LineageRoot[];
};

const COMPANY_UNDERSTANDING_SOURCE = "company-understanding";
const SHORT_TERM_DIRECTION_CADENCES = new Set<GoalCadence>(["WEEKLY", "MONTHLY", "QUARTERLY"]);
const EDITABLE_ACTIVE_GOAL_STATUSES = new Set<GoalStatus>(["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"]);

function countsTowardParentProgress(goal: Pick<Goal, "status" | "isPrivate" | "archivedAt">) {
  return !goal.archivedAt && !(goal.isPrivate && goal.status === "DRAFT");
}

function sortedGoalIds(goalIds: Iterable<string | null | undefined>) {
  return [...new Set([...goalIds].filter((id): id is string => Boolean(id)))].sort();
}

async function acquireGoalAdvisoryLocks(
  tx: Prisma.TransactionClient,
  goalIds: Iterable<string | null | undefined>,
) {
  const sortedIds = sortedGoalIds(goalIds);
  for (const goalId of sortedIds) {
    await acquireWorkItemAdvisoryLock(tx, "Goal", goalId);
  }
  return sortedIds;
}

async function recomputeGoalParentsInTransaction(
  tx: Prisma.TransactionClient,
  parentGoalIds: Iterable<string | null | undefined>,
  actor?: AppActor,
) {
  const sortedIds = await acquireGoalAdvisoryLocks(tx, parentGoalIds);
  for (const goalId of sortedIds) {
    await recomputeGoalProgress(goalId, actor, tx);
  }
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
}

async function lockGoalForAuthorizedMutation(
  tx: Prisma.TransactionClient,
  goal: {
    id: string;
    workspaceId: string;
    archivedAt?: Date | null;
    isPrivate?: boolean | null;
    status: GoalStatus;
    updatedAt?: Date;
  },
) {
  try {
    await tx.goal.update({
      where: {
        id: goal.id,
        workspaceId: goal.workspaceId,
        archivedAt: null,
        status: goal.status,
        isPrivate: goal.isPrivate ?? false,
      },
      data: { updatedAt: goal.updatedAt ?? new Date() },
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaNotFoundError(error)) {
      invariant(false, 409, "CONFLICT", "Goal changed while editing. Refresh and try again.");
    }
    throw error;
  }
}

async function lockGoalForKeyResultMutation(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  goal: {
    id: string;
    workspaceId: string;
    archivedAt?: Date | null;
    authorUserId?: string | null;
    isPrivate?: boolean | null;
    status: GoalStatus;
    updatedAt?: Date;
  },
) {
  requireEditableGoalKeyResults(actor, membership, goal);
  await lockGoalForAuthorizedMutation(tx, goal);
}

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
      authorUserId: true,
      isPrivate: true,
      publishedAt: true,
      status: true,
      progressPercent: true,
      version: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  invariant(goal && goal.workspaceId === workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
  return goal;
}

async function validateGoalReferences(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
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
      select: {
        workspaceId: true,
        archivedAt: true,
        authorUserId: true,
        isPrivate: true,
        status: true,
      },
    });
    invariant(
      parentGoal
        && parentGoal.workspaceId === params.workspaceId
        && !parentGoal.archivedAt
        && canReadGoalRecord(actor, membership, parentGoal),
      400,
      "INVALID_INPUT",
      "Parent goal must be a visible active goal in the same workspace.",
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

function requireEditableGoalContent(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  goal: {
    status: GoalStatus;
    archivedAt?: Date | null;
    isPrivate?: boolean | null;
    authorUserId?: string | null;
  },
  activeStateMessage: string,
) {
  if (goal.status === "DRAFT") {
    requirePrivateDraftEditor(actor, membership, goal);
    return;
  }
  invariant(EDITABLE_ACTIVE_GOAL_STATUSES.has(goal.status), 400, "INVALID_STATE", activeStateMessage);
  requireCollaborativeWorkItemEditor(actor, membership, goal);
}

function requireEditableGoalKeyResults(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  goal: {
    status: GoalStatus;
    archivedAt?: Date | null;
    isPrivate?: boolean | null;
    authorUserId?: string | null;
  },
) {
  requireEditableGoalContent(actor, membership, goal, "Only draft or active goals can change key results.");
}

function canReadGoalRecord(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  goal: {
    isPrivate?: boolean | null;
    status?: GoalStatus | null;
    authorUserId?: string | null;
  },
) {
  if (goal.isPrivate !== true) return true;
  if (goal.status !== "DRAFT") return false;
  if (actor.kind !== "user" || !membership?.isActive || membership.userId !== actor.user.id) return false;
  if (membership?.role === "ADMIN") return true;
  return actor.kind === "user" && goal.authorUserId === actor.user.id;
}

type GoalParentVisibilityRecord = Pick<Goal, "id" | "isPrivate" | "status" | "authorUserId"> & {
  circle?: Circle | null;
  parentGoal?: GoalParentVisibilityRecord | null;
};

async function readableGoalParents<T extends GoalParentVisibilityRecord>(
  release: DigestReadRelease, actor: AppActor, membership: MembershipSummary | null | undefined, goal: T,
): Promise<T> {
  const circle = goal.circle ? (await release.capture("Circle", [goal.circle])).records[0] ?? null : null;
  let parentGoal: GoalParentVisibilityRecord | null = null;
  if (goal.parentGoal && canReadGoalRecord(actor, membership, goal.parentGoal)
    && (await release.capture("Goal", [goal.parentGoal])).records.length) {
    parentGoal = await readableGoalParents(release, actor, membership, goal.parentGoal);
  }
  return {...goal, circle, ...(goal.parentGoal !== undefined ? {parentGoal} : {})};
}


async function createGoalKeyResultsWithLineage(tx: Prisma.TransactionClient, actor: AppActor,
  params: CreateGoalParams, goalId: string, keyResults: Prisma.KeyResultCreateManyInput[]) {
  const now = new Date();
  const rows = keyResults.map((keyResult) => ({ ...keyResult, goalId, id: randomUUID(),
    targetValue: keyResult.targetValue ?? null, currentValue: keyResult.currentValue ?? 0,
    unit: keyResult.unit ?? null, progressPercent: keyResult.progressPercent ?? 0,
    sortOrder: keyResult.sortOrder ?? 0, createdAt: now, updatedAt: now }));
  const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
  await tx.keyResult.createMany({ data: rows });
  for (const row of rows) await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "KeyResult", id: row.id }, content: row, receipt });
  return rows;
}

async function appendMissingDuplicateGoalKeyResults(
  actor: AppActor,
  params: CreateGoalParams,
  goalId: string,
  membership: MembershipSummary | null | undefined,
) {
  const keyResults = normalizeKeyResults(params.keyResults);
  if (keyResults.length === 0) return false;

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", goalId);
    const goal = await assertGoalInWorkspace(tx, params.workspaceId, goalId);
    await acquireGoalAdvisoryLocks(tx, [goal.parentGoalId]);
    await lockGoalForKeyResultMutation(tx, actor, membership, goal);

    const existingKeyResults = await tx.keyResult.findMany({
      where: { goalId },
      orderBy: { sortOrder: "asc" },
    });
    const existingTitles = new Set(existingKeyResults.map((keyResult) => normalizeDuplicateGuardText(keyResult.title)));
    const missingKeyResults = keyResults.filter((keyResult) => !existingTitles.has(normalizeDuplicateGuardText(keyResult.title)));
    if (missingKeyResults.length === 0) return false;

    const maxSortOrder = existingKeyResults.reduce((max, keyResult) => Math.max(max, keyResult.sortOrder ?? 0), -1);
    const addedRows = await createGoalKeyResultsWithLineage(tx, actor, params, goalId, missingKeyResults.map((keyResult, index) => ({
        ...keyResult,
        goalId,
        sortOrder: maxSortOrder + index + 1,
      })));

    const progressInputs = [...existingKeyResults, ...addedRows].map((keyResult) => ({
      kind: "KeyResult" as const, id: keyResult.id, snapshot: keyResult,
    }));
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Goal", id: goal.id }, before: goal, completeCopy: true,
      dependencies: progressInputs, snapshotDependencies: progressInputs });
    const progressValues = [
      ...existingKeyResults.map((keyResult) => keyResult.progressPercent ?? 0),
      ...missingKeyResults.map((keyResult) => keyResult.progressPercent),
    ];
    const progressPercent = Math.round(progressValues.reduce((total, value) => total + value, 0) / progressValues.length);
    const newVersion = await recordWorkItemVersion(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      currentVersion: goal.version,
      changedFields: ["keyResults", "progressPercent"],
      previousState: pickJsonSnapshot(goal as unknown as Record<string, unknown>, [
        "id",
        "workspaceId",
        "title",
        "descriptionMd",
        "level",
        "cadence",
        "progressPercent",
        "targetDate",
        "startDate",
        "parentGoalId",
        "circleId",
        "ownerMemberId",
        "authorUserId",
        "isPrivate",
        "publishedAt",
        "status",
        "version",
      ]),
    });
    const updated = await tx.goal.update({
      where: { id: goalId, version: goal.version },
      data: { progressPercent, version: newVersion },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Goal", id: goal.id }, content: updated, receipt });


    await recomputeGoalParentsInTransaction(tx, [goal.parentGoalId], actor);

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.updated",
      entityType: "Goal",
      entityId: updated.id,
      meta: {
        fields: ["keyResults", "progressPercent"],
        reason: "duplicate_guard_update",
        addedKeyResultCount: missingKeyResults.length,
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "goal.updated",
        aggregateType: "Goal",
        aggregateId: updated.id,
        payload: {
          goalId: updated.id,
          fields: ["keyResults", "progressPercent"],
        },
      },
    ]);

    return true;
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
  const requestedStatus = params.status ?? (actor.kind === "agent" ? "ACTIVE" : "DRAFT");
  const isPrivate = params.isPrivate ?? (requestedStatus === "DRAFT");
  params = { ...params, lineageRoots: await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate, roots: params.lineageRoots }) };

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
    includePrivate: actor.kind === "user" && membership?.role === "ADMIN",
  }, params.duplicateGuard, undefined, async (rows) => {
    const records = rows as Array<{ id: string; [key: string]: unknown }>;
    const visible = await readableArtifactIds(actor, params.workspaceId, "Goal", records);
    return records.filter((record) => visible.has(record.id));
  });
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
      lineageInputs: params.lineageInputs,
      lineageRoots: params.lineageRoots,
    };
    if ((mergedDescription ?? null) !== (existing.descriptionMd ?? null)) updateParams.descriptionMd = mergedDescription;
    if (!existing.ownerMemberId && params.ownerMemberId) updateParams.ownerMemberId = params.ownerMemberId;
    if (!existing.circleId && params.circleId) updateParams.circleId = params.circleId;
    if (!existing.parentGoalId && params.parentGoalId) updateParams.parentGoalId = params.parentGoalId;
    if (!existing.targetDate && params.targetDate) updateParams.targetDate = params.targetDate;
    if (!existing.startDate && params.startDate) updateParams.startDate = params.startDate;
    if (params.cadence && existing.cadence !== params.cadence) updateParams.cadence = params.cadence;
    if (params.level && existing.level !== params.level) updateParams.level = params.level;
    if (params.status && existing.status !== params.status) updateParams.status = params.status;
    const updatedFields = Object.keys(updateParams).some((field) => !["workspaceId", "goalId", "_membership", "lineageInputs", "lineageRoots"].includes(field));
    if (updatedFields) {
      updateParams.expectedVersion = existing.version;
      await updateGoal(actor, updateParams);
    }
    const addedKeyResults = await appendMissingDuplicateGoalKeyResults(actor, params, duplicateDecision.match.entityId, membership);
    return updatedFields || addedKeyResults
      ? getGoal(actor, { workspaceId: params.workspaceId, goalId: duplicateDecision.match.entityId, _membership: params._membership })
      : existing;
  }

  return prisma.$transaction(async (tx) => {
    await requireCreationInputRoots({ actor, workspaceId: params.workspaceId, isPrivate, roots: params.lineageRoots, tx });
    await validateGoalReferences(tx, actor, membership, params);
    const keyResults = normalizeKeyResults(params.keyResults);
    const progressPercent = keyResults.length > 0
      ? Math.round(keyResults.reduce((total, keyResult) => total + keyResult.progressPercent, 0) / keyResults.length)
      : 0;
    const status = isPrivate
      ? "DRAFT"
      : requestedStatus === "DRAFT"
        ? "ACTIVE"
        : requestedStatus;
    let authorUserId = actor.kind === "user"
      ? actor.user.id
      : await actorUserIdForWorkspace(actor, params.workspaceId);
    if (actor.kind === "agent" && params.authorMemberId) {
      authorUserId = await resolveWorkspaceMemberUserId(tx, params.workspaceId, params.authorMemberId, "Goal author must be an active member of this workspace.");
    }

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    const goal = await tx.goal.create({
      data: {
        workspaceId: params.workspaceId,
        authorUserId,
        title,
        descriptionMd: params.descriptionMd || null,
        level: params.level ?? "COMPANY",
        cadence: params.cadence ?? "QUARTERLY",
        status,
        isPrivate,
        publishedAt: isPrivate ? null : new Date(),
        progressPercent,
        targetDate: params.targetDate || null,
        startDate: params.startDate || null,
        parentGoalId: params.parentGoalId || null,
        circleId: params.circleId || null,
        ownerMemberId: params.ownerMemberId || null,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Goal", id: goal.id }, content: goal, receipt });

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Goal", goal),
    });

    if (keyResults.length > 0) {
      await createGoalKeyResultsWithLineage(tx, actor, params, goal.id, keyResults.map((keyResult) => ({ goalId: goal.id, ...keyResult })));
    }

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "goal.created",
      entityType: "Goal",
      entityId: goal.id,
      meta: goal.isPrivate
        ? { isPrivate: true }
        : { title: goal.title, ...duplicateGuardAuditMeta(duplicateDecision) },
    });

    if (!goal.isPrivate) {
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
    }

    return goal;
  });
}

export async function updateGoal(
  actor: AppActor,
  params: ProducerLineageParams & {
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
    expectedVersion?: number;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", params.goalId);
    const goal = await assertGoalInWorkspace(tx, params.workspaceId, params.goalId);
    invariant((await readableArtifactIds(actor, params.workspaceId, "Goal", [goal], tx)).has(goal.id),
      404, "NOT_FOUND", "Goal not found.");
    const parentGoalIdsToRecompute = new Set<string>();
    if (
      params.parentGoalId !== undefined
      || params.progressPercent !== undefined
      || params.status !== undefined
    ) {
      if (goal.parentGoalId) parentGoalIdsToRecompute.add(goal.parentGoalId);
      if (params.parentGoalId) parentGoalIdsToRecompute.add(params.parentGoalId);
    }
    await acquireGoalAdvisoryLocks(tx, parentGoalIdsToRecompute);
    await validateGoalReferences(tx, actor, membership, {
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
    const editsContent = editsDraftContent || params.progressPercent !== undefined;
    const changesWorkflow = params.status !== undefined || params.progressPercent !== undefined;

    if (editsDraftContent) {
      if (goal.status === "DRAFT") {
        requirePrivateDraftEditor(actor, membership, goal);
      } else {
        invariant(EDITABLE_ACTIVE_GOAL_STATUSES.has(goal.status), 400, "INVALID_STATE", "Only draft or active goals can be edited.");
        requireCollaborativeWorkItemEditor(actor, membership, goal);
      }
    }
    if (changesWorkflow) {
      if (params.status === "DRAFT") {
        invariant(EDITABLE_ACTIVE_GOAL_STATUSES.has(goal.status), 400, "INVALID_STATE", "Only active goals can be returned to draft.");
        requirePrivateDraftEditor(actor, membership, goal);
      } else if (goal.status === "COMPLETED" || goal.status === "ABANDONED") {
        invariant(params.progressPercent === undefined && params.status === undefined, 400, "INVALID_STATE", "Completed or abandoned goals cannot be changed.");
      } else if (goal.status === "DRAFT") {
        requirePrivateDraftEditor(actor, membership, goal);
      } else {
        invariant(EDITABLE_ACTIVE_GOAL_STATUSES.has(goal.status), 400, "INVALID_STATE", "Only draft or active goals can change workflow state.");
        requireCollaborativeWorkItemEditor(actor, membership, goal);
      }
    }
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Goal title is required.");
      data.title = title;
    }
    if (params.descriptionMd !== undefined) data.descriptionMd = params.descriptionMd || null;
    if (params.level !== undefined) data.level = params.level;
    if (params.cadence !== undefined) data.cadence = params.cadence;
    if (params.status !== undefined) {
      data.status = params.status;
      if (params.status === "DRAFT") {
        data.isPrivate = true;
        data.publishedAt = null;
      } else {
        data.isPrivate = false;
        data.publishedAt = goal.publishedAt || new Date();
      }
    }
    if (params.progressPercent !== undefined) data.progressPercent = clampProgressPercent(params.progressPercent);
    if (params.targetDate !== undefined) data.targetDate = params.targetDate || null;
    if (params.startDate !== undefined) data.startDate = params.startDate || null;
    if (params.parentGoalId !== undefined) data.parentGoalId = params.parentGoalId || null;
    if (params.circleId !== undefined) data.circleId = params.circleId || null;
    if (params.ownerMemberId !== undefined) data.ownerMemberId = params.ownerMemberId || null;

    if (editsContent) {
      invariant(params.expectedVersion !== undefined, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
    }
    if (params.expectedVersion !== undefined) {
      invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
      invariant(params.expectedVersion === goal.version, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
    }

    const contentFields = ["title", "descriptionMd", "level", "cadence", "progressPercent", "targetDate", "startDate", "parentGoalId", "circleId", "ownerMemberId"];
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
          "progressPercent",
          "targetDate",
          "startDate",
          "parentGoalId",
          "circleId",
          "ownerMemberId",
          "authorUserId",
          "isPrivate",
          "publishedAt",
          "status",
          "version",
        ]),
      });
    }
    const changedUpdateFields = changedDataFields(goal as unknown as Record<string, unknown>, data);
    if (changedUpdateFields.length === 0) return goal;

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Goal", id: goal.id }, before: goal, capture: params });
    let updated: typeof goal;
    try {
      updated = await tx.goal.update({
        where: {
          id: params.goalId,
          workspaceId: params.workspaceId,
          archivedAt: null,
          status: goal.status,
          isPrivate: goal.isPrivate,
          version: params.expectedVersion ?? goal.version,
        },
        data,
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
      }
      throw error;
    }
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Goal", id: goal.id }, content: updated, receipt });
    if (
      changedUpdateFields.includes("parentGoalId")
      || changedUpdateFields.includes("progressPercent")
      || countsTowardParentProgress(goal) !== countsTowardParentProgress(updated)
    ) {
      if (goal.parentGoalId) parentGoalIdsToRecompute.add(goal.parentGoalId);
      if (updated.parentGoalId) parentGoalIdsToRecompute.add(updated.parentGoalId);
    }

    await recomputeGoalParentsInTransaction(tx, parentGoalIdsToRecompute, actor);

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
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", params.goalId);

    const goal = await tx.goal.findFirst({
      where: {
        id: params.goalId,
        workspaceId: params.workspaceId,
        ...(params.includeArchived ? {} : { archivedAt: null }),
      },
    });
    invariant(goal, 404, "NOT_FOUND", "Goal not found.");
    if (goal.status === "DRAFT" || goal.isPrivate) {
      requirePrivateDraftEditor(actor, membership, goal);
    } else {
      requireCollaborativeWorkItemEditor(actor, membership, goal);
    }

    if (goal.archivedAt) {
      return;
    }

    const previousState = JSON.parse(JSON.stringify(goal)) as Prisma.InputJsonObject;
    const archivedAt = new Date();
    const actorUserId = actor.kind === "user" ? actor.user.id : null;
    const actorLabel = actor.kind === "user"
      ? (actor.user.displayName || actor.user.email || actor.user.id)
      : (actor.label || actor.authProvider || "agent");

    await tx.goal.update({
      where: { id: goal.id },
      data: {
        archivedAt,
        archivedByUserId: actorUserId,
        archiveReason: "Archived from goal delete path.",
      },
    });

    if (goal.parentGoalId) {
      await recomputeGoalProgress(goal.parentGoalId, actor, tx);
    }

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Goal",
      entityId: goal.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Goal", goal),
    });

    await tx.workspaceArchiveRecord.create({
      data: {
        workspaceId: params.workspaceId,
        entityType: "Goal",
        entityId: goal.id,
        entityLabel: goal.title ?? goal.id,
        previousState: previousState as Prisma.InputJsonObject,
        archiveReason: "Archived from goal delete path.",
        archivedByUserId: actorUserId,
        archivedByLabel: actorLabel,
        archivedAt,
      },
    });

    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "workspace-artifact.archived",
      entityType: "Goal",
      entityId: goal.id,
      meta: {
        label: goal.title ?? goal.id,
        reason: "Archived from goal delete path.",
      },
    });
  });
}

const goalReaderUserSelect = {
  id: true, displayName: true, email: true, bio: true, avatarUrl: true,
  linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true,
} satisfies Prisma.UserSelect;
const goalReaderMemberInclude = { user: { select: goalReaderUserSelect } } satisfies Prisma.MemberInclude;
type GoalReaderMember = Prisma.MemberGetPayload<{ include: typeof goalReaderMemberInclude }>;

async function readableGoalMember(release: DigestReadRelease, member: GoalReaderMember | null) {
  if (!member) return null;
  const user = member.user;
  const canonical = { ...member, user: { id: user.id, displayName: user.displayName, email: user.email } };
  if (!(await release.capture("Member", [canonical])).records.length) return null;
  if (!(await release.capture("User", [user])).records.length) return null;
  return { ...member, user: { displayName: user.displayName, email: user.email } };
}

function goalReadRelease(actor: AppActor, workspaceId: string, release?: DigestReadRelease) {
  invariant(!release || release.actor === actor && release.workspaceId === workspaceId,
    409, "SOURCE_CHANGED", "Goal read collection scope changed.");
  return release ?? new DigestReadRelease(actor, workspaceId);
}

export async function getGoal(
  actor: AppActor,
  params: {
    workspaceId: string;
    goalId: string;
    includeArchived?: boolean;
    _membership?: MembershipSummary | null;
  },
  readRelease?: DigestReadRelease,
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const goal = await prisma.goal.findFirst({
    where: {
      id: params.goalId,
      workspaceId: params.workspaceId,
      ...privacyFilter(actor, membership),
      ...(params.includeArchived ? {} : { archivedAt: null }),
    },
    include: {
      ownerMember: { include: goalReaderMemberInclude },
      childGoals: { where: { ...privacyFilter(actor, membership), archivedAt: null } },
      keyResults: { orderBy: { sortOrder: "asc" } },
      updates: { orderBy: { createdAt: "desc" }, include: { authorMember: { include: goalReaderMemberInclude } } },
    },
  });

  invariant(goal, 404, "NOT_FOUND", "Goal not found.");
  const release = goalReadRelease(actor, params.workspaceId, readRelease);
  invariant((await release.capture("Goal", [goal])).records.length, 404, "NOT_FOUND", "Goal not found.");
  const childGoals = (await release.capture("Goal", goal.childGoals ?? [])).records;
  const keyResults = (await release.capture("KeyResult", goal.keyResults ?? [])).records;
  const admittedUpdates = (await release.capture("GoalUpdate", goal.updates ?? [])).records;
  const ownerMember = await readableGoalMember(release, goal.ownerMember);
  const updates = [];
  for (const update of admittedUpdates) updates.push({ ...update, authorMember: await readableGoalMember(release, update.authorMember) });
  return release.finish({ ...goal, ownerMember, childGoals, keyResults, updates });
}

type ListGoalsParams = {
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
};

/** A fixed bounded candidate window; the cursor follows the last consumed row. */
export async function listGoalsPage(actor: AppActor, params: ListGoalsParams & {cursor?: string}, readRelease?: DigestReadRelease) {
  const membership = await requireWorkspaceMembership({actor, workspaceId:params.workspaceId, resolvedMembership:params._membership});
  const take = params.take ?? 100, skip = params.skip ?? 0;
  invariant(Number.isSafeInteger(take) && take > 0 && take <= 200 && Number.isSafeInteger(skip) && skip >= 0 && skip <= 200,
    400, "INVALID_INPUT", "Invalid goal window.");
  const query: Prisma.GoalWhereInput = {workspaceId:params.workspaceId,...privacyFilter(actor,membership),...archiveFilterWhere(params.archiveFilter)};
  if(params.level!==undefined)query.level=params.level;
  if(params.cadence!==undefined)query.cadence=params.cadence;
  if(params.circleId!==undefined)query.circleId=params.circleId;
  if(params.ownerMemberId!==undefined)query.ownerMemberId=params.ownerMemberId;
  if(params.status!==undefined)query.status=params.status;
  if(params.parentGoalId!==undefined)query.parentGoalId=params.parentGoalId;
  const scope=JSON.stringify([params.workspaceId,params.level,params.cadence,
    params.circleId===undefined?"*":params.circleId,params.ownerMemberId===undefined?"*":params.ownerMemberId,
    params.status,params.parentGoalId===undefined?"*":params.parentGoalId,params.archiveFilter??"active"]);
  let after:Pick<Goal,"id"|"sortOrder"|"createdAt">|undefined;
  if(params.cursor!==undefined) {
    try {
      invariant(params.cursor.length<=4096&&/^[A-Za-z0-9_-]+$/.test(params.cursor),400,"INVALID_INPUT","Invalid goal cursor.");
      const value=JSON.parse(Buffer.from(params.cursor,"base64url").toString("utf8"));
      invariant(value?.purpose==="goals-window-v1"&&value.scope===scope&&typeof value.id==="string"&&value.id.length>0&&value.id.length<=256
        &&Number.isSafeInteger(value.sortOrder)&&typeof value.createdAt==="string"&&Number.isFinite(Date.parse(value.createdAt)),400,"INVALID_INPUT","Invalid goal cursor.");
      after={id:value.id,sortOrder:value.sortOrder,createdAt:new Date(value.createdAt)};
    }catch{invariant(false,400,"INVALID_INPUT","Invalid goal cursor.");}
  }
  const release=goalReadRelease(actor,params.workspaceId,readRelease);
  const include={ownerMember:{include:goalReaderMemberInclude},keyResults:true,circle:true} satisfies Prisma.GoalInclude;
  const candidates=await prisma.goal.findMany({where:{AND:[query,...(after?[{OR:[
    {sortOrder:{gt:after.sortOrder}},
    {sortOrder:after.sortOrder,createdAt:{lt:after.createdAt}},
    {sortOrder:after.sortOrder,createdAt:after.createdAt,id:{gt:after.id}},
  ]}]:[])]},orderBy:[{sortOrder:"asc"},{createdAt:"desc"},{id:"asc"}],take:200,include});
  const selected:typeof candidates=[];
  let visible=0,lastIndex=-1;
  for(let offset=0;offset<candidates.length&&selected.length<take;offset+=100){
    const batch=candidates.slice(offset,offset+100);
    const captured=await release.observeRead(()=>captureReadableDigestInputs({actor,workspaceId:params.workspaceId,kind:"Goal",records:batch}));
    for(let i=0;i<batch.length;i++){
      lastIndex=offset+i;
      const goal=batch[i];const proof=captured.proofs.get(goal.id);
      if(!proof)continue;
      if(visible++<skip)continue;
      selected.push(goal);release.add(proof);
      if(selected.length===take)break;
    }
  }
  const complete=candidates.length<200&&lastIndex===candidates.length-1;
  const last=candidates[lastIndex];
  const nextCursor=complete||!last?null:Buffer.from(JSON.stringify({purpose:"goals-window-v1",scope,id:last.id,
    sortOrder:last.sortOrder,createdAt:last.createdAt.toISOString()})).toString("base64url");
  const items=[];
  for(const goal of selected)items.push({...goal,
    ownerMember:await readableGoalMember(release,goal.ownerMember),
    circle:goal.circle&&(await release.capture("Circle",[goal.circle])).records[0]||null,
    keyResults:(await release.capture("KeyResult",goal.keyResults??[])).records,
  });
  return release.finish({items,complete,nextCursor});
}

/** Compatibility callers requesting an exact array must not receive a truncated result. */
export async function listGoals(actor:AppActor,params:ListGoalsParams){
  if(params.take===0){
    await requireWorkspaceMembership({actor,workspaceId:params.workspaceId,resolvedMembership:params._membership});
    return new DigestReadRelease(actor,params.workspaceId).finish([]);
  }
  const page=await listGoalsPage(actor,{...params,take:params.take??200});
  invariant(page.complete||(params.take!==undefined&&page.items.length===params.take),409,"SOURCE_READ_SCAN_LIMIT","Goal list is incomplete; use the bounded goal window.");
  return page.items;
}

/** Build only the admitted window; a parent outside it is deliberately not fetched. */
export function buildGoalTree<T extends {id:string;parentGoalId:string|null}>(goals:T[]){
  type Node=T&{childGoals:Node[]};
  const byId=new Map<string,Node>(goals.map(goal=>[goal.id,{...goal,childGoals:[]}]));
  const roots:Node[]=[];
  for(const goal of goals){
    const row=byId.get(goal.id)!;
    if(goal.parentGoalId&&byId.has(goal.parentGoalId))byId.get(goal.parentGoalId)!.childGoals.push(row);
    else roots.push(row);
  }
  return roots;
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
        ...privacyFilter(actor, membership),
        archivedAt: null,
        links: {
          some: {
            source: COMPANY_UNDERSTANDING_SOURCE,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
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
        })
      : Promise.resolve([]),
  ]);

  const [visibleGoalIds, visibleQuestionIds] = await Promise.all([
    readableArtifactIds(actor, params.workspaceId, "Goal", goals),
    readableArtifactIds(actor, params.workspaceId, "CheckIn", questions),
  ]);
  const visibleGoals = goals.filter((goal) => visibleGoalIds.has(goal.id)).slice(0, take);
  const visibleQuestions = questions.filter((question) => visibleQuestionIds.has(question.id)).slice(0, questionTake);
  const allLinks = visibleGoals.flatMap((goal) => goal.links);
  const visibleLinkIds = await readableArtifactIds(actor, params.workspaceId, "GoalLink", allLinks);
  for (const goal of visibleGoals) goal.links = goal.links.filter((link) => visibleLinkIds.has(link.id));

  const brainSourceIds = new Set<string>();
  const brainArticleIds = new Set<string>();
  for (const goal of visibleGoals) {
    for (const link of goal.links) {
      if (link.entityType === "BrainSource") brainSourceIds.add(link.entityId);
      if (link.entityType === "BrainArticle") brainArticleIds.add(link.entityId);
    }
  }
  for (const question of visibleQuestions) {
    if (question.relatedEntityType === "BrainSource" && question.relatedEntityId) brainSourceIds.add(question.relatedEntityId);
    if (question.relatedEntityType === "BrainArticle" && question.relatedEntityId) brainArticleIds.add(question.relatedEntityId);
  }

  const domains = await resolveKnowledgeAccessDomains(actor, params.workspaceId);
  const [brainSources, brainArticles] = await Promise.all([
    brainSourceIds.size > 0
      ? prisma.brainSource.findMany({
          where: {
            workspaceId: params.workspaceId,
            id: { in: Array.from(brainSourceIds) },
            archivedAt: null,
            accessDomain: { in: domains },
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
        })
      : Promise.resolve([]),
  ]);

  const visibleSourceIds = await readableBrainSourceIds(actor, params.workspaceId, brainSources);
  const sourceById = new Map(brainSources.filter((source) => visibleSourceIds.has(source.id)).map((source) => [source.id, source]));
  const visibleArticleIds = await readableArtifactIds(actor, params.workspaceId, "BrainArticle", brainArticles);
  const articleById = new Map(brainArticles.filter((article) => visibleArticleIds.has(article.id)).map((article) => [article.id, article]));
  const evidenceVisible = (entityType: string, entityId: string) =>
    entityType === "BrainSource" ? sourceById.has(entityId)
      : entityType === "BrainArticle" ? articleById.has(entityId) : false;
  for (const goal of visibleGoals) goal.links = goal.links.filter((link) => evidenceVisible(link.entityType, link.entityId));

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

  const mappedGoals = visibleGoals.map((goal): CompanyDirectionGoal => {
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

  const mappedQuestions = visibleQuestions.map((question): CompanyDirectionQuestion => {
    const relatedEvidence = question.relatedEntityType && question.relatedEntityId
      && evidenceVisible(question.relatedEntityType, question.relatedEntityId)
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
  params: ProducerLineageParams & {
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

  const progressPercent = keyResultProgress(params);

  // Note: KeyResult mutation and derived Goal progress, version, and WorkItemVersion history commit atomically in one transaction via txClient. Parent goal recomputation cascades via txClient where applicable.
  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", params.goalId);
    const goal = await tx.goal.findUnique({
      where: { id: params.goalId },
      select: { id: true, workspaceId: true, archivedAt: true, authorUserId: true, isPrivate: true, status: true, updatedAt: true },
    });
    invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
    await lockGoalForKeyResultMutation(tx, actor, membership, goal);
    const previousKeyResults = await tx.keyResult.findMany({ where: { goalId: params.goalId }, orderBy: { id: "asc" } });

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    const kr = await tx.keyResult.create({
      data: {
        goalId: params.goalId,
        title,
        targetValue: params.targetValue || null,
        currentValue: params.currentValue || 0,
        unit: params.unit || null,
        progressPercent,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "KeyResult", id: kr.id }, content: kr, receipt });

    await recomputeGoalProgress(params.goalId, actor, tx, { forceVersion: true, changedFields: ["keyResults"], previousKeyResults });

    return kr;
  });
}

export async function updateKeyResult(
  actor: AppActor,
  params: ProducerLineageParams & {
    workspaceId: string;
    krId: string;
    title?: string;
    targetValue?: number | null;
    currentValue?: number | null;
    unit?: string | null;
    expectedVersion?: number;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  // Note: KeyResult mutation and derived Goal progress, version, and WorkItemVersion history commit atomically in one transaction via txClient. Parent goal recomputation cascades via txClient where applicable.
  return prisma.$transaction(async (tx) => {
    const kr = await tx.keyResult.findUnique({
      where: { id: params.krId },
      include: { goal: true },
    });
    invariant(kr && kr.goal.workspaceId === params.workspaceId && !kr.goal.archivedAt, 404, "NOT_FOUND", "Key Result not found.");
    await acquireWorkItemAdvisoryLock(tx, "Goal", kr.goal.id);

    const data: any = {};
    let hasRequestedChanges = false;
    const numericValueChanged = (next: unknown, current: unknown) => {
      if (next === null || current === null) return next !== current;
      return Number(next) !== Number(current);
    };
    if (params.title !== undefined) {
      const title = params.title.trim();
      invariant(title.length > 0, 400, "INVALID_INPUT", "Key Result title is required.");
      data.title = title;
      hasRequestedChanges ||= title !== kr.title;
    }
    if (params.targetValue !== undefined) {
      data.targetValue = params.targetValue;
      hasRequestedChanges ||= numericValueChanged(params.targetValue, kr.targetValue);
    }
    if (params.currentValue !== undefined) {
      data.currentValue = params.currentValue;
      hasRequestedChanges ||= numericValueChanged(params.currentValue, kr.currentValue);
    }
    if (params.unit !== undefined) {
      data.unit = params.unit;
      hasRequestedChanges ||= params.unit !== kr.unit;
    }

    const newTarget = params.targetValue !== undefined ? params.targetValue : kr.targetValue;
    const newCurrent = params.currentValue !== undefined ? params.currentValue : kr.currentValue;

    data.progressPercent = keyResultProgress({
      title: data.title ?? kr.title,
      targetValue: newTarget,
      currentValue: newCurrent,
    });

    const changed = hasRequestedChanges;
    if (!changed) {
      requireEditableGoalKeyResults(actor, membership, kr.goal);
      if (params.expectedVersion !== undefined) {
        invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
        const currentGoal = await tx.goal.findUnique({ where: { id: kr.goal.id }, select: { version: true } });
        invariant(currentGoal && params.expectedVersion === currentGoal.version, 409, "VERSION_CONFLICT", "The Goal changed before this Key Result update could be applied. Please refresh and try again.");
      }
      return kr;
    }

    requireEditableGoalKeyResults(actor, membership, kr.goal);
    if (params.expectedVersion !== undefined) {
      invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
      const currentGoal = await tx.goal.findUnique({ where: { id: kr.goal.id }, select: { version: true } });
      invariant(currentGoal && params.expectedVersion === currentGoal.version, 409, "VERSION_CONFLICT", "The Goal changed before this Key Result update could be applied. Please refresh and try again.");
    }
    await lockGoalForKeyResultMutation(tx, actor, membership, kr.goal);

    const previousKeyResults = await tx.keyResult.findMany({ where: { goalId: kr.goalId }, orderBy: { id: "asc" } });

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "KeyResult", id: kr.id }, before: kr, capture: params });
    const updated = await tx.keyResult.update({
      where: { id: params.krId },
      data,
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "KeyResult", id: updated.id }, content: updated, receipt });

    await recomputeGoalProgress(updated.goalId, actor, tx, { forceVersion: true, changedFields: ["keyResults"], previousKeyResults });

    return updated;
  });
}

export async function deleteKeyResult(
  actor: AppActor,
  params: {
    workspaceId: string;
    krId: string;
    expectedVersion: number;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  // Note: KeyResult mutation and derived Goal progress, version, and WorkItemVersion history commit atomically in one transaction via txClient. Parent goal recomputation cascades via txClient where applicable.
  await prisma.$transaction(async (tx) => {
    const kr = await tx.keyResult.findUnique({
      where: { id: params.krId },
      include: { goal: true },
    });
    invariant(kr && kr.goal.workspaceId === params.workspaceId && !kr.goal.archivedAt, 404, "NOT_FOUND", "Key Result not found.");
    await acquireWorkItemAdvisoryLock(tx, "Goal", kr.goal.id);
    requireEditableGoalKeyResults(actor, membership, kr.goal);
    invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
    const currentGoal = await tx.goal.findUnique({ where: { id: kr.goal.id }, select: { version: true } });
    invariant(currentGoal && params.expectedVersion === currentGoal.version, 409, "VERSION_CONFLICT", "The Goal changed before this Key Result could be deleted. Please refresh and try again.");
    await lockGoalForKeyResultMutation(tx, actor, membership, kr.goal);
    const previousKeyResults = await tx.keyResult.findMany({ where: { goalId: kr.goalId }, orderBy: { id: "asc" } });

    await tx.keyResult.delete({ where: { id: params.krId } });

    await recomputeGoalProgress(kr.goalId, actor, tx, {
      forceVersion: true,
      changedFields: ["keyResults"],
      previousKeyResults,
      resetProgressWhenUndriven: true,
    });
  });
}

export async function postGoalUpdate(
  actor: AppActor,
  params: ProducerLineageParams & {
    workspaceId: string;
    goalId: string;
    bodyMd: string;
    authorMemberId?: string | null;
    statusChange?: GoalStatus | null;
    newProgress?: number | null;
    expectedVersion?: number;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", params.goalId);

    const goal = await tx.goal.findUnique({
      where: { id: params.goalId },
    });
    invariant(goal && goal.workspaceId === params.workspaceId && !goal.archivedAt, 404, "NOT_FOUND", "Goal not found.");
    const parentGoalIdsToRecompute = new Set<string>();
    if (params.newProgress != null || params.statusChange != null) {
      if (goal.parentGoalId) parentGoalIdsToRecompute.add(goal.parentGoalId);
    }
    await acquireGoalAdvisoryLocks(tx, parentGoalIdsToRecompute);

    if (goal.status === "DRAFT") {
      requirePrivateDraftEditor(actor, membership, goal);
    } else if (params.statusChange === "DRAFT") {
      requirePrivateDraftEditor(actor, membership, goal);
    } else {
      invariant(EDITABLE_ACTIVE_GOAL_STATUSES.has(goal.status), 400, "INVALID_STATE", "Only draft or active goals can receive updates.");
      requireCollaborativeWorkItemEditor(actor, membership, goal);
    }

    const bodyMd = params.bodyMd.trim();
    invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Goal update body is required.");
    const newProgress = params.newProgress !== undefined && params.newProgress !== null
      ? clampProgressPercent(params.newProgress, "Goal progress")
      : null;

    if (params.expectedVersion !== undefined) {
      invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0, 400, "INVALID_INPUT", "expectedVersion must be a positive integer.");
      invariant(params.expectedVersion === goal.version, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
    }

    if (params.authorMemberId) {
      const author = await tx.member.findUnique({
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

    const admission = params.statusChange || newProgress !== null
      ? await captureHumanArtifactInputAdvance({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Goal", id: goal.id }, before: goal, allowSystemTransition: true })
      : undefined;

    await lockGoalForAuthorizedMutation(tx, goal);

    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: params, dependencies: [{ kind: "Goal", id: goal.id }],
      snapshotDependencies: [{ kind: "Goal", id: goal.id }] });
    const update = await tx.goalUpdate.create({
      data: {
        goalId: params.goalId,
        bodyMd,
        authorMemberId: params.authorMemberId ?? membership?.id ?? null,
        statusChange: params.statusChange,
        newProgress,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "GoalUpdate", id: update.id }, content: update, receipt });


    const updateData: any = {};
    if (params.statusChange) {
      updateData.status = params.statusChange;
      if (params.statusChange === "DRAFT") {
        updateData.isPrivate = true;
        updateData.publishedAt = null;
      } else {
        updateData.isPrivate = false;
        updateData.publishedAt = goal.publishedAt || new Date();
      }
    }
    if (newProgress !== null) updateData.progressPercent = newProgress;

    if (Object.keys(updateData).length > 0) {
      const contentFields = ["progressPercent"];
      const changedFields = changedDataFields(goal as unknown as Record<string, unknown>, updateData)
        .filter((field) => contentFields.includes(field));

      if (changedFields.length > 0) {
        updateData.version = await recordWorkItemVersion(tx, actor, {
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
            "progressPercent",
            "targetDate",
            "startDate",
            "parentGoalId",
            "circleId",
            "ownerMemberId",
            "authorUserId",
            "isPrivate",
            "publishedAt",
            "status",
            "version",
          ]),
        });
      }

      let updatedGoal: typeof goal;
      try {
        updatedGoal = await tx.goal.update({
          where: {
            id: params.goalId,
            workspaceId: params.workspaceId,
            archivedAt: null,
            status: goal.status,
            isPrivate: goal.isPrivate,
            version: params.expectedVersion ?? goal.version,
          },
          data: updateData,
        });
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          invariant(false, 409, "VERSION_CONFLICT", "The record changed before this update could be applied. Please refresh and try again.");
        }
        throw error;
      }

      if (
        updateData.progressPercent !== undefined
        || countsTowardParentProgress(goal) !== countsTowardParentProgress(updatedGoal)
      ) {
        if (goal.parentGoalId) parentGoalIdsToRecompute.add(goal.parentGoalId);
      }

      await advanceHumanArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Goal", id: goal.id }, before: goal, after: updatedGoal, admission,
        allowSystemTransition: true });

      await recomputeGoalParentsInTransaction(tx, parentGoalIdsToRecompute, actor);

      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "goal.updated",
          aggregateType: "Goal",
          aggregateId: params.goalId,
          payload: {
            goalId: params.goalId,
            fields: Object.keys(updateData),
          },
        },
      ]);
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
    lineageInputs?: LineageInput[];
    lineageRoots?: LineageRoot[];
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
  requireEditableGoalContent(actor, membership, goal, "Only draft or active goals can change links.");
  const confidence = clampConfidence(params.confidence) ?? 1;
  const linkedBy = params.linkedBy?.trim() || "human";
  const source = params.source?.trim() || null;

  return prisma.$transaction(async (tx) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", params.goalId);
    if (params.entityType === "BrainSource") {
      const target = await tx.brainSource.findFirst({ where: { id: params.entityId, workspaceId: params.workspaceId } });
      invariant(target && (await readableBrainSourceIds(actor, params.workspaceId, [target], tx)).has(target.id),
        404, "NOT_FOUND", "Linked source not found.");
    }
    if (params.entityType === "BrainArticle") {
      const target = await tx.brainArticle.findFirst({ where: { id: params.entityId, workspaceId: params.workspaceId } });
      invariant(target && (await readableArtifactIds(actor, params.workspaceId, "BrainArticle", [target], tx)).has(target.id),
        404, "NOT_FOUND", "Linked article not found.");
    }
    const prior = await tx.goalLink.findUnique({ where: { goalId_entityType_entityId: {
      goalId: params.goalId, entityType: params.entityType, entityId: params.entityId,
    } } });
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: prior ? { kind: "GoalLink", id: prior.id } : undefined,
      before: prior ?? undefined, capture: params });
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

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "GoalLink", id: link.id }, content: link, receipt });

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

export async function deleteGoalLink(
  actor: AppActor,
  params: {
    workspaceId: string;
    linkId: string;
    _membership?: MembershipSummary | null;
  }
) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const link = await prisma.goalLink.findUnique({
    where: { id: params.linkId },
    include: { goal: true },
  });
  invariant(link && link.goal.workspaceId === params.workspaceId && !link.goal.archivedAt, 404, "NOT_FOUND", "Link not found.");
  requireEditableGoalContent(actor, membership, link.goal, "Only draft or active goals can change links.");

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

export async function recomputeGoalProgress(
  goalId: string,
  actor?: AppActor,
  txClient?: Prisma.TransactionClient,
  options?: {
    forceVersion?: boolean;
    changedFields?: string[];
    previousKeyResults?: unknown[];
    resetProgressWhenUndriven?: boolean;
  },
) {
  const execute = async (tx: Prisma.TransactionClient) => {
    await acquireWorkItemAdvisoryLock(tx, "Goal", goalId);
    const goal = await tx.goal.findUnique({
      where: { id: goalId },
      include: {
        keyResults: true,
        childGoals: {
          where: {
            archivedAt: null,
            NOT: {
              isPrivate: true,
              status: "DRAFT",
            },
          },
        },
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
      // Preserve manual progress unless a driver-removal flow explicitly resets it.
      computedProgress = options?.resetProgressWhenUndriven ? 0 : goal.progressPercent;
    }

    if (computedProgress !== goal.progressPercent || options?.forceVersion) {
      const effectiveActor: AppActor = actor ?? {
        kind: "agent",
        authProvider: "bootstrap",
        label: "system:progress-recomputation",
        workspaceIds: [goal.workspaceId],
      };

      const drivers = goal.keyResults.length
        ? goal.keyResults.map((keyResult) => ({ kind: "KeyResult" as const, id: keyResult.id, snapshot: keyResult }))
        : goal.childGoals.map((child) => ({ kind: "Goal" as const, id: child.id, snapshot: child }));
      const receipt = await prepareProducerLineage({ tx, actor: effectiveActor, workspaceId: goal.workspaceId,
        artifact: { kind: "Goal", id: goal.id }, before: goal, completeCopy: true,
        dependencies: drivers, snapshotDependencies: drivers });
      const newVersion = await recordWorkItemVersion(tx, effectiveActor, {
        workspaceId: goal.workspaceId,
        entityType: "Goal",
        entityId: goal.id,
        currentVersion: goal.version,
        changedFields: [
          ...(options?.changedFields ?? []),
          ...(computedProgress !== goal.progressPercent ? ["progressPercent"] : []),
        ],
        previousState: pickJsonSnapshot({ ...goal, ...(options?.previousKeyResults ? { keyResults: options.previousKeyResults } : {}) } as unknown as Record<string, unknown>, [
          "id",
          "workspaceId",
          "title",
          "descriptionMd",
          "level",
          "cadence",
          "progressPercent",
          "targetDate",
          "startDate",
          "parentGoalId",
          "circleId",
          "ownerMemberId",
          "authorUserId",
          "isPrivate",
          "publishedAt",
          "status",
          "version",
          "keyResults",
        ]),
      });

      try {
        const updated = await tx.goal.update({
          where: { id: goalId, version: goal.version },
          data: {
            ...(computedProgress !== goal.progressPercent ? { progressPercent: computedProgress } : {}),
            version: newVersion,
          },
        });
        await finishProducerLineage({ tx, actor: effectiveActor, workspaceId: goal.workspaceId,
          artifact: { kind: "Goal", id: goal.id }, content: updated, receipt });
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          invariant(false, 409, "VERSION_CONFLICT", "Goal changed during progress recomputation. Refresh and try again.");
        }
        throw error;
      }

      if (goal.parentGoalId) {
        await recomputeGoalProgress(goal.parentGoalId, effectiveActor, tx);
      }
    }
  };

  if (txClient) {
    await execute(txClient);
  } else {
    await prisma.$transaction(async (tx) => {
      await execute(tx);
    });
  }
}

export async function getGoalTree(actor:AppActor,workspaceId:string,opts?:{cadence?:GoalCadence}){
  return buildGoalTree(await listGoals(actor,{workspaceId,cadence:opts?.cadence}));
}

function goalSectionCursor(cursor: string | undefined, purpose: string, scope: string) {
  if (cursor === undefined) return null;
  try {
    invariant(cursor.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(cursor), 400, "INVALID_INPUT", "Invalid goal section cursor.");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    invariant(value?.purpose === purpose && value.scope === scope && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256
      && typeof value.date === "string" && Number.isFinite(Date.parse(value.date))
      && (value.targetDate === null || typeof value.targetDate === "string" && Number.isFinite(Date.parse(value.targetDate))),
    400, "INVALID_INPUT", "Invalid goal section cursor.");
    return {id: value.id as string, date: new Date(value.date), targetDate: value.targetDate === null ? null : new Date(value.targetDate)};
  } catch { invariant(false, 400, "INVALID_INPUT", "Invalid goal section cursor."); }
}

export async function getMyGoalSlicePage(actor: AppActor, memberId: string, workspaceId: string,
  opts: {cursor?: string} = {}, readRelease?: DigestReadRelease) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const scope = JSON.stringify([workspaceId, memberId]);
  const after = goalSectionCursor(opts.cursor, "my-goals-v1", scope);
  const laterWithinDate: Prisma.GoalWhereInput[] = after ? [
    {targetDate: after.targetDate, updatedAt: {lt: after.date}},
    {targetDate: after.targetDate, updatedAt: after.date, id: {gt: after.id}},
  ] : [];
  const myGoals = await prisma.goal.findMany({
    where: {
      workspaceId, ...privacyFilter(actor, membership), ownerMemberId: memberId, archivedAt: null,
      status: {in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"]},
      ...(after ? {AND: [{OR: [...(after.targetDate ? [{targetDate: {gt: after.targetDate}}, {targetDate: null}] : []), ...laterWithinDate]}]} : {}),
    },
    include: {circle: true, parentGoal: {include: {circle: true, parentGoal: {include: {circle: true}}}}},
    orderBy: [{targetDate: "asc"}, {updatedAt: "desc"}, {id: "asc"}], take: 200,
  });
  const release = goalReadRelease(actor, workspaceId, readRelease);
  const items = [];
  for (let offset = 0; offset < myGoals.length; offset += 100) {
    const admitted = (await release.capture("Goal", myGoals.slice(offset, offset + 100))).records;
    for (const goal of admitted) items.push(await readableGoalParents(release, actor, membership, goal));
  }
  const complete = myGoals.length < 200;
  const last = myGoals.at(-1);
  const nextCursor = complete || !last ? null : Buffer.from(JSON.stringify({purpose: "my-goals-v1", scope,
    id: last.id, date: last.updatedAt.toISOString(), targetDate: last.targetDate?.toISOString() ?? null})).toString("base64url");
  return release.finish({items, complete, nextCursor});
}

export async function getMyGoalSlice(actor: AppActor, memberId: string, workspaceId: string, readRelease?: DigestReadRelease) {
  const page = await getMyGoalSlicePage(actor, memberId, workspaceId, {}, readRelease);
  invariant(page.complete, 409, "SOURCE_READ_SCAN_LIMIT", "My goals are incomplete; use the bounded goal window.");
  return page.items;
}

export async function createRecognition(
  actor: AppActor,
  params: ProducerLineageParams & {
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

  return prisma.$transaction(async (tx) => {
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: params, dependencies: params.goalId ? [{ kind: "Goal", id: params.goalId }] : [] });
    const recognition = await tx.recognition.create({
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
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Recognition", id: recognition.id }, content: recognition, receipt });
    return recognition;
  });
}

export async function listRecognitionsPage(
  actor: AppActor,
  params: {
    workspaceId: string;
    recipientMemberId?: string;
    cursor?: string;
    _membership?: MembershipSummary | null;
  },
  readRelease?: DigestReadRelease,
) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    resolvedMembership: params._membership,
  });

  const query: any = { workspaceId: params.workspaceId };
  if (params.recipientMemberId) query.recipientMemberId = params.recipientMemberId;

  const scope = JSON.stringify([params.workspaceId, params.recipientMemberId ?? null]);
  const after = goalSectionCursor(params.cursor, "recognitions-v1", scope);
  if (after) query.AND = [{OR: [{createdAt: {lt: after.date}}, {createdAt: after.date, id: {gt: after.id}}]}];
  const rows = await prisma.recognition.findMany({
    where: query,
    include: {
      author: { include: goalReaderMemberInclude },
      recipient: { include: goalReaderMemberInclude },
    },
    orderBy: [{createdAt: "desc"}, {id: "asc"}], take: 200,
  });
  const release=goalReadRelease(actor,params.workspaceId,readRelease);
  const admitted: typeof rows = [];
  for (let offset=0; offset<rows.length; offset+=100) admitted.push(...(await release.capture("Recognition",rows.slice(offset,offset+100))).records);
  const result=[];
  for(const row of admitted){
    const author=await readableGoalMember(release,row.author),recipient=await readableGoalMember(release,row.recipient);
    result.push({...row,
      author:author?{...author,user:{displayName:author.user.displayName}}:null,
      recipient:recipient?{...recipient,user:{displayName:recipient.user.displayName}}:null});
  }
  const complete = rows.length < 200;
  const last = rows.at(-1);
  const nextCursor = complete || !last ? null : Buffer.from(JSON.stringify({purpose: "recognitions-v1", scope,
    id: last.id, date: last.createdAt.toISOString(), targetDate: null})).toString("base64url");
  return release.finish({items: result, complete, nextCursor});
}

export async function listRecognitions(actor: AppActor, params: {
  workspaceId: string; recipientMemberId?: string; _membership?: MembershipSummary | null;
}, readRelease?: DigestReadRelease) {
  const page = await listRecognitionsPage(actor, params, readRelease);
  invariant(page.complete, 409, "SOURCE_READ_SCAN_LIMIT", "Recognitions are incomplete; use the bounded recognition window.");
  return page.items;
}
