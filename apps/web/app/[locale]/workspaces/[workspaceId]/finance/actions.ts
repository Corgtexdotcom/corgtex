"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createPracticeProject,
  updatePracticeProject,
} from "@corgtex/domain";

function optionalCents(formData: FormData, name: string): number | undefined {
  const raw = asOptional(formData, name);
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? undefined : Math.round(parsed * 100);
}

function optionalBps(formData: FormData, name: string): number | null | undefined {
  const raw = asOptional(formData, name);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? undefined : Math.round(parsed * 100);
}

async function requireFinanceActionContext(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  return { actor, workspaceId };
}

export async function createPracticeProjectAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await createPracticeProject(actor, workspaceId, {
    code: asString(formData, "code"),
    name: asString(formData, "name"),
    clientName: asString(formData, "clientName"),
    status: asString(formData, "status") as "ACTIVE" | "ON_HOLD" | "CLOSED",
    poValueCents: optionalCents(formData, "poValue"),
    serviceBudgetCents: optionalCents(formData, "serviceBudget"),
    expenseBudgetCents: optionalCents(formData, "expenseBudget"),
    usedCents: optionalCents(formData, "used"),
    weeklyBurnCents: optionalCents(formData, "weeklyBurn"),
    targetMarginBps: optionalBps(formData, "targetMargin"),
    currentMarginBps: optionalBps(formData, "currentMargin"),
  });
  refresh(workspaceId);
}

export async function updatePracticeProjectAction(formData: FormData) {
  const { actor, workspaceId } = await requireFinanceActionContext(formData);
  await updatePracticeProject(actor, workspaceId, {
    projectId: asString(formData, "projectId"),
    code: asString(formData, "code"),
    name: asString(formData, "name"),
    clientName: asString(formData, "clientName"),
    status: asString(formData, "status") as "ACTIVE" | "ON_HOLD" | "CLOSED",
    poValueCents: optionalCents(formData, "poValue"),
    serviceBudgetCents: optionalCents(formData, "serviceBudget"),
    expenseBudgetCents: optionalCents(formData, "expenseBudget"),
    usedCents: optionalCents(formData, "used"),
    weeklyBurnCents: optionalCents(formData, "weeklyBurn"),
    targetMarginBps: optionalBps(formData, "targetMargin"),
    currentMarginBps: optionalBps(formData, "currentMargin"),
  });
  refresh(workspaceId);
}
