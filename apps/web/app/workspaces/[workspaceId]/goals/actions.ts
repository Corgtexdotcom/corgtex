"use server";

import { revalidatePath } from "next/cache";
import {
  createGoal,
  updateGoal,
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
import { handleRouteError } from "@/lib/http";
import type { GoalLevel, GoalCadence, GoalStatus } from "@prisma/client";

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
