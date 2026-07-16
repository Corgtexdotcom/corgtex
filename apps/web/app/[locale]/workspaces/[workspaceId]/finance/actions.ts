"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createPracticeContributionEntry,
  createPracticeProject,
  markPracticeContributionEntryPaid,
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

function optionalTenths(formData: FormData, name: string): number | undefined {
  const raw = asOptional(formData, name);
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? undefined : Math.round(parsed * 10);
}

async function requireFinanceActionContext(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  return { actor, workspaceId };
}

async function requireSlicingPieActionContext(formData: FormData) {
  const context = await requireFinanceActionContext(formData);
  await requireWorkspaceFeature(context.workspaceId, "SLICING_PIE");
  return context;
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

export async function createPracticeContributionEntryAction(formData: FormData) {
  const { actor, workspaceId } = await requireSlicingPieActionContext(formData);
  await createPracticeContributionEntry(actor, workspaceId, {
    projectId: asString(formData, "projectId"),
    type: asString(formData, "type") as "TIME" | "EXPENSE",
    paymentChoice: asString(formData, "paymentChoice") as "CASH" | "SLICING_PIE",
    description: asString(formData, "description"),
    occurredAt: new Date(asString(formData, "occurredAt")),
    hoursTenths: optionalTenths(formData, "hours"),
    rateCents: optionalCents(formData, "rate"),
    amountCents: optionalCents(formData, "amount"),
    currency: asOptional(formData, "currency"),
    receiptUrl: asOptional(formData, "receiptUrl"),
  });
  refresh(workspaceId);
}

export async function markPracticeContributionEntryPaidAction(formData: FormData) {
  const { actor, workspaceId } = await requireSlicingPieActionContext(formData);
  await markPracticeContributionEntryPaid(actor, workspaceId, asString(formData, "entryId"));
  refresh(workspaceId);
}
