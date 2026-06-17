import type { MemberRole, PracticeProject, PracticeProjectStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { getModuleByKey, rolesWithDefaultAccess } from "./modules";
import { invariant } from "./errors";

/**
 * Native first-party practice-finance domain. This is the cutover target for the
 * Practice Ledger satellite: budgets, usage, burn, and margin now live in
 * Corgtex Postgres (`PracticeProject`). The derivation helpers are pure so they
 * are unit-testable without a database; the thin wrappers do the I/O + access.
 */

/** Weeks of budget runway at or below which a project needs attention. */
export const BUDGET_RUNWAY_ATTENTION_WEEKS = 6;

export type PracticeAttentionIssue = "setup" | "budget" | "margin";

export type PracticeAttentionItem = {
  projectId: string;
  projectName: string;
  issue: PracticeAttentionIssue;
  /** Weeks of runway for budget issues; null when not time-based. */
  weeks: number | null;
  detail: string;
};

export type PracticeFinanceSummary = {
  activeProjects: number;
  budgetCents: number;
  usedCents: number;
  remainingCents: number;
  /** Portfolio margin in basis points (PO-weighted), or null if unknown. */
  marginBps: number | null;
};

type ProjectFinance = Pick<
  PracticeProject,
  | "id"
  | "name"
  | "status"
  | "poValueCents"
  | "serviceBudgetCents"
  | "expenseBudgetCents"
  | "usedCents"
  | "weeklyBurnCents"
  | "targetMarginBps"
  | "currentMarginBps"
>;

function centsToDollars(cents: number) {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function bpsToPct(bps: number) {
  return `${(bps / 100).toFixed(1)}%`;
}

export function projectRemainingCents(p: Pick<ProjectFinance, "poValueCents" | "usedCents">): number {
  return p.poValueCents - p.usedCents;
}

/** Fraction of the PO value consumed (0 when no budget is set). */
export function projectUsedRatio(p: Pick<ProjectFinance, "poValueCents" | "usedCents">): number {
  if (p.poValueCents <= 0) return 0;
  return p.usedCents / p.poValueCents;
}

/** Weeks until the budget is exhausted at the current burn, or null. */
export function projectBudgetRunwayWeeks(
  p: Pick<ProjectFinance, "poValueCents" | "usedCents" | "weeklyBurnCents">,
): number | null {
  if (p.weeklyBurnCents <= 0) return null;
  const remaining = projectRemainingCents(p);
  if (remaining <= 0) return 0;
  return remaining / p.weeklyBurnCents;
}

/** A project is "setup-incomplete" until it can be forecast. */
export function projectNeedsSetup(
  p: Pick<ProjectFinance, "poValueCents" | "serviceBudgetCents" | "expenseBudgetCents" | "targetMarginBps">,
): boolean {
  return (
    p.poValueCents <= 0 ||
    p.serviceBudgetCents <= 0 ||
    p.expenseBudgetCents <= 0 ||
    p.targetMarginBps == null
  );
}

/** Attention items for a single project, in priority order (setup, budget, margin). */
export function projectAttentionItems(p: ProjectFinance): PracticeAttentionItem[] {
  if (p.status !== "ACTIVE") return [];
  const items: PracticeAttentionItem[] = [];

  if (projectNeedsSetup(p)) {
    items.push({
      projectId: p.id,
      projectName: p.name,
      issue: "setup",
      weeks: null,
      detail: "Add PO value, service budget, expense budget, and target margin before forecasting.",
    });
    // Until setup is complete, runway/margin are not meaningful.
    return items;
  }

  const runway = projectBudgetRunwayWeeks(p);
  if (runway != null && runway <= BUDGET_RUNWAY_ATTENTION_WEEKS) {
    items.push({
      projectId: p.id,
      projectName: p.name,
      issue: "budget",
      weeks: Math.round(runway * 10) / 10,
      detail: `${centsToDollars(projectRemainingCents(p))} remaining at ${centsToDollars(p.weeklyBurnCents)} / week.`,
    });
  }

  if (p.currentMarginBps != null && p.targetMarginBps != null && p.currentMarginBps < p.targetMarginBps) {
    items.push({
      projectId: p.id,
      projectName: p.name,
      issue: "margin",
      weeks: 0,
      detail: `Current margin ${bpsToPct(p.currentMarginBps)} vs target ${bpsToPct(p.targetMarginBps)}.`,
    });
  }

  return items;
}

/** Portfolio rollup across the active projects. */
export function summarizePracticeFinance(projects: ProjectFinance[]): PracticeFinanceSummary {
  const active = projects.filter((p) => p.status === "ACTIVE");
  const budgetCents = active.reduce((sum, p) => sum + p.poValueCents, 0);
  const usedCents = active.reduce((sum, p) => sum + p.usedCents, 0);

  let marginWeightCents = 0;
  let marginWeightedBps = 0;
  for (const p of active) {
    if (p.currentMarginBps != null && p.poValueCents > 0) {
      marginWeightCents += p.poValueCents;
      marginWeightedBps += p.currentMarginBps * p.poValueCents;
    }
  }

  return {
    activeProjects: active.length,
    budgetCents,
    usedCents,
    remainingCents: budgetCents - usedCents,
    marginBps: marginWeightCents > 0 ? Math.round(marginWeightedBps / marginWeightCents) : null,
  };
}

export function collectAttention(projects: ProjectFinance[]): PracticeAttentionItem[] {
  return projects.flatMap(projectAttentionItems);
}

// ---- I/O wrappers ----

const PRACTICE_FINANCE_MANAGE_ROLES: MemberRole[] = (() => {
  const financeModule = getModuleByKey("finance");
  const roles = financeModule ? rolesWithDefaultAccess(financeModule, "write") : ["FINANCE_STEWARD", "ADMIN"];
  return roles as MemberRole[];
})();

export type PracticeProjectInput = {
  code: string;
  name: string;
  clientName: string;
  status?: PracticeProjectStatus;
  poValueCents?: number;
  serviceBudgetCents?: number;
  expenseBudgetCents?: number;
  usedCents?: number;
  weeklyBurnCents?: number;
  targetMarginBps?: number | null;
  currentMarginBps?: number | null;
  sourceSatelliteId?: string | null;
};

export type ListPracticeProjectsOptions = {
  take?: number | null;
  cursor?: string | null;
};

const DEFAULT_PRACTICE_PROJECT_TAKE = 100;
const MAX_PRACTICE_PROJECT_TAKE = 200;

function normalizeCents(value: number | undefined, label: string): number {
  const cents = value ?? 0;
  invariant(Number.isInteger(cents) && cents >= 0, 400, "INVALID_INPUT", `${label} must be a non-negative integer (cents).`);
  return cents;
}

function normalizeBps(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  invariant(Number.isInteger(value) && value >= 0 && value <= 10000, 400, "INVALID_INPUT", `${label} must be 0-10000 basis points.`);
  return value;
}

function normalizeTake(value: number | null | undefined): number {
  if (value == null) return DEFAULT_PRACTICE_PROJECT_TAKE;
  invariant(Number.isInteger(value), 400, "INVALID_INPUT", "take must be an integer.");
  return Math.min(Math.max(value, 1), MAX_PRACTICE_PROJECT_TAKE);
}

function normalizeCursor(value: string | null | undefined): string | null {
  const cursor = value?.trim();
  return cursor || null;
}

export async function listPracticeProjects(
  actor: AppActor,
  workspaceId: string,
  options: ListPracticeProjectsOptions = {},
): Promise<PracticeProject[]> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const cursor = normalizeCursor(options.cursor);
  return prisma.practiceProject.findMany({
    where: { workspaceId },
    orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
    take: normalizeTake(options.take),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function getPracticeFinanceDashboard(
  actor: AppActor,
  workspaceId: string,
  options: ListPracticeProjectsOptions = {},
) {
  const projects = await listPracticeProjects(actor, workspaceId, options);
  return {
    summary: summarizePracticeFinance(projects),
    attention: collectAttention(projects),
    projects,
  };
}

export async function createPracticeProject(
  actor: AppActor,
  workspaceId: string,
  input: PracticeProjectInput,
): Promise<PracticeProject> {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: PRACTICE_FINANCE_MANAGE_ROLES });

  const code = input.code?.trim();
  const name = input.name?.trim();
  const clientName = input.clientName?.trim();
  invariant(code, 400, "INVALID_INPUT", "Project code is required.");
  invariant(name, 400, "INVALID_INPUT", "Project name is required.");
  invariant(clientName, 400, "INVALID_INPUT", "Client name is required.");

  return prisma.practiceProject.create({
    data: {
      workspaceId,
      code,
      name,
      clientName,
      status: input.status ?? "ACTIVE",
      poValueCents: normalizeCents(input.poValueCents, "PO value"),
      serviceBudgetCents: normalizeCents(input.serviceBudgetCents, "Service budget"),
      expenseBudgetCents: normalizeCents(input.expenseBudgetCents, "Expense budget"),
      usedCents: normalizeCents(input.usedCents, "Used"),
      weeklyBurnCents: normalizeCents(input.weeklyBurnCents, "Weekly burn"),
      targetMarginBps: normalizeBps(input.targetMarginBps, "Target margin"),
      currentMarginBps: normalizeBps(input.currentMarginBps, "Current margin"),
      sourceSatelliteId: input.sourceSatelliteId?.trim() || null,
    },
  });
}
