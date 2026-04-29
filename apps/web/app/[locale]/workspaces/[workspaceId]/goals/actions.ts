"use server";

import { revalidatePath } from "next/cache";
import { enforceDemoGuard } from "@/lib/demo-guard";
import {
  createGoal,
  updateGoal,
  returnGoalToDraft,
  deleteGoal,
  addKeyResult,
  updateKeyResult,
  deleteKeyResult,
  postGoalUpdate,
  createGoalLink,
  deleteGoalLink,
  createRecognition,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import type { GoalLevel, GoalCadence, GoalStatus } from "@prisma/client";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { asOptional, asOptionalInt, asString, refresh } from "../action-utils";

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

export async function createGoalAction(params: {
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
}) {
  try {
    const actor = await requirePageActor();
    const res = await createGoal(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to create goal" };
  }
}

export async function updateGoalAction(params: {
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
}) {
  try {
    const actor = await requirePageActor();
    const res = await updateGoal(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to update goal" };
  }
}

export async function createGoalFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await createGoal(actor, {
    workspaceId,
    title: asString(formData, "title"),
    descriptionMd: asOptional(formData, "descriptionMd"),
    level: asString(formData, "level") as GoalLevel,
    cadence: asString(formData, "cadence") as GoalCadence,
    status: (asOptional(formData, "status") as GoalStatus | null) ?? "DRAFT",
    startDate: optionalDate(formData, "startDate"),
    targetDate: optionalDate(formData, "targetDate"),
    parentGoalId: asOptional(formData, "parentGoalId"),
    circleId: asOptional(formData, "circleId"),
    ownerMemberId: asOptional(formData, "ownerMemberId"),
    keyResults: keyResultsFromForm(formData),
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

export async function postGoalUpdateFormAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = await requireGoalsEnabled(formData);
  await postGoalUpdate(actor, {
    workspaceId,
    goalId: asString(formData, "goalId"),
    bodyMd: asString(formData, "bodyMd"),
    statusChange: formData.has("statusChange") ? asOptional(formData, "statusChange") as GoalStatus | null : undefined,
    newProgress: formData.has("newProgress") ? asOptionalInt(formData, "newProgress") ?? null : undefined,
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

export async function deleteGoalAction(params: { workspaceId: string; goalId: string }) {
  try {
    const actor = await requirePageActor();
    await deleteGoal(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to delete goal" };
  }
}

export async function addKeyResultAction(params: {
  workspaceId: string;
  goalId: string;
  title: string;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
}) {
  try {
    const actor = await requirePageActor();
    const res = await addKeyResult(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to add key result" };
  }
}

export async function updateKeyResultAction(params: {
  workspaceId: string;
  krId: string;
  title?: string;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
}) {
  try {
    const actor = await requirePageActor();
    const res = await updateKeyResult(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to update key result" };
  }
}

export async function deleteKeyResultAction(params: { workspaceId: string; krId: string }) {
  try {
    const actor = await requirePageActor();
    await deleteKeyResult(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to delete key result" };
  }
}

export async function postGoalUpdateAction(params: {
  workspaceId: string;
  goalId: string;
  bodyMd: string;
  statusChange?: GoalStatus | null;
  newProgress?: number | null;
}) {
  try {
    const actor = await requirePageActor();
    const res = await postGoalUpdate(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    revalidatePath(`/workspaces/${params.workspaceId}`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to post goal update" };
  }
}

export async function createGoalLinkAction(params: {
  workspaceId: string;
  goalId: string;
  entityType: string;
  entityId: string;
}) {
  try {
    const actor = await requirePageActor();
    const res = await createGoalLink(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to create goal link" };
  }
}

export async function deleteGoalLinkAction(params: { workspaceId: string; linkId: string }) {
  try {
    const actor = await requirePageActor();
    await deleteGoalLink(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to delete goal link" };
  }
}

export async function createRecognitionAction(params: {
  workspaceId: string;
  recipientMemberId: string;
  title: string;
  storyMd: string;
  goalId?: string | null;
  valueTags?: string[];
}) {
  try {
    const actor = await requirePageActor();
    const res = await createRecognition(actor, params);
    revalidatePath(`/workspaces/${params.workspaceId}/goals`);
    return { success: true, data: { id: res.id } };
  } catch (error: any) {
    return { success: false, error: error.message || "Failed to create recognition" };
  }
}
