"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import {
  createGoal,
  updateGoal,
  returnGoalToDraft,
  deleteGoal,
  addKeyResult,
  createGoalFinanceProjectLink,
  deleteGoalFinanceProjectLink,
  respondToCheckIn,
  skipCompanyUnderstandingQuestion,
  triggerAgentRun,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import type { GoalLevel, GoalCadence, GoalStatus } from "@prisma/client";
import { requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { asOptional, asOptionalInt, asString, duplicateGuardFromFormData, refresh } from "../action-utils";

type GoalKeyResultInput = {
  title: string;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
};

async function requireGoalsEnabled(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await requireWorkspaceFeature(workspaceId, "GOALS");
  return workspaceId;
}

function optionalDate(formData: FormData, key: string) {
  const value = asOptional(formData, key);
  return value ? new Date(value) : null;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw.length > 0 ? Number(raw) : null;
}

function keyResultsFromForm(formData: FormData): GoalKeyResultInput[] {
  const titles = formData.getAll("keyResultTitle");
  const targets = formData.getAll("keyResultTarget");
  const currents = formData.getAll("keyResultCurrent");
  const units = formData.getAll("keyResultUnit");

  return titles
    .map((titleValue, index) => ({
      title: String(titleValue ?? "").trim(),
      targetValue: optionalNumber(targets[index] ?? null),
      currentValue: optionalNumber(currents[index] ?? null),
      unit: String(units[index] ?? "").trim() || null,
    }))
    .filter((keyResult) => keyResult.title.length > 0);
}

export async function createGoalFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  const submittedIntent = asOptional(formData, "intent");
  const statusFromForm = formData.has("status") ? asString(formData, "status") as GoalStatus : undefined;
  const status = submittedIntent === "open"
    ? "ACTIVE"
    : submittedIntent === "draft"
      ? "DRAFT"
      : statusFromForm ?? "DRAFT";
  await createGoal(actor, {
    workspaceId,
    title: asString(formData, "title"),
    descriptionMd: asOptional(formData, "descriptionMd"),
    level: asString(formData, "level") as GoalLevel,
    cadence: asString(formData, "cadence") as GoalCadence,
    status,
    isPrivate: status === "DRAFT",
    startDate: optionalDate(formData, "startDate"),
    targetDate: optionalDate(formData, "targetDate"),
    parentGoalId: asOptional(formData, "parentGoalId"),
    circleId: asOptional(formData, "circleId"),
    ownerMemberId: asOptional(formData, "ownerMemberId"),
    keyResults: keyResultsFromForm(formData),
    duplicateGuard: duplicateGuardFromFormData(formData),
  });
  refresh(workspaceId);
}

export async function updateGoalFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await updateGoal(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
    title: formData.has("title") ? asOptional(formData, "title") ?? undefined : undefined,
    descriptionMd: formData.has("descriptionMd") ? asOptional(formData, "descriptionMd") : undefined,
    level: formData.has("level") ? asString(formData, "level") as GoalLevel : undefined,
    cadence: formData.has("cadence") ? asString(formData, "cadence") as GoalCadence : undefined,
    status: formData.has("status") ? asString(formData, "status") as GoalStatus : undefined,
    progressPercent: formData.has("progressPercent") ? asOptionalInt(formData, "progressPercent") : undefined,
    startDate: formData.has("startDate") ? optionalDate(formData, "startDate") : undefined,
    targetDate: formData.has("targetDate") ? optionalDate(formData, "targetDate") : undefined,
    parentGoalId: formData.has("parentGoalId") ? asOptional(formData, "parentGoalId") : undefined,
    circleId: formData.has("circleId") ? asOptional(formData, "circleId") : undefined,
    ownerMemberId: formData.has("ownerMemberId") ? asOptional(formData, "ownerMemberId") : undefined,
  });
  refresh(workspaceId);
}

export async function returnGoalToDraftFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await returnGoalToDraft(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
  });
  refresh(workspaceId);
}

export async function refreshCompanyDirectionFromBrainFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await triggerAgentRun(actor, {
    workspaceId,
    agentKey: "company-understanding",
  });
  refresh(workspaceId);
}

export async function answerCompanyUnderstandingQuestionFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await respondToCheckIn(actor, {
    workspaceId,
    checkInId: asString(formData, "checkInId"),
    responseMd: asString(formData, "responseMd"),
  });
  refresh(workspaceId);
}

export async function skipCompanyUnderstandingQuestionFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await skipCompanyUnderstandingQuestion(actor, {
    workspaceId,
    checkInId: asString(formData, "checkInId"),
  });
  refresh(workspaceId);
}

export async function addKeyResultFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await addKeyResult(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
    title: asString(formData, "title"),
    targetValue: optionalNumber(formData.get("targetValue")),
    currentValue: optionalNumber(formData.get("currentValue")),
    unit: asOptional(formData, "unit"),
  });
  refresh(workspaceId);
}

export async function archiveGoalFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await deleteGoal(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
  });
  refresh(workspaceId);
}

export async function createGoalFinanceProjectLinkFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  await createGoalFinanceProjectLink(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
    projectId: asString(formData, "projectId"),
  });
  refresh(workspaceId);
}

export async function deleteGoalFinanceProjectLinkFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  await deleteGoalFinanceProjectLink(actor, {
    workspaceId,
    linkId: asString(formData, "linkId"),
  });
  refresh(workspaceId);
}
