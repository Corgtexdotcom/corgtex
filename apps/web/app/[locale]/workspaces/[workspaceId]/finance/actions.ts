"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { asString, asOptional, refresh } from "../action-utils";
import {
  createNativePracticeExpense,
  createNativePracticeTimeEntry,
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

function requiredNumber(formData: FormData, name: string): number {
  const parsed = Number.parseFloat(asString(formData, name));
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function requiredDate(formData: FormData, name: string): Date {
  return new Date(asString(formData, name));
}

async function requireFinanceActionContext(formData: FormData) {
  const workspaceId = asString(formData, "workspaceId");
  await enforceDemoGuard(workspaceId);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  return { actor, workspaceId };
}

async function requirePracticeProjectsActionContext(formData: FormData) {
  const context = await requireFinanceActionContext(formData);
  await requireWorkspaceFinanceCapability(context.workspaceId, "projects");
  return context;
}

async function requireSlicingPieActionContext(formData: FormData) {
  const context = await requireFinanceActionContext(formData);
  await requireWorkspaceFinanceCapability(context.workspaceId, "slicingPie");
  return context;
}

export async function createPracticeProjectAction(formData: FormData) {
  const { actor, workspaceId } = await requirePracticeProjectsActionContext(formData);
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
  const { actor, workspaceId } = await requirePracticeProjectsActionContext(formData);
  const input: Parameters<typeof updatePracticeProject>[2] = {
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
  };
  if (formData.has("currentMargin")) {
    input.currentMarginBps = optionalBps(formData, "currentMargin");
  }
  await updatePracticeProject(actor, workspaceId, input);
  refresh(workspaceId);
}

export async function createNativePracticeTimeEntryAction(formData: FormData) {
  const { actor, workspaceId } = await requirePracticeProjectsActionContext(formData);
  await createNativePracticeTimeEntry(actor, workspaceId, {
    projectId: asString(formData, "projectId"),
    consultantName: asString(formData, "consultantName"),
    consultantEmail: asOptional(formData, "consultantEmail"),
    workedOn: requiredDate(formData, "workedOn"),
    hours: requiredNumber(formData, "hours"),
    assignmentType: asOptional(formData, "assignmentType"),
    billRateCents: optionalCents(formData, "billRate"),
    costRateCents: optionalCents(formData, "costRate"),
    idempotencyKey: asOptional(formData, "idempotencyKey"),
  });
  refresh(workspaceId);
}

export async function createNativePracticeExpenseAction(formData: FormData) {
  const { actor, workspaceId } = await requirePracticeProjectsActionContext(formData);
  await createNativePracticeExpense(actor, workspaceId, {
    projectId: asString(formData, "projectId"),
    consultantName: asOptional(formData, "consultantName"),
    consultantEmail: asOptional(formData, "consultantEmail"),
    spentOn: requiredDate(formData, "spentOn"),
    vendor: asOptional(formData, "vendor"),
    category: asString(formData, "category"),
    businessPurpose: asString(formData, "businessPurpose"),
    amountCents: optionalCents(formData, "amount") ?? 0,
    currency: asOptional(formData, "currency"),
    billable: formData.get("billable") === "on",
    idempotencyKey: asOptional(formData, "idempotencyKey"),
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
