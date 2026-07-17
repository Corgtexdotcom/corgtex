import {
  CrmDealStage,
  Prisma,
  type MemberRole,
  type PracticeContributionCashStatus,
  type PracticeContributionEntry,
  type PracticeContributionPaymentChoice,
  type PracticeContributionType,
  type PracticeConsultant,
  type PracticeExpense,
  type PracticeTimeEntry,
  type PracticeProject,
  type PracticeProjectStatus,
  type User,
} from "@prisma/client";
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
export const SLICING_PIE_TIME_MULTIPLIER = 2;
export const SLICING_PIE_EXPENSE_MULTIPLIER = 4;
export const PRACTICE_LEDGER_CURRENCY = "USD";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PRISMA_INT_MAX = 2_147_483_647;

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

export type PracticeContributionEntryInput = {
  projectId: string;
  contributorUserId?: string | null;
  type: PracticeContributionType;
  paymentChoice: PracticeContributionPaymentChoice;
  description: string;
  occurredAt: Date;
  hoursTenths?: number | null;
  rateCents?: number | null;
  amountCents?: number | null;
  currency?: string | null;
  receiptUrl?: string | null;
};

export type PracticeContributionEntryWithContext = PracticeContributionEntry & {
  contributor: Pick<User, "id" | "displayName" | "email">;
  paidBy: Pick<User, "id" | "displayName" | "email"> | null;
  project: Pick<PracticeProject, "id" | "code" | "name" | "clientName">;
};

export type SlicingPieContributorSummary = {
  userId: string;
  displayName: string;
  email: string;
  timeValueCents: number;
  expenseValueCents: number;
  cashRequestedCents: number;
  cashPaidCents: number;
  slices: number;
  ownershipBps: number;
};

export type SlicingPieSummary = {
  totalSlices: number;
  contributors: SlicingPieContributorSummary[];
  entries: PracticeContributionEntryWithContext[];
  nextSourceCursor: string | null;
};

export type PracticeContributionEntryPage = {
  entries: PracticeContributionEntryWithContext[];
  nextCursor: string | null;
};

export type NativePracticeProject = Pick<
  PracticeProject,
  | "id"
  | "code"
  | "name"
  | "clientName"
  | "clientId"
  | "status"
  | "currency"
  | "poValueCents"
  | "serviceBudgetCents"
  | "expenseBudgetCents"
  | "usedCents"
  | "weeklyBurnCents"
  | "targetMarginBps"
  | "currentMarginBps"
>;

export type NativePracticeTimeEntry = Pick<
  PracticeTimeEntry,
  | "id"
  | "projectId"
  | "consultantId"
  | "workedOn"
  | "weekEndingOn"
  | "hours"
  | "currency"
  | "billCurrency"
  | "costCurrency"
  | "functionalCurrency"
  | "billRateCents"
  | "costRateCents"
  | "billAmountCents"
  | "costAmountCents"
  | "paidAmountCents"
  | "paymentBatchId"
  | "status"
>;

export type NativePracticeExpense = Pick<
  PracticeExpense,
  | "id"
  | "projectId"
  | "consultantId"
  | "spentOn"
  | "category"
  | "amountCents"
  | "currency"
  | "amountFunctionalCents"
  | "functionalCurrency"
  | "billable"
  | "paymentBatchId"
  | "status"
>;

export type NativePracticeConsultant = Pick<PracticeConsultant, "id" | "name" | "email" | "active">;

export type NativePracticeProjectHealth = {
  projectId: string;
  projectCode: string;
  projectName: string;
  clientId: string | null;
  clientName: string;
  status: PracticeProjectStatus;
  currency: string;
  budgetCents: number;
  serviceBudgetCents: number;
  expenseBudgetCents: number;
  usedBudgetCents: number;
  remainingBudgetCents: number;
  directCostCents: number;
  grossProfitCents: number;
  grossMarginBps: number;
  recentBudgetBurnPerWeekCents: number;
  recentCostBurnPerWeekCents: number;
  weeksToBudgetExhaustion: number | null;
  weeksToTargetMarginRisk: number | null;
  targetMarginBps: number | null;
  hasBudgetSetup: boolean;
  hasRecentBurn: boolean;
};

export type NativePracticeFinanceSummary = PracticeFinanceSummary & {
  currency: string | null;
  directCostCents: number;
  grossProfitCents: number;
  riskBudgetCount: number;
  riskMarginCount: number;
};

export type NativePracticeConsultantUtilization = {
  consultantId: string;
  consultantName: string;
  consultantEmail: string | null;
  active: boolean;
  projectIds: string[];
  capacityHoursPerWeek: number;
  recentHours: number;
  averageWeeklyHours: number;
  utilizationBps: number;
  currency: string | null;
  billedCents: number;
  costCents: number;
  expenseCents: number;
};

export type NativePracticeContributionSourceType = "TIME_ENTRY" | "EXPENSE";

export type NativePracticeContributionPreview = {
  sourceType: NativePracticeContributionSourceType;
  sourceId: string;
  projectId: string;
  consultantId: string | null;
  occurredAt: Date;
  currency: string;
  marketValueCents: number;
  paidAmountCents: number;
  unpaidAmountCents: number;
  multiplier: number;
  slices: number;
  paymentBatchId: string | null;
};

export type NativePracticeProjectHealthOptions = {
  now?: Date | null;
  recentWindowWeeks?: number | null;
};

export type NativePracticeProjectLedgerRollup = {
  projectId: string;
  timeRevenueCents: number;
  timeCostCents: number;
  billableExpenseCents: number;
  directExpenseCents: number;
  recentTimeRevenueCents: number;
  recentTimeCostCents: number;
  recentBillableExpenseCents: number;
  recentDirectExpenseCents: number;
  timeEntryCount: number;
  expenseCount: number;
};

type DbInt = number | bigint | string | null;

type NativePracticeTimeRollupRow = {
  projectId: string;
  timeRevenueCents: DbInt;
  timeCostCents: DbInt;
  recentTimeRevenueCents: DbInt;
  recentTimeCostCents: DbInt;
  timeEntryCount: DbInt;
  invalidHoursRows: DbInt;
  invalidCurrencyRows: DbInt;
};

type NativePracticeExpenseRollupRow = {
  projectId: string;
  billableExpenseCents: DbInt;
  directExpenseCents: DbInt;
  recentBillableExpenseCents: DbInt;
  recentDirectExpenseCents: DbInt;
  expenseCount: DbInt;
  invalidCurrencyRows: DbInt;
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

function centsToCurrency(cents: number, currency = PRACTICE_LEDGER_CURRENCY) {
  const amount = Math.round(cents / 100);
  const normalizedCurrency = normalizeCurrencyCode(currency) ?? PRACTICE_LEDGER_CURRENCY;
  try {
    return new Intl.NumberFormat("en-US", {
      currency: normalizedCurrency,
      maximumFractionDigits: 0,
      style: "currency",
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toLocaleString("en-US")}`;
  }
}

function centsToDollars(cents: number) {
  return centsToCurrency(cents, PRACTICE_LEDGER_CURRENCY);
}

function bpsToPct(bps: number) {
  return `${(bps / 100).toFixed(1)}%`;
}

type NativePracticeDecimalValue = { toNumber: () => number; toString?: () => string } | number | string;

function decimalToNumber(value: NativePracticeDecimalValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return value.toNumber();
}

function decimalToString(value: NativePracticeDecimalValue): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  const text = value.toString?.();
  return text && text !== "[object Object]" ? text : String(value.toNumber());
}

function dbIntToNumber(value: DbInt): number {
  if (value == null) return 0;
  return Number(value);
}

function centsFromHours(hours: NativePracticeDecimalValue, rateCents: number): number {
  const cents = new Prisma.Decimal(decimalToString(hours))
    .mul(rateCents)
    .toDecimalPlaces(0)
    .toNumber();
  invariant(
    Number.isSafeInteger(cents),
    400,
    "INVALID_INPUT",
    "Rate-derived cents must fit within the safe integer range.",
  );
  return cents;
}

function normalizeCurrencyCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

function assertNativePracticeTimeEntryHours(entry: NativePracticeTimeEntry) {
  const hours = decimalToNumber(entry.hours);
  invariant(
    Number.isFinite(hours) && hours >= 0,
    400,
    "INVALID_INPUT",
    "Native practice time entry hours must be finite and non-negative.",
  );
}

function firstCurrencyCode(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeCurrencyCode(value);
    if (normalized) return normalized;
  }
  return null;
}

function assertNativePracticeTimeEntryCurrency(project: NativePracticeProject, entry: NativePracticeTimeEntry) {
  const projectCurrency = normalizeCurrencyCode(project.currency);
  const billCurrency = practiceTimeBillAmountCurrency(entry);
  const costCurrency = practiceTimeCostAmountCurrency(entry);
  invariant(
    projectCurrency != null
    && billCurrency != null
    && costCurrency != null
    && billCurrency === projectCurrency
    && costCurrency === projectCurrency,
    400,
    "MIXED_CURRENCY",
    "Native practice finance requires time entry bill and cost amounts to be normalized to the project currency.",
  );
}

function assertNativePracticeExpenseCurrency(project: NativePracticeProject, expense: NativePracticeExpense) {
  const projectCurrency = normalizeCurrencyCode(project.currency);
  const expenseCurrency = practiceExpenseAmountCurrency(expense);
  invariant(
    projectCurrency != null
    && expenseCurrency != null
    && expenseCurrency === projectCurrency,
    400,
    "MIXED_CURRENCY",
    "Native practice finance requires expenses to be normalized to the project currency.",
  );
}

function practiceTimeBillAmountCurrency(entry: NativePracticeTimeEntry): string | null {
  return firstCurrencyCode(
    entry.billAmountCents == null ? null : entry.functionalCurrency,
    entry.billCurrency,
    entry.currency,
  );
}

function practiceTimeCostAmountCurrency(entry: NativePracticeTimeEntry): string | null {
  return firstCurrencyCode(
    entry.costAmountCents == null ? null : entry.functionalCurrency,
    entry.costCurrency,
    entry.currency,
  );
}

function practiceExpenseAmountCurrency(expense: NativePracticeExpense): string | null {
  return firstCurrencyCode(
    hasPracticeExpenseFunctionalAmount(expense) ? expense.functionalCurrency : null,
    expense.currency,
  );
}

function hasPracticeExpenseFunctionalAmount(expense: NativePracticeExpense): boolean {
  return expense.amountFunctionalCents != null && firstCurrencyCode(expense.functionalCurrency) != null;
}

function roundWeeks(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function roundHours(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function weekWindow(now: Date, weeks: number): { startsOn: Date; endsOn: Date } {
  return {
    startsOn: new Date(now.getTime() - weeks * WEEK_MS),
    endsOn: now,
  };
}

function isWithinDateWindow(value: Date, window: { startsOn: Date; endsOn: Date }): boolean {
  return value > window.startsOn && value <= window.endsOn;
}

function normalizeRecentWindowWeeks(value: number | null | undefined): number {
  if (value == null) return 4;
  invariant(Number.isInteger(value) && value > 0 && value <= 52, 400, "INVALID_INPUT", "recentWindowWeeks must be 1-52.");
  return value;
}

function normalizeNow(value: Date | null | undefined): Date {
  if (value == null) return new Date();
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), 400, "INVALID_INPUT", "now must be a valid date.");
  return value;
}

function calculateWeeksToMarginFloor(params: {
  usedBudgetCents: number;
  grossProfitCents: number;
  grossMarginBps: number;
  recentRevenueBurnPerWeekCents: number;
  recentCostBurnPerWeekCents: number;
  targetMarginBps: number | null;
}): number | null {
  if (params.targetMarginBps == null) return null;
  const targetMargin = params.targetMarginBps / 10_000;
  const currentHeadroomCents = params.grossProfitCents - params.usedBudgetCents * targetMargin;
  if (params.usedBudgetCents > 0 && params.grossMarginBps < params.targetMarginBps) return 0;
  if (currentHeadroomCents < 0) return 0;
  if (params.recentRevenueBurnPerWeekCents <= 0 && params.recentCostBurnPerWeekCents <= 0) return null;

  const weeklyHeadroomDeltaCents =
    params.recentRevenueBurnPerWeekCents * (1 - targetMargin) - params.recentCostBurnPerWeekCents;

  if (weeklyHeadroomDeltaCents >= 0) return null;
  if (currentHeadroomCents <= 0) return 0;

  return currentHeadroomCents / Math.abs(weeklyHeadroomDeltaCents);
}

function postedTimeEntries(entries: NativePracticeTimeEntry[]) {
  return entries.filter((entry) => entry.status === "POSTED");
}

function postedExpenses(expenses: NativePracticeExpense[]) {
  return expenses.filter((expense) => expense.status === "POSTED");
}

function addRequiredNativePracticeLedgerCurrency(
  currencies: Set<string>,
  currency: string | null,
  amountCents: number,
  message: string,
) {
  invariant(amountCents === 0 || currency != null, 400, "MIXED_CURRENCY", message);
  if (currency) currencies.add(currency);
}

function assertSingleNativePracticeLedgerCurrency(
  timeEntries: NativePracticeTimeEntry[],
  expenses: NativePracticeExpense[],
  message: string,
): string | null {
  const currencies = new Set<string>();
  for (const entry of timeEntries) {
    const billCurrency = practiceTimeBillAmountCurrency(entry);
    const costCurrency = practiceTimeCostAmountCurrency(entry);
    addRequiredNativePracticeLedgerCurrency(currencies, billCurrency, practiceTimeBillAmountCents(entry), message);
    addRequiredNativePracticeLedgerCurrency(currencies, costCurrency, practiceTimeCostAmountCents(entry), message);
  }
  for (const expense of expenses) {
    const expenseCurrency = practiceExpenseAmountCurrency(expense);
    addRequiredNativePracticeLedgerCurrency(currencies, expenseCurrency, practiceExpenseFunctionalAmountCents(expense), message);
  }
  invariant(currencies.size <= 1, 400, "MIXED_CURRENCY", message);
  return currencies.values().next().value ?? null;
}

function emptyNativePracticeProjectLedgerRollup(projectId: string): NativePracticeProjectLedgerRollup {
  return {
    projectId,
    timeRevenueCents: 0,
    timeCostCents: 0,
    billableExpenseCents: 0,
    directExpenseCents: 0,
    recentTimeRevenueCents: 0,
    recentTimeCostCents: 0,
    recentBillableExpenseCents: 0,
    recentDirectExpenseCents: 0,
    timeEntryCount: 0,
    expenseCount: 0,
  };
}

function rollupNativePracticeLedgerRows(params: {
  project: NativePracticeProject;
  timeEntries: NativePracticeTimeEntry[];
  expenses: NativePracticeExpense[];
  now: Date;
  recentWindowWeeks: number;
}): NativePracticeProjectLedgerRollup {
  const recent = weekWindow(params.now, params.recentWindowWeeks);
  const rollup = emptyNativePracticeProjectLedgerRollup(params.project.id);
  const timeEntries = postedTimeEntries(params.timeEntries).filter((entry) => entry.projectId === params.project.id);
  const expenses = postedExpenses(params.expenses).filter((expense) => expense.projectId === params.project.id);

  for (const entry of timeEntries) {
    assertNativePracticeTimeEntryHours(entry);
    assertNativePracticeTimeEntryCurrency(params.project, entry);
    rollup.timeEntryCount += 1;
    const revenueCents = practiceTimeBillAmountCents(entry);
    const costCents = practiceTimeCostAmountCents(entry);
    rollup.timeRevenueCents += revenueCents;
    rollup.timeCostCents += costCents;
    if (isWithinDateWindow(entry.workedOn, recent)) {
      rollup.recentTimeRevenueCents += revenueCents;
      rollup.recentTimeCostCents += costCents;
    }
  }

  for (const expense of expenses) {
    assertNativePracticeExpenseCurrency(params.project, expense);
    rollup.expenseCount += 1;
    const amountCents = practiceExpenseFunctionalAmountCents(expense);
    rollup.directExpenseCents += amountCents;
    if (expense.billable) rollup.billableExpenseCents += amountCents;
    if (isWithinDateWindow(expense.spentOn, recent)) {
      rollup.recentDirectExpenseCents += amountCents;
      if (expense.billable) rollup.recentBillableExpenseCents += amountCents;
    }
  }

  return rollup;
}

export function practiceTimeBillAmountCents(entry: NativePracticeTimeEntry): number {
  return entry.billAmountCents ?? centsFromHours(entry.hours, entry.billRateCents);
}

export function practiceTimeCostAmountCents(entry: NativePracticeTimeEntry): number {
  return entry.costAmountCents ?? centsFromHours(entry.hours, entry.costRateCents);
}

export function practiceExpenseFunctionalAmountCents(expense: NativePracticeExpense): number {
  return hasPracticeExpenseFunctionalAmount(expense) ? expense.amountFunctionalCents! : expense.amountCents;
}

export function calculateNativePracticeProjectHealth(params: {
  project: NativePracticeProject;
  timeEntries: NativePracticeTimeEntry[];
  expenses: NativePracticeExpense[];
} & NativePracticeProjectHealthOptions): NativePracticeProjectHealth {
  const now = normalizeNow(params.now);
  const recentWindowWeeks = normalizeRecentWindowWeeks(params.recentWindowWeeks);
  const rollup = rollupNativePracticeLedgerRows({
    project: params.project,
    timeEntries: params.timeEntries,
    expenses: params.expenses,
    now,
    recentWindowWeeks,
  });
  return calculateNativePracticeProjectHealthFromRollup({
    project: params.project,
    rollup,
    recentWindowWeeks,
  });
}

export function calculateNativePracticeProjectHealthFromRollup(params: {
  project: NativePracticeProject;
  rollup: NativePracticeProjectLedgerRollup;
  recentWindowWeeks?: number | null;
}): NativePracticeProjectHealth {
  const recentWindowWeeks = normalizeRecentWindowWeeks(params.recentWindowWeeks);
  const currency = normalizeCurrencyCode(params.project.currency);
  invariant(
    currency != null,
    400,
    "MIXED_CURRENCY",
    "Native practice project health requires a project currency.",
  );
  const hasNativeLedgerRows = params.rollup.timeEntryCount > 0 || params.rollup.expenseCount > 0;
  const ledgerUsedBudgetCents = params.rollup.timeRevenueCents + params.rollup.billableExpenseCents;
  const legacyGrossMarginBps = params.project.currentMarginBps ?? 0;
  const usedBudgetCents = hasNativeLedgerRows ? ledgerUsedBudgetCents : params.project.usedCents;
  const directCostCents = hasNativeLedgerRows
    ? params.rollup.timeCostCents + params.rollup.directExpenseCents
    : Math.max(0, usedBudgetCents - Math.round((usedBudgetCents * legacyGrossMarginBps) / 10_000));
  const remainingBudgetCents = params.project.poValueCents - usedBudgetCents;
  const grossProfitCents = usedBudgetCents - directCostCents;
  const grossMarginBps = usedBudgetCents > 0 ? Math.round((grossProfitCents / usedBudgetCents) * 10_000) : 0;
  const recentUsedBudgetCents = hasNativeLedgerRows
    ? params.rollup.recentTimeRevenueCents + params.rollup.recentBillableExpenseCents
    : params.project.weeklyBurnCents * recentWindowWeeks;
  const recentDirectCostCents = hasNativeLedgerRows
    ? params.rollup.recentTimeCostCents + params.rollup.recentDirectExpenseCents
    : Math.max(0, recentUsedBudgetCents - Math.round((recentUsedBudgetCents * legacyGrossMarginBps) / 10_000));

  const exactRecentBudgetBurnPerWeekCents = recentUsedBudgetCents / recentWindowWeeks;
  const exactRecentCostBurnPerWeekCents = recentDirectCostCents / recentWindowWeeks;
  const recentBudgetBurnPerWeekCents = Math.round(exactRecentBudgetBurnPerWeekCents);
  const recentCostBurnPerWeekCents = Math.round(exactRecentCostBurnPerWeekCents);
  const hasBudgetSetup =
    params.project.poValueCents > 0
    && params.project.serviceBudgetCents > 0
    && params.project.expenseBudgetCents > 0
    && params.project.targetMarginBps != null;
  const hasRecentBurn = exactRecentBudgetBurnPerWeekCents > 0 || exactRecentCostBurnPerWeekCents > 0;
  const weeksToBudgetExhaustion = hasBudgetSetup && remainingBudgetCents <= 0
    ? 0
    : hasBudgetSetup && exactRecentBudgetBurnPerWeekCents > 0
      ? remainingBudgetCents / exactRecentBudgetBurnPerWeekCents
      : null;
  const weeksToTargetMarginRisk = calculateWeeksToMarginFloor({
    grossMarginBps,
    grossProfitCents,
    recentCostBurnPerWeekCents: exactRecentCostBurnPerWeekCents,
    recentRevenueBurnPerWeekCents: exactRecentBudgetBurnPerWeekCents,
    targetMarginBps: params.project.targetMarginBps,
    usedBudgetCents,
  });

  return {
    projectId: params.project.id,
    projectCode: params.project.code,
    projectName: params.project.name,
    clientId: params.project.clientId,
    clientName: params.project.clientName,
    status: params.project.status,
    currency,
    budgetCents: params.project.poValueCents,
    serviceBudgetCents: params.project.serviceBudgetCents,
    expenseBudgetCents: params.project.expenseBudgetCents,
    usedBudgetCents,
    remainingBudgetCents,
    directCostCents,
    grossProfitCents,
    grossMarginBps,
    recentBudgetBurnPerWeekCents,
    recentCostBurnPerWeekCents,
    weeksToBudgetExhaustion,
    weeksToTargetMarginRisk,
    targetMarginBps: params.project.targetMarginBps,
    hasBudgetSetup,
    hasRecentBurn,
  };
}

export function summarizeNativePracticeFinance(health: NativePracticeProjectHealth[]): NativePracticeFinanceSummary {
  const active = health.filter((item) => item.status === "ACTIVE");
  const currencies = new Set<string>();
  for (const item of active) {
    const currency = normalizeCurrencyCode(item.currency);
    invariant(
      currency != null,
      400,
      "MIXED_CURRENCY",
      "Native practice finance summary requires active projects to have a currency.",
    );
    currencies.add(currency);
  }
  const mixedCurrency = currencies.size > 1;
  const currency = mixedCurrency ? null : currencies.values().next().value ?? null;
  const budgetCents = mixedCurrency ? 0 : active.reduce((sum, item) => sum + item.budgetCents, 0);
  const usedCents = mixedCurrency ? 0 : active.reduce((sum, item) => sum + item.usedBudgetCents, 0);
  const grossProfitCents = mixedCurrency ? 0 : active.reduce((sum, item) => sum + item.grossProfitCents, 0);
  const directCostCents = mixedCurrency ? 0 : active.reduce((sum, item) => sum + item.directCostCents, 0);
  const marginBps = !mixedCurrency && usedCents > 0 ? Math.round((grossProfitCents / usedCents) * 10_000) : null;

  return {
    activeProjects: active.length,
    currency,
    budgetCents,
    usedCents,
    remainingCents: budgetCents - usedCents,
    marginBps,
    directCostCents,
    grossProfitCents,
    riskBudgetCount: active.filter((item) =>
      item.weeksToBudgetExhaustion != null && item.weeksToBudgetExhaustion <= BUDGET_RUNWAY_ATTENTION_WEEKS
    ).length,
    riskMarginCount: active.filter((item) =>
      item.hasBudgetSetup
      && item.weeksToTargetMarginRisk != null
      && item.weeksToTargetMarginRisk <= BUDGET_RUNWAY_ATTENTION_WEEKS
    ).length,
  };
}

export function nativePracticeProjectAttentionItems(health: NativePracticeProjectHealth): PracticeAttentionItem[] {
  if (health.status !== "ACTIVE") return [];
  const items: PracticeAttentionItem[] = [];

  if (!health.hasBudgetSetup) {
    items.push({
      projectId: health.projectId,
      projectName: health.projectName,
      issue: "setup",
      weeks: null,
      detail: "Add PO value, service budget, expense budget, and target margin before forecasting.",
    });
    return items;
  }

  if (health.weeksToBudgetExhaustion != null && health.weeksToBudgetExhaustion <= BUDGET_RUNWAY_ATTENTION_WEEKS) {
    items.push({
      projectId: health.projectId,
      projectName: health.projectName,
      issue: "budget",
      weeks: roundWeeks(health.weeksToBudgetExhaustion),
      detail: `${centsToCurrency(health.remainingBudgetCents, health.currency)} remaining at ${centsToCurrency(health.recentBudgetBurnPerWeekCents, health.currency)} / week.`,
    });
  }

  if (health.weeksToTargetMarginRisk != null && health.weeksToTargetMarginRisk <= BUDGET_RUNWAY_ATTENTION_WEEKS && health.targetMarginBps != null) {
    items.push({
      projectId: health.projectId,
      projectName: health.projectName,
      issue: "margin",
      weeks: roundWeeks(health.weeksToTargetMarginRisk),
      detail: `Current margin ${bpsToPct(health.grossMarginBps)} vs target ${bpsToPct(health.targetMarginBps)}.`,
    });
  }

  return items;
}

export function collectNativePracticeAttention(health: NativePracticeProjectHealth[]): PracticeAttentionItem[] {
  return health.flatMap(nativePracticeProjectAttentionItems);
}

export function calculateNativePracticeConsultantUtilization(params: {
  consultant: NativePracticeConsultant;
  timeEntries: NativePracticeTimeEntry[];
  expenses: NativePracticeExpense[];
  capacityHoursPerWeek?: number | null;
} & NativePracticeProjectHealthOptions): NativePracticeConsultantUtilization {
  const now = normalizeNow(params.now);
  const recentWindowWeeks = normalizeRecentWindowWeeks(params.recentWindowWeeks);
  const recent = weekWindow(now, recentWindowWeeks);
  const timeEntries = postedTimeEntries(params.timeEntries).filter((entry) => entry.consultantId === params.consultant.id);
  const expenses = postedExpenses(params.expenses).filter((expense) => expense.consultantId === params.consultant.id);
  for (const entry of timeEntries) {
    assertNativePracticeTimeEntryHours(entry);
  }
  const currency = assertSingleNativePracticeLedgerCurrency(
    timeEntries,
    expenses,
    "Native practice consultant financial totals require one normalized currency.",
  );
  const recentHours = timeEntries
    .filter((entry) => isWithinDateWindow(entry.workedOn, recent))
    .reduce((sum, entry) => sum + decimalToNumber(entry.hours), 0);
  const billedCents = timeEntries.reduce((sum, entry) => sum + practiceTimeBillAmountCents(entry), 0);
  const costCents = timeEntries.reduce((sum, entry) => sum + practiceTimeCostAmountCents(entry), 0);
  const expenseCents = expenses.reduce((sum, expense) => sum + practiceExpenseFunctionalAmountCents(expense), 0);
  const capacityHoursPerWeek = params.capacityHoursPerWeek ?? 40;
  invariant(
    Number.isFinite(capacityHoursPerWeek) && capacityHoursPerWeek >= 0,
    400,
    "INVALID_INPUT",
    "capacityHoursPerWeek must be finite and non-negative.",
  );
  const rawAverageWeeklyHours = recentHours / recentWindowWeeks;
  const averageWeeklyHours = roundHours(rawAverageWeeklyHours);
  const utilizationBps = capacityHoursPerWeek > 0 ? Math.round((rawAverageWeeklyHours / capacityHoursPerWeek) * 10_000) : 0;
  const projectIds = [...new Set([
    ...timeEntries.map((entry) => entry.projectId),
    ...expenses.map((expense) => expense.projectId),
  ])].sort();

  return {
    consultantId: params.consultant.id,
    consultantName: params.consultant.name,
    consultantEmail: params.consultant.email,
    active: params.consultant.active,
    projectIds,
    capacityHoursPerWeek,
    recentHours: roundHours(recentHours),
    averageWeeklyHours,
    utilizationBps,
    currency,
    billedCents,
    costCents,
    expenseCents,
  };
}

function calculateContributionPreview(params: {
  sourceType: NativePracticeContributionSourceType;
  sourceId: string;
  projectId: string;
  consultantId: string | null;
  occurredAt: Date;
  currency: string | null;
  marketValueCents: number;
  paidAmountCents: number;
  multiplier: number;
  paymentBatchId: string | null;
}): NativePracticeContributionPreview {
  const currency = normalizeCurrencyCode(params.currency);
  invariant(
    currency === PRACTICE_LEDGER_CURRENCY,
    400,
    "MIXED_CURRENCY",
    "Slicing Pie contribution previews require USD amounts until contribution currency conversion is supported.",
  );
  invariant(
    Number.isInteger(params.marketValueCents) && params.marketValueCents >= 0,
    400,
    "INVALID_INPUT",
    "Contribution preview market value must be a non-negative integer number of cents.",
  );
  invariant(
    Number.isInteger(params.paidAmountCents) && params.paidAmountCents >= 0,
    400,
    "INVALID_INPUT",
    "Contribution preview paid amount must be a non-negative integer number of cents.",
  );
  const paidAmountCents = Math.min(Math.max(0, params.paidAmountCents), params.marketValueCents);
  const unpaidAmountCents = Math.max(0, params.marketValueCents - paidAmountCents);

  return {
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    projectId: params.projectId,
    consultantId: params.consultantId,
    occurredAt: params.occurredAt,
    currency,
    marketValueCents: params.marketValueCents,
    paidAmountCents,
    unpaidAmountCents,
    multiplier: params.multiplier,
    slices: unpaidAmountCents * params.multiplier,
    paymentBatchId: params.paymentBatchId,
  };
}

export function previewSlicingPieContributionFromTimeEntry(entry: NativePracticeTimeEntry): NativePracticeContributionPreview {
  invariant(entry.status === "POSTED", 400, "INVALID_STATE", "Only posted time entries can produce contribution previews.");
  invariant(
    entry.paymentBatchId == null || entry.paidAmountCents != null,
    400,
    "INVALID_INPUT",
    "Batched time entry contribution previews require the paid amount allocation.",
  );
  const marketValueCents = practiceTimeCostAmountCents(entry);
  return calculateContributionPreview({
    sourceType: "TIME_ENTRY",
    sourceId: entry.id,
    projectId: entry.projectId,
    consultantId: entry.consultantId,
    occurredAt: entry.workedOn,
    currency: practiceTimeCostAmountCurrency(entry),
    marketValueCents,
    paidAmountCents: entry.paidAmountCents ?? 0,
    multiplier: SLICING_PIE_TIME_MULTIPLIER,
    paymentBatchId: entry.paymentBatchId,
  });
}

export function previewSlicingPieContributionFromExpense(
  expense: NativePracticeExpense,
  options: { paidAmountCents?: number | null } = {},
): NativePracticeContributionPreview {
  invariant(expense.status === "POSTED", 400, "INVALID_STATE", "Only posted expenses can produce contribution previews.");
  invariant(
    expense.consultantId != null,
    400,
    "INVALID_INPUT",
    "Posted expenses must have a consultant before producing contribution previews.",
  );
  invariant(
    expense.paymentBatchId == null || options.paidAmountCents != null,
    400,
    "INVALID_INPUT",
    "Batched expense contribution previews require the paid amount allocation.",
  );
  const marketValueCents = practiceExpenseFunctionalAmountCents(expense);
  return calculateContributionPreview({
    sourceType: "EXPENSE",
    sourceId: expense.id,
    projectId: expense.projectId,
    consultantId: expense.consultantId,
    occurredAt: expense.spentOn,
    currency: practiceExpenseAmountCurrency(expense) ?? expense.currency,
    marketValueCents,
    paidAmountCents: options.paidAmountCents ?? 0,
    multiplier: SLICING_PIE_EXPENSE_MULTIPLIER,
    paymentBatchId: expense.paymentBatchId,
  });
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
const FINANCE_FEATURE_FLAG = "FINANCE";
const PRACTICE_PROJECTS_ALL_MEMBER_WRITE_CONFIG_KEY = "practiceProjectsAllMemberWrite";

function practiceProjectAllMemberWriteEnabled(config: unknown) {
  return Boolean(
    config
      && typeof config === "object"
      && PRACTICE_PROJECTS_ALL_MEMBER_WRITE_CONFIG_KEY in config
      && (config as Record<string, unknown>)[PRACTICE_PROJECTS_ALL_MEMBER_WRITE_CONFIG_KEY] === true,
  );
}

async function workspaceAllowsAllMemberPracticeProjectWrites(workspaceId: string) {
  const flag = await prisma.workspaceFeatureFlag.findUnique({
    where: { workspaceId_flag: { workspaceId, flag: FINANCE_FEATURE_FLAG } },
    select: { enabled: true, config: true },
  });
  return Boolean(flag?.enabled && practiceProjectAllMemberWriteEnabled(flag.config));
}

export async function canManagePracticeFinanceProjects(
  actor: AppActor,
  workspaceId: string,
  options: { resolvedMembership?: { role: MemberRole | string | null } | null } = {},
) {
  if (actor.kind === "agent") return true;
  const membership = options.resolvedMembership ?? await requireWorkspaceMembership({ actor, workspaceId });
  if (membership?.role && PRACTICE_FINANCE_MANAGE_ROLES.includes(membership.role as MemberRole)) return true;
  return workspaceAllowsAllMemberPracticeProjectWrites(workspaceId);
}

export async function canManagePracticeContributionPayments(
  actor: AppActor,
  workspaceId: string,
  options: { resolvedMembership?: { role: MemberRole | string | null } | null } = {},
) {
  if (actor.kind === "agent") return true;
  const membership = options.resolvedMembership ?? await requireWorkspaceMembership({ actor, workspaceId });
  return Boolean(membership?.role && PRACTICE_FINANCE_MANAGE_ROLES.includes(membership.role as MemberRole));
}

async function requirePracticeFinanceWrite(actor: AppActor, workspaceId: string) {
  if (actor.kind === "agent") {
    await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: PRACTICE_FINANCE_MANAGE_ROLES });
    return;
  }

  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  invariant(
    await canManagePracticeFinanceProjects(actor, workspaceId, { resolvedMembership: membership }),
    403,
    "FORBIDDEN",
    "Insufficient permissions.",
  );
}

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

export type UpdatePracticeProjectInput = {
  projectId: string;
  code?: string;
  name?: string;
  clientName?: string;
  status?: PracticeProjectStatus;
  poValueCents?: number;
  serviceBudgetCents?: number;
  expenseBudgetCents?: number;
  usedCents?: number;
  weeklyBurnCents?: number;
  targetMarginBps?: number | null;
  currentMarginBps?: number | null;
};

export type ListPracticeProjectsOptions = {
  take?: number | null;
  cursor?: string | null;
};

export type ListNativePracticeProjectHealthOptions = ListPracticeProjectsOptions & NativePracticeProjectHealthOptions;

export type NativePracticeFinanceDashboard = {
  summary: NativePracticeFinanceSummary;
  attention: PracticeAttentionItem[];
  projectHealth: NativePracticeProjectHealth[];
};

export type NativePracticeProjectDetail = {
  project: Prisma.PracticeProjectGetPayload<{
    include: {
      billingCode: true;
      client: true;
      _count: { select: { assignments: true; lines: true; purchaseOrders: true } };
    };
  }>;
  health: NativePracticeProjectHealth;
  recentTimeEntries: Array<Prisma.PracticeTimeEntryGetPayload<{
    include: {
      consultant: { select: { id: true; name: true; email: true } };
      reviews: { select: { id: true; status: true; note: true; updatedAt: true } };
    };
  }>>;
  recentExpenses: Array<Prisma.PracticeExpenseGetPayload<{
    include: {
      consultant: { select: { id: true; name: true; email: true } };
      reviews: { select: { id: true; status: true; note: true; updatedAt: true } };
    };
  }>>;
  consultants: NativePracticeConsultant[];
};

export type CreateNativePracticeTimeEntryInput = {
  projectId: string;
  consultantName: string;
  consultantEmail?: string | null;
  workedOn: Date;
  hours: number;
  assignmentType?: string | null;
  billRateCents?: number | null;
  costRateCents?: number | null;
  idempotencyKey?: string | null;
};

export type CreateNativePracticeExpenseInput = {
  projectId: string;
  consultantName?: string | null;
  consultantEmail?: string | null;
  spentOn: Date;
  vendor?: string | null;
  category: string;
  businessPurpose: string;
  amountCents: number;
  currency?: string | null;
  billable?: boolean | null;
  idempotencyKey?: string | null;
};

export type ListPracticeContributionEntriesOptions = {
  take?: number | null;
  cursor?: string | null;
};

export type SlicingPieSummaryOptions = {
  sourceTake?: number | null;
  sourceCursor?: string | null;
};

export type CrmAccountPracticeFinanceProject = PracticeProject & {
  crmDeal: {
    id: string;
    title: string;
    stage: CrmDealStage;
    valueCents: number | null;
    currency: string;
  } | null;
};

export type CrmAccountPracticeFinance = {
  summary: NativePracticeFinanceSummary;
  projects: CrmAccountPracticeFinanceProject[];
  projectHealth: NativePracticeProjectHealth[];
};

export type CreatePracticeProjectFromWonDealInput = {
  dealId: string;
  code?: string | null;
  name?: string | null;
  clientName?: string | null;
  poValueCents?: number | null;
  serviceBudgetCents?: number;
  expenseBudgetCents?: number;
  weeklyBurnCents?: number;
  targetMarginBps?: number | null;
  currentMarginBps?: number | null;
};

const DEFAULT_PRACTICE_PROJECT_TAKE = 100;
const MAX_PRACTICE_PROJECT_TAKE = 200;
const DEFAULT_CONTRIBUTION_ENTRY_TAKE = 50;
const MAX_CONTRIBUTION_ENTRY_TAKE = 100;
const PRACTICE_PROJECT_STATUSES: PracticeProjectStatus[] = ["ACTIVE", "ON_HOLD", "CLOSED"];

function normalizeCents(value: number | undefined, label: string): number {
  const cents = value ?? 0;
  invariant(
    Number.isInteger(cents) && cents >= 0 && cents <= PRISMA_INT_MAX,
    400,
    "INVALID_INPUT",
    `${label} must be a non-negative integer (cents) within the database range.`,
  );
  return cents;
}

function normalizePositiveCents(value: number | null | undefined, label: string): number {
  const cents = normalizeCents(value ?? undefined, label);
  invariant(cents > 0, 400, "INVALID_INPUT", `${label} must be greater than zero.`);
  return cents;
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

type PracticeFinanceDbClient = typeof prisma | Prisma.TransactionClient;

function normalizeBps(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  invariant(Number.isInteger(value) && value >= 0 && value <= 10000, 400, "INVALID_INPUT", `${label} must be 0-10000 basis points.`);
  return value;
}

function normalizeOptionalCents(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : normalizeCents(value, label);
}

function normalizeOptionalBps(value: number | null | undefined, label: string): number | null | undefined {
  return value === undefined ? undefined : normalizeBps(value, label);
}

function normalizeRequiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  invariant(normalized, 400, "INVALID_INPUT", `${label} is required.`);
  return normalized;
}

function normalizeContributionType(value: PracticeContributionType): PracticeContributionType {
  invariant(value === "TIME" || value === "EXPENSE", 400, "INVALID_INPUT", "Invalid contribution type.");
  return value;
}

function normalizePaymentChoice(value: PracticeContributionPaymentChoice): PracticeContributionPaymentChoice {
  invariant(value === "CASH" || value === "SLICING_PIE", 400, "INVALID_INPUT", "Invalid payment choice.");
  return value;
}

function normalizeContributionDate(value: Date): Date {
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), 400, "INVALID_INPUT", "Contribution date is required.");
  return value;
}

function normalizeCurrency(value: string | null | undefined): string {
  const currency = (value?.trim() || PRACTICE_LEDGER_CURRENCY).toUpperCase();
  invariant(/^[A-Z]{3}$/.test(currency), 400, "INVALID_INPUT", "Currency must be a three-letter code.");
  invariant(
    currency === PRACTICE_LEDGER_CURRENCY,
    400,
    "INVALID_INPUT",
    `Practice Ledger contributions must use ${PRACTICE_LEDGER_CURRENCY} until currency conversion is supported.`,
  );
  return currency;
}

function normalizeOptionalReceiptUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function calculatePracticeContributionAmount(input: {
  type: PracticeContributionType;
  hoursTenths?: number | null;
  rateCents?: number | null;
  amountCents?: number | null;
}): { amountCents: number; hoursTenths: number | null; rateCents: number | null } {
  const type = normalizeContributionType(input.type);
  if (type === "TIME") {
    const hoursTenths = input.hoursTenths ?? null;
    const rateCents = input.rateCents ?? null;
    invariant(typeof hoursTenths === "number" && Number.isInteger(hoursTenths) && hoursTenths > 0, 400, "INVALID_INPUT", "Hours must be greater than zero.");
    invariant(typeof rateCents === "number" && Number.isInteger(rateCents) && rateCents > 0, 400, "INVALID_INPUT", "Hourly rate must be greater than zero.");
    return {
      amountCents: Math.round((hoursTenths * rateCents) / 10),
      hoursTenths,
      rateCents,
    };
  }

  return {
    amountCents: normalizePositiveCents(input.amountCents, "Expense amount"),
    hoursTenths: null,
    rateCents: null,
  };
}

export function calculatePracticeContributionSlices(input: {
  type: PracticeContributionType;
  paymentChoice: PracticeContributionPaymentChoice;
  amountCents: number;
}): { sliceMultiplier: number; slices: number; cashStatus: PracticeContributionCashStatus } {
  const paymentChoice = normalizePaymentChoice(input.paymentChoice);
  if (paymentChoice === "CASH") {
    return { sliceMultiplier: 0, slices: 0, cashStatus: "REQUESTED" };
  }
  const multiplier = input.type === "TIME" ? SLICING_PIE_TIME_MULTIPLIER : SLICING_PIE_EXPENSE_MULTIPLIER;
  return {
    sliceMultiplier: multiplier,
    slices: input.amountCents * multiplier,
    cashStatus: "NOT_APPLICABLE",
  };
}

function normalizeOptionalText(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizeRequiredText(value, label);
}

function normalizeProjectStatus(value: PracticeProjectStatus | undefined): PracticeProjectStatus | undefined {
  if (value === undefined) return undefined;
  invariant(PRACTICE_PROJECT_STATUSES.includes(value), 400, "INVALID_INPUT", "Invalid project status.");
  return value;
}

function normalizeTake(value: number | null | undefined): number {
  if (value == null) return DEFAULT_PRACTICE_PROJECT_TAKE;
  invariant(Number.isInteger(value), 400, "INVALID_INPUT", "take must be an integer.");
  return Math.min(Math.max(value, 1), MAX_PRACTICE_PROJECT_TAKE);
}

function normalizeContributionTake(value: number | null | undefined): number {
  if (value == null) return DEFAULT_CONTRIBUTION_ENTRY_TAKE;
  invariant(Number.isInteger(value), 400, "INVALID_INPUT", "take must be an integer.");
  return Math.min(Math.max(value, 1), MAX_CONTRIBUTION_ENTRY_TAKE);
}

function normalizeCursor(value: string | null | undefined): string | null {
  const cursor = value?.trim();
  return cursor || null;
}

function normalizeProjectCode(value: string) {
  const normalized = normalizeProjectCodeBase(value).slice(0, 80);
  invariant(normalized.length > 0, 400, "INVALID_INPUT", "Project code is required.");
  return normalized;
}

function normalizeProjectCodeBase(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function projectIdCodeSuffix(projectId: string) {
  return projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "PROJECT";
}

function defaultProjectCode(deal: { id: string; title: string; account?: { slug: string } | null }) {
  const base = deal.account?.slug || deal.title;
  const normalizedBase = normalizeProjectCodeBase(base).slice(0, 48).replace(/-+$/g, "") || "CRM";
  return `${normalizedBase}-${deal.id.slice(0, 8).toUpperCase()}`;
}

function normalizeNativeLedgerDate(value: Date, label: string): Date {
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), 400, "INVALID_INPUT", `${label} is required.`);
  return value;
}

function normalizeNativeLedgerHours(value: number): Prisma.Decimal {
  invariant(Number.isFinite(value) && value > 0, 400, "INVALID_INPUT", "Hours must be greater than zero.");
  invariant(value <= 999_999.99, 400, "INVALID_INPUT", "Hours exceed the native Practice Ledger limit.");
  const hours = new Prisma.Decimal(value).toDecimalPlaces(2);
  invariant(hours.gt(0), 400, "INVALID_INPUT", "Hours must be greater than zero.");
  return hours;
}

function normalizeNativeLedgerCurrency(value: string | null | undefined, projectCurrency: string): string {
  const normalizedProjectCurrency = normalizeCurrencyCode(projectCurrency);
  const normalizedInputCurrency = normalizeCurrencyCode(value) ?? normalizedProjectCurrency;
  invariant(normalizedProjectCurrency, 400, "MIXED_CURRENCY", "Native practice ledger entries require a project currency.");
  invariant(
    normalizedInputCurrency === normalizedProjectCurrency,
    400,
    "MIXED_CURRENCY",
    "Native practice ledger entries must use the project currency until conversion is supported.",
  );
  return normalizedProjectCurrency;
}

function normalizeOptionalNativeText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeConsultantEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function manualLedgerConsultantSourceId(idempotencyKey: string | null | undefined): string | null {
  return idempotencyKey ? `manual-ledger-consultant:${idempotencyKey}` : null;
}

function weekEndingSundayUtc(workedOn: Date): Date {
  const date = new Date(Date.UTC(workedOn.getUTCFullYear(), workedOn.getUTCMonth(), workedOn.getUTCDate()));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + ((7 - day) % 7));
  return date;
}

function nativePracticeProjectFromProject(project: Pick<
  PracticeProject,
  | "id"
  | "code"
  | "name"
  | "clientName"
  | "clientId"
  | "status"
  | "currency"
  | "poValueCents"
  | "serviceBudgetCents"
  | "expenseBudgetCents"
  | "usedCents"
  | "weeklyBurnCents"
  | "targetMarginBps"
  | "currentMarginBps"
>): NativePracticeProject {
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    clientName: project.clientName,
    clientId: project.clientId,
    status: project.status,
    currency: project.currency,
    poValueCents: project.poValueCents,
    serviceBudgetCents: project.serviceBudgetCents,
    expenseBudgetCents: project.expenseBudgetCents,
    usedCents: project.usedCents,
    weeklyBurnCents: project.weeklyBurnCents,
    targetMarginBps: project.targetMarginBps,
    currentMarginBps: project.currentMarginBps,
  };
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

const NATIVE_PRACTICE_PROJECT_SELECT = {
  id: true,
  code: true,
  name: true,
  clientName: true,
  clientId: true,
  status: true,
  currency: true,
  poValueCents: true,
  serviceBudgetCents: true,
  expenseBudgetCents: true,
  usedCents: true,
  weeklyBurnCents: true,
  targetMarginBps: true,
  currentMarginBps: true,
} satisfies Prisma.PracticeProjectSelect;

function mergeNativePracticeLedgerRollups(
  projectIds: string[],
  timeRows: NativePracticeTimeRollupRow[],
  expenseRows: NativePracticeExpenseRollupRow[],
) {
  const rollups = new Map(projectIds.map((projectId) => [
    projectId,
    emptyNativePracticeProjectLedgerRollup(projectId),
  ]));

  for (const row of timeRows) {
    invariant(
      dbIntToNumber(row.invalidHoursRows) === 0,
      400,
      "INVALID_INPUT",
      "Native practice finance requires time entry hours to be finite and non-negative.",
    );
    invariant(
      dbIntToNumber(row.invalidCurrencyRows) === 0,
      400,
      "MIXED_CURRENCY",
      "Native practice finance requires time entry bill and cost amounts to be normalized to the project currency.",
    );
    const rollup = rollups.get(row.projectId) ?? emptyNativePracticeProjectLedgerRollup(row.projectId);
    rollup.timeRevenueCents = dbIntToNumber(row.timeRevenueCents);
    rollup.timeCostCents = dbIntToNumber(row.timeCostCents);
    rollup.recentTimeRevenueCents = dbIntToNumber(row.recentTimeRevenueCents);
    rollup.recentTimeCostCents = dbIntToNumber(row.recentTimeCostCents);
    rollup.timeEntryCount = Math.max(1, dbIntToNumber(row.timeEntryCount));
    rollups.set(row.projectId, rollup);
  }

  for (const row of expenseRows) {
    invariant(
      dbIntToNumber(row.invalidCurrencyRows) === 0,
      400,
      "MIXED_CURRENCY",
      "Native practice finance requires expenses to be normalized to the project currency.",
    );
    const rollup = rollups.get(row.projectId) ?? emptyNativePracticeProjectLedgerRollup(row.projectId);
    rollup.billableExpenseCents = dbIntToNumber(row.billableExpenseCents);
    rollup.directExpenseCents = dbIntToNumber(row.directExpenseCents);
    rollup.recentBillableExpenseCents = dbIntToNumber(row.recentBillableExpenseCents);
    rollup.recentDirectExpenseCents = dbIntToNumber(row.recentDirectExpenseCents);
    rollup.expenseCount = Math.max(1, dbIntToNumber(row.expenseCount));
    rollups.set(row.projectId, rollup);
  }

  return rollups;
}

async function queryNativePracticeLedgerRollups(
  workspaceId: string,
  projectIds: string[],
  recent: { startsOn: Date; endsOn: Date },
): Promise<Map<string, NativePracticeProjectLedgerRollup>> {
  if (projectIds.length === 0) return new Map();

  const [timeRollups, expenseRollups] = await Promise.all([
    prisma.$queryRaw<NativePracticeTimeRollupRow[]>(Prisma.sql`
      SELECT
        t."projectId",
        COALESCE(SUM(COALESCE(t."billAmountCents"::numeric, ROUND(t."hours" * t."billRateCents"))), 0)::bigint AS "timeRevenueCents",
        COALESCE(SUM(COALESCE(t."costAmountCents"::numeric, ROUND(t."hours" * t."costRateCents"))), 0)::bigint AS "timeCostCents",
        COALESCE(SUM(
          CASE WHEN t."workedOn" > ${recent.startsOn} AND t."workedOn" <= ${recent.endsOn}
            THEN COALESCE(t."billAmountCents"::numeric, ROUND(t."hours" * t."billRateCents"))
            ELSE 0
          END
        ), 0)::bigint AS "recentTimeRevenueCents",
        COALESCE(SUM(
          CASE WHEN t."workedOn" > ${recent.startsOn} AND t."workedOn" <= ${recent.endsOn}
            THEN COALESCE(t."costAmountCents"::numeric, ROUND(t."hours" * t."costRateCents"))
            ELSE 0
          END
        ), 0)::bigint AS "recentTimeCostCents",
        COALESCE(SUM(
          CASE WHEN t."hours" < 0
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidHoursRows",
        COALESCE(SUM(
          CASE WHEN
            NULLIF(BTRIM(p."currency"), '') IS NULL
            OR COALESCE(
              CASE WHEN t."billAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."billCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            ) IS NULL
            OR COALESCE(
              CASE WHEN t."costAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."costCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            ) IS NULL
            OR UPPER(COALESCE(
              CASE WHEN t."billAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."billCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            OR UPPER(COALESCE(
              CASE WHEN t."costAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."costCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidCurrencyRows",
        COUNT(*)::bigint AS "timeEntryCount"
      FROM "PracticeTimeEntry" t
      JOIN "PracticeProject" p
        ON p."id" = t."projectId"
        AND p."workspaceId" = t."workspaceId"
      WHERE t."workspaceId" = ${workspaceId}
        AND t."projectId" IN (${Prisma.join(projectIds)})
        AND t."status" = 'POSTED'
      GROUP BY t."projectId"
    `),
    prisma.$queryRaw<NativePracticeExpenseRollupRow[]>(Prisma.sql`
      SELECT
        e."projectId",
        COALESCE(SUM(
          CASE WHEN e."billable"
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "billableExpenseCents",
        COALESCE(SUM((
          CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
            THEN e."amountFunctionalCents"
            ELSE e."amountCents"
          END
        )::numeric), 0)::bigint AS "directExpenseCents",
        COALESCE(SUM(
          CASE WHEN e."billable" AND e."spentOn" > ${recent.startsOn} AND e."spentOn" <= ${recent.endsOn}
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "recentBillableExpenseCents",
        COALESCE(SUM(
          CASE WHEN e."spentOn" > ${recent.startsOn} AND e."spentOn" <= ${recent.endsOn}
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "recentDirectExpenseCents",
        COALESCE(SUM(
          CASE WHEN NULLIF(BTRIM(p."currency"), '') IS NULL
            OR COALESCE(
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN NULLIF(BTRIM(e."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(e."currency"), '')
            ) IS NULL
            OR UPPER(COALESCE(
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN NULLIF(BTRIM(e."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(e."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidCurrencyRows",
        COUNT(*)::bigint AS "expenseCount"
      FROM "PracticeExpense" e
      JOIN "PracticeProject" p
        ON p."id" = e."projectId"
        AND p."workspaceId" = e."workspaceId"
      WHERE e."workspaceId" = ${workspaceId}
        AND e."projectId" IN (${Prisma.join(projectIds)})
        AND e."status" = 'POSTED'
      GROUP BY e."projectId"
    `),
  ]);

  return mergeNativePracticeLedgerRollups(projectIds, timeRollups, expenseRollups);
}

export async function listNativePracticeProjectHealth(
  actor: AppActor,
  workspaceId: string,
  options: ListNativePracticeProjectHealthOptions = {},
): Promise<NativePracticeProjectHealth[]> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const cursor = normalizeCursor(options.cursor);
  const now = normalizeNow(options.now);
  const recentWindowWeeks = normalizeRecentWindowWeeks(options.recentWindowWeeks);
  const recent = weekWindow(now, recentWindowWeeks);
  const projects = await prisma.practiceProject.findMany({
    where: { workspaceId },
    select: NATIVE_PRACTICE_PROJECT_SELECT,
    orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
    take: normalizeTake(options.take),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const projectIds = projects.map((project) => project.id);
  if (projectIds.length === 0) return [];

  const [timeRollups, expenseRollups] = await Promise.all([
    prisma.$queryRaw<NativePracticeTimeRollupRow[]>(Prisma.sql`
      SELECT
        t."projectId",
        COALESCE(SUM(COALESCE(t."billAmountCents"::numeric, ROUND(t."hours" * t."billRateCents"))), 0)::bigint AS "timeRevenueCents",
        COALESCE(SUM(COALESCE(t."costAmountCents"::numeric, ROUND(t."hours" * t."costRateCents"))), 0)::bigint AS "timeCostCents",
        COALESCE(SUM(
          CASE WHEN t."workedOn" > ${recent.startsOn} AND t."workedOn" <= ${recent.endsOn}
            THEN COALESCE(t."billAmountCents"::numeric, ROUND(t."hours" * t."billRateCents"))
            ELSE 0
          END
        ), 0)::bigint AS "recentTimeRevenueCents",
        COALESCE(SUM(
          CASE WHEN t."workedOn" > ${recent.startsOn} AND t."workedOn" <= ${recent.endsOn}
            THEN COALESCE(t."costAmountCents"::numeric, ROUND(t."hours" * t."costRateCents"))
            ELSE 0
          END
        ), 0)::bigint AS "recentTimeCostCents",
        COALESCE(SUM(
          CASE WHEN t."hours" < 0
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidHoursRows",
        COALESCE(SUM(
          CASE WHEN
            NULLIF(BTRIM(p."currency"), '') IS NULL
            OR COALESCE(
              CASE WHEN t."billAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."billCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            ) IS NULL
            OR COALESCE(
              CASE WHEN t."costAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."costCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            ) IS NULL
            OR UPPER(COALESCE(
              CASE WHEN t."billAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."billCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            OR UPPER(COALESCE(
              CASE WHEN t."costAmountCents" IS NOT NULL
                THEN NULLIF(BTRIM(t."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(t."costCurrency"), ''),
              NULLIF(BTRIM(t."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidCurrencyRows",
        COUNT(*)::bigint AS "timeEntryCount"
      FROM "PracticeTimeEntry" t
      JOIN "PracticeProject" p
        ON p."id" = t."projectId"
        AND p."workspaceId" = t."workspaceId"
      WHERE t."workspaceId" = ${workspaceId}
        AND t."projectId" IN (${Prisma.join(projectIds)})
        AND t."status" = 'POSTED'
      GROUP BY t."projectId"
    `),
    prisma.$queryRaw<NativePracticeExpenseRollupRow[]>(Prisma.sql`
      SELECT
        e."projectId",
        COALESCE(SUM(
          CASE WHEN e."billable"
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "billableExpenseCents",
        COALESCE(SUM((
          CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
            THEN e."amountFunctionalCents"
            ELSE e."amountCents"
          END
        )::numeric), 0)::bigint AS "directExpenseCents",
        COALESCE(SUM(
          CASE WHEN e."billable" AND e."spentOn" > ${recent.startsOn} AND e."spentOn" <= ${recent.endsOn}
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "recentBillableExpenseCents",
        COALESCE(SUM(
          CASE WHEN e."spentOn" > ${recent.startsOn} AND e."spentOn" <= ${recent.endsOn}
            THEN (
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN e."amountFunctionalCents"
                ELSE e."amountCents"
              END
            )::numeric
            ELSE 0
          END
        ), 0)::bigint AS "recentDirectExpenseCents",
        COALESCE(SUM(
          CASE WHEN NULLIF(BTRIM(p."currency"), '') IS NULL
            OR COALESCE(
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN NULLIF(BTRIM(e."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(e."currency"), '')
            ) IS NULL
            OR UPPER(COALESCE(
              CASE WHEN e."amountFunctionalCents" IS NOT NULL AND NULLIF(BTRIM(e."functionalCurrency"), '') IS NOT NULL
                THEN NULLIF(BTRIM(e."functionalCurrency"), '')
                ELSE NULL
              END,
              NULLIF(BTRIM(e."currency"), '')
            )) IS DISTINCT FROM UPPER(NULLIF(BTRIM(p."currency"), ''))
            THEN 1
            ELSE 0
          END
        ), 0)::bigint AS "invalidCurrencyRows",
        COUNT(*)::bigint AS "expenseCount"
      FROM "PracticeExpense" e
      JOIN "PracticeProject" p
        ON p."id" = e."projectId"
        AND p."workspaceId" = e."workspaceId"
      WHERE e."workspaceId" = ${workspaceId}
        AND e."projectId" IN (${Prisma.join(projectIds)})
        AND e."status" = 'POSTED'
      GROUP BY e."projectId"
    `),
  ]);

  const rollups = mergeNativePracticeLedgerRollups(projectIds, timeRollups, expenseRollups);

  return projects.map((project) => calculateNativePracticeProjectHealthFromRollup({
    project,
    rollup: rollups.get(project.id) ?? emptyNativePracticeProjectLedgerRollup(project.id),
    recentWindowWeeks,
  }));
}

export async function getNativePracticeFinanceDashboard(
  actor: AppActor,
  workspaceId: string,
  options: ListNativePracticeProjectHealthOptions = {},
): Promise<NativePracticeFinanceDashboard> {
  const projectHealth: NativePracticeProjectHealth[] = [];
  let cursor: string | null = null;
  const take = MAX_PRACTICE_PROJECT_TAKE;

  while (true) {
    const page = await listNativePracticeProjectHealth(actor, workspaceId, {
      ...options,
      cursor,
      take,
    });
    projectHealth.push(...page);
    if (page.length < take) break;
    cursor = page.at(-1)?.projectId ?? null;
    if (!cursor) break;
  }

  return {
    summary: summarizeNativePracticeFinance(projectHealth),
    attention: collectNativePracticeAttention(projectHealth),
    projectHealth,
  };
}

async function requireProjectInWorkspace(workspaceId: string, projectId: string) {
  const project = await prisma.practiceProject.findUnique({
    where: { id: projectId.trim() },
    select: { id: true, workspaceId: true },
  });
  invariant(project && project.workspaceId === workspaceId, 404, "NOT_FOUND", "Practice project not found.");
  return project;
}

async function loadNativePracticeProjectForLedgerWrite(workspaceId: string, projectId: string) {
  const id = projectId.trim();
  invariant(id, 400, "INVALID_INPUT", "Project is required.");
  const project = await prisma.practiceProject.findUnique({
    where: { id },
    select: {
      id: true,
      workspaceId: true,
      crmAccountId: true,
      clientId: true,
      billingCodeId: true,
      code: true,
      clientName: true,
      currency: true,
    },
  });
  invariant(project && project.workspaceId === workspaceId, 404, "NOT_FOUND", "Practice project not found.");
  normalizeNativeLedgerCurrency(null, project.currency);
  return project;
}

function nativePracticeClientMatchesProject(
  client: { crmAccountId: string | null; name: string },
  project: Awaited<ReturnType<typeof loadNativePracticeProjectForLedgerWrite>>,
) {
  return (
    (project.crmAccountId && client.crmAccountId === project.crmAccountId)
    || (
      !project.crmAccountId
      && !client.crmAccountId
      && client.name.localeCompare(project.clientName, undefined, { sensitivity: "accent" }) === 0
    )
  );
}

async function linkNativePracticeProjectClient(projectId: string, clientId: string) {
  await prisma.practiceProject.update({
    where: { id: projectId },
    data: { clientId },
  });
  return clientId;
}

function nativePracticeConsultantLookupWhere(params: {
  workspaceId: string;
  displayName: string;
  email: string | null;
}) {
  return {
    workspaceId: params.workspaceId,
    ...(params.email
      ? { email: { equals: params.email, mode: "insensitive" as const } }
      : { name: { equals: params.displayName, mode: "insensitive" as const } }),
  };
}

async function findNativePracticeConsultantMatches(
  db: PracticeFinanceDbClient,
  params: {
    workspaceId: string;
    displayName: string;
    email: string | null;
  },
) {
  return db.practiceConsultant.findMany({
    where: nativePracticeConsultantLookupWhere(params),
    select: { id: true },
    orderBy: [{ id: "asc" }],
    take: 2,
  });
}

function assertUnambiguousNativePracticeConsultant(
  matches: Array<{ id: string }>,
  email: string | null,
) {
  invariant(
    matches.length <= 1,
    409,
    "AMBIGUOUS_CONSULTANT",
    email
      ? "Consultant email is ambiguous; resolve duplicate consultants."
      : "Consultant name is ambiguous; include an email.",
  );
}

function nativePracticeConsultantIdentityLockKey(params: {
  workspaceId: string;
  displayName: string;
  email: string | null;
}) {
  const identity = params.email
    ? `email:${params.email}`
    : `name:${params.displayName.toLocaleLowerCase("en-US")}`;
  return `native-practice-consultant:${params.workspaceId}:${identity}`;
}

async function lockNativePracticeConsultantIdentity(
  tx: Prisma.TransactionClient,
  lockKey: string,
) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function ensureNativePracticeClientForProject(project: Awaited<ReturnType<typeof loadNativePracticeProjectForLedgerWrite>>) {
  if (project.clientId) return project.clientId;

  if (project.crmAccountId) {
    const namedCrmClients = await prisma.practiceClient.findMany({
      where: {
        workspaceId: project.workspaceId,
        crmAccountId: project.crmAccountId,
        name: { equals: project.clientName, mode: "insensitive" },
      },
      select: { id: true },
      orderBy: [{ id: "asc" }],
      take: 2,
    });
    invariant(
      namedCrmClients.length <= 1,
      409,
      "AMBIGUOUS_CLIENT",
      "CRM account is linked to multiple matching practice clients; resolve duplicate clients before recording ledger entries.",
    );
    if (namedCrmClients[0]) {
      return linkNativePracticeProjectClient(project.id, namedCrmClients[0].id);
    }

    const crmClients = await prisma.practiceClient.findMany({
      where: { workspaceId: project.workspaceId, crmAccountId: project.crmAccountId },
      select: { id: true },
      orderBy: [{ id: "asc" }],
      take: 2,
    });
    invariant(
      crmClients.length <= 1,
      409,
      "AMBIGUOUS_CLIENT",
      "CRM account is linked to multiple practice clients; resolve duplicate clients before recording ledger entries.",
    );
    if (crmClients[0]) {
      return linkNativePracticeProjectClient(project.id, crmClients[0].id);
    }
  }

  const baseCode = normalizeProjectCodeBase(project.clientName).slice(0, 80) || `CLIENT-${projectIdCodeSuffix(project.id)}`;
  const suffixedCode = `${baseCode.slice(0, 67)}-${project.id.slice(0, 12)}`;
  const existingCodeClient = await prisma.practiceClient.findUnique({
    where: { workspaceId_code: { workspaceId: project.workspaceId, code: baseCode } },
    select: { id: true, crmAccountId: true, name: true },
  });
  if (existingCodeClient && nativePracticeClientMatchesProject(existingCodeClient, project)) {
    return linkNativePracticeProjectClient(project.id, existingCodeClient.id);
  }

  const code = existingCodeClient ? suffixedCode : baseCode;
  try {
    const client = await prisma.practiceClient.create({
      data: {
        workspaceId: project.workspaceId,
        crmAccountId: project.crmAccountId,
        code,
        name: project.clientName,
      },
      select: { id: true },
    });
    return linkNativePracticeProjectClient(project.id, client.id);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const client = await prisma.practiceClient.findUnique({
      where: { workspaceId_code: { workspaceId: project.workspaceId, code } },
      select: { id: true, crmAccountId: true, name: true },
    });
    if (client && nativePracticeClientMatchesProject(client, project)) {
      return linkNativePracticeProjectClient(project.id, client.id);
    }
    if (code !== suffixedCode) {
      try {
        const fallbackClient = await prisma.practiceClient.create({
          data: {
            workspaceId: project.workspaceId,
            crmAccountId: project.crmAccountId,
            code: suffixedCode,
            name: project.clientName,
          },
          select: { id: true },
        });
        return linkNativePracticeProjectClient(project.id, fallbackClient.id);
      } catch (fallbackError) {
        if (!isUniqueConstraintError(fallbackError)) throw fallbackError;
        const fallbackClient = await prisma.practiceClient.findUnique({
          where: { workspaceId_code: { workspaceId: project.workspaceId, code: suffixedCode } },
          select: { id: true, crmAccountId: true, name: true },
        });
        if (fallbackClient && nativePracticeClientMatchesProject(fallbackClient, project)) {
          return linkNativePracticeProjectClient(project.id, fallbackClient.id);
        }
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function resolveNativePracticeConsultant(params: {
  workspaceId: string;
  name?: string | null;
  email?: string | null;
  idempotencyKey?: string | null;
  required: boolean;
}) {
  const email = normalizeConsultantEmail(params.email);
  const name = normalizeOptionalNativeText(params.name);
  if (!name && !email && !params.required) return null;
  const displayName = name || email;
  invariant(displayName, 400, "INVALID_INPUT", "Consultant is required.");

  const lookup = { workspaceId: params.workspaceId, displayName, email };
  const matches = await findNativePracticeConsultantMatches(prisma, lookup);
  assertUnambiguousNativePracticeConsultant(matches, email);
  if (matches[0]) return matches[0].id;

  const sourceSatelliteId = manualLedgerConsultantSourceId(params.idempotencyKey);
  if (sourceSatelliteId) {
    const sourceMatch = await prisma.practiceConsultant.findFirst({
      where: { workspaceId: params.workspaceId, sourceSatelliteId },
      select: { id: true },
    });
    if (sourceMatch) return sourceMatch.id;
  }

  return prisma.$transaction(async (tx) => {
    await lockNativePracticeConsultantIdentity(tx, nativePracticeConsultantIdentityLockKey(lookup));

    const lockedMatches = await findNativePracticeConsultantMatches(tx, lookup);
    assertUnambiguousNativePracticeConsultant(lockedMatches, email);
    if (lockedMatches[0]) return lockedMatches[0].id;

    if (sourceSatelliteId) {
      const sourceMatch = await tx.practiceConsultant.findFirst({
        where: { workspaceId: params.workspaceId, sourceSatelliteId },
        select: { id: true },
      });
      if (sourceMatch) return sourceMatch.id;
    }

    try {
      const created = await tx.practiceConsultant.create({
        data: {
          workspaceId: params.workspaceId,
          name: displayName,
          email,
          sourceSatelliteId,
          active: true,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (!sourceSatelliteId || !isUniqueConstraintError(error)) throw error;
      const created = await tx.practiceConsultant.findFirst({
        where: { workspaceId: params.workspaceId, sourceSatelliteId },
        select: { id: true },
      });
      if (created) return created.id;
      throw error;
    }
  });
}

export async function getNativePracticeProjectDetail(
  actor: AppActor,
  workspaceId: string,
  projectId: string,
  options: NativePracticeProjectHealthOptions = {},
): Promise<NativePracticeProjectDetail> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const id = projectId.trim();
  invariant(id, 400, "INVALID_INPUT", "Project is required.");
  const project = await prisma.practiceProject.findUnique({
    where: { id },
    include: {
      billingCode: true,
      client: true,
      _count: {
        select: {
          assignments: true,
          lines: true,
          purchaseOrders: true,
        },
      },
    },
  });
  invariant(project && project.workspaceId === workspaceId, 404, "NOT_FOUND", "Practice project not found.");

  const now = normalizeNow(options.now);
  const recentWindowWeeks = normalizeRecentWindowWeeks(options.recentWindowWeeks);
  const rollups = await queryNativePracticeLedgerRollups(workspaceId, [project.id], weekWindow(now, recentWindowWeeks));
  const health = calculateNativePracticeProjectHealthFromRollup({
    project: nativePracticeProjectFromProject(project),
    rollup: rollups.get(project.id) ?? emptyNativePracticeProjectLedgerRollup(project.id),
    recentWindowWeeks,
  });

  const [recentTimeEntries, recentExpenses, consultants] = await Promise.all([
    prisma.practiceTimeEntry.findMany({
      where: { workspaceId, projectId: project.id },
      include: {
        consultant: { select: { id: true, name: true, email: true } },
        reviews: { select: { id: true, status: true, note: true, updatedAt: true } },
      },
      orderBy: [{ workedOn: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      take: 50,
    }),
    prisma.practiceExpense.findMany({
      where: { workspaceId, projectId: project.id },
      include: {
        consultant: { select: { id: true, name: true, email: true } },
        reviews: { select: { id: true, status: true, note: true, updatedAt: true } },
      },
      orderBy: [{ spentOn: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      take: 50,
    }),
    prisma.practiceConsultant.findMany({
      where: { workspaceId, active: true },
      select: { id: true, name: true, email: true, active: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
    }),
  ]);

  return {
    project,
    health,
    recentTimeEntries,
    recentExpenses,
    consultants,
  };
}

export async function createNativePracticeTimeEntry(
  actor: AppActor,
  workspaceId: string,
  input: CreateNativePracticeTimeEntryInput,
): Promise<PracticeTimeEntry> {
  await requirePracticeFinanceWrite(actor, workspaceId);
  const project = await loadNativePracticeProjectForLedgerWrite(workspaceId, input.projectId);
  const workedOn = normalizeNativeLedgerDate(input.workedOn, "Work date");
  const hours = normalizeNativeLedgerHours(input.hours);
  const billRateCents = normalizeCents(input.billRateCents ?? undefined, "Bill rate");
  const costRateCents = normalizeCents(input.costRateCents ?? undefined, "Cost rate");
  const currency = normalizeNativeLedgerCurrency(null, project.currency);
  const assignmentType = normalizeOptionalNativeText(input.assignmentType) || "CONSULTING";
  const idempotencyKey = normalizeOptionalNativeText(input.idempotencyKey);
  const consultantName = normalizeOptionalNativeText(input.consultantName);
  const consultantEmail = normalizeConsultantEmail(input.consultantEmail);
  invariant(consultantName || consultantEmail, 400, "INVALID_INPUT", "Consultant is required.");
  const existingEntry = idempotencyKey
    ? await prisma.practiceTimeEntry.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    })
    : null;
  if (existingEntry) return existingEntry;

  const billAmountCents = normalizeCents(centsFromHours(hours, billRateCents), "Bill amount");
  const costAmountCents = normalizeCents(centsFromHours(hours, costRateCents), "Cost amount");
  const consultantId = await resolveNativePracticeConsultant({
    workspaceId,
    name: consultantName,
    email: consultantEmail,
    idempotencyKey,
    required: true,
  });
  invariant(consultantId, 400, "INVALID_INPUT", "Consultant is required.");
  const clientId = await ensureNativePracticeClientForProject(project);

  const data = {
    workspaceId,
    clientId,
    billingCodeId: project.billingCodeId,
    projectId: project.id,
    consultantId,
    workedOn,
    weekEndingOn: weekEndingSundayUtc(workedOn),
    hours,
    assignmentType,
    currency,
    billCurrency: currency,
    costCurrency: currency,
    functionalCurrency: currency,
    billRateCents,
    costRateCents,
    billAmountCents,
    costAmountCents,
    status: "POSTED" as const,
    idempotencyKey,
  };

  try {
    return await prisma.practiceTimeEntry.create({ data });
  } catch (error) {
    if (!idempotencyKey || !isUniqueConstraintError(error)) throw error;
    const created = await prisma.practiceTimeEntry.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    });
    if (created) return created;
    throw error;
  }
}

export async function createNativePracticeExpense(
  actor: AppActor,
  workspaceId: string,
  input: CreateNativePracticeExpenseInput,
): Promise<PracticeExpense> {
  await requirePracticeFinanceWrite(actor, workspaceId);
  const project = await loadNativePracticeProjectForLedgerWrite(workspaceId, input.projectId);
  const spentOn = normalizeNativeLedgerDate(input.spentOn, "Expense date");
  const amountCents = normalizePositiveCents(input.amountCents, "Expense amount");
  const currency = normalizeNativeLedgerCurrency(input.currency, project.currency);
  const vendor = normalizeOptionalNativeText(input.vendor);
  const category = normalizeRequiredText(input.category, "Category");
  const businessPurpose = normalizeRequiredText(input.businessPurpose, "Business purpose");
  const idempotencyKey = normalizeOptionalNativeText(input.idempotencyKey);
  const consultantName = normalizeOptionalNativeText(input.consultantName);
  const consultantEmail = normalizeConsultantEmail(input.consultantEmail);
  const existingEntry = idempotencyKey
    ? await prisma.practiceExpense.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    })
    : null;
  if (existingEntry) return existingEntry;

  const consultantId = await resolveNativePracticeConsultant({
    workspaceId,
    name: consultantName,
    email: consultantEmail,
    idempotencyKey,
    required: false,
  });
  const clientId = await ensureNativePracticeClientForProject(project);

  const data = {
    workspaceId,
    clientId,
    billingCodeId: project.billingCodeId,
    projectId: project.id,
    consultantId,
    spentOn,
    vendor,
    category,
    businessPurpose,
    amountCents,
    currency,
    amountFunctionalCents: amountCents,
    functionalCurrency: currency,
    billable: input.billable ?? true,
    status: "POSTED" as const,
    idempotencyKey,
  };

  try {
    return await prisma.practiceExpense.create({ data });
  } catch (error) {
    if (!idempotencyKey || !isUniqueConstraintError(error)) throw error;
    const created = await prisma.practiceExpense.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    });
    if (created) return created;
    throw error;
  }
}

async function resolveContributionUserId(actor: AppActor, workspaceId: string, contributorUserId?: string | null) {
  const actorUserId = actor.kind === "user" ? actor.user.id : null;
  const resolved = contributorUserId?.trim() || actorUserId;
  invariant(resolved, 400, "INVALID_INPUT", "Contributor is required.");
  if (actorUserId && resolved !== actorUserId) {
    await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: PRACTICE_FINANCE_MANAGE_ROLES });
  }
  const member = await prisma.member.findFirst({
    where: {
      workspaceId,
      userId: resolved,
      isActive: true,
      mergedAt: null,
    },
    select: { id: true },
  });
  invariant(member, 404, "NOT_FOUND", "Contributor is not an active workspace member.");
  return resolved;
}

const CONTRIBUTION_INCLUDE = {
  contributor: {
    select: { id: true, displayName: true, email: true },
  },
  paidBy: {
    select: { id: true, displayName: true, email: true },
  },
  project: {
    select: { id: true, code: true, name: true, clientName: true },
  },
} as const;

export async function listPracticeContributionEntries(
  actor: AppActor,
  workspaceId: string,
  options: ListPracticeContributionEntriesOptions = {},
): Promise<PracticeContributionEntryWithContext[]> {
  return (await listPracticeContributionEntryPage(actor, workspaceId, options)).entries;
}

async function findPracticeContributionEntryPage(
  where: Prisma.PracticeContributionEntryWhereInput,
  options: ListPracticeContributionEntriesOptions = {},
): Promise<PracticeContributionEntryPage> {
  const cursor = normalizeCursor(options.cursor);
  const take = normalizeContributionTake(options.take);
  const rows = await prisma.practiceContributionEntry.findMany({
    where,
    include: CONTRIBUTION_INCLUDE,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const entries = rows.slice(0, take);
  return {
    entries,
    nextCursor: rows.length > take ? entries.at(-1)?.id ?? null : null,
  };
}

export async function listPracticeContributionEntryPage(
  actor: AppActor,
  workspaceId: string,
  options: ListPracticeContributionEntriesOptions = {},
): Promise<PracticeContributionEntryPage> {
  await requireWorkspaceMembership({ actor, workspaceId });
  return findPracticeContributionEntryPage({ workspaceId }, options);
}

export async function listRequestedPracticeContributionPayables(
  actor: AppActor,
  workspaceId: string,
  options: ListPracticeContributionEntriesOptions = {},
): Promise<PracticeContributionEntryPage> {
  await requireWorkspaceMembership({ actor, workspaceId });
  return findPracticeContributionEntryPage({
    workspaceId,
    paymentChoice: "CASH",
    cashStatus: "REQUESTED",
  }, options);
}

export async function createPracticeContributionEntry(
  actor: AppActor,
  workspaceId: string,
  input: PracticeContributionEntryInput,
): Promise<PracticeContributionEntry> {
  await requireWorkspaceMembership({ actor, workspaceId });
  await requireProjectInWorkspace(workspaceId, input.projectId);
  const contributorUserId = await resolveContributionUserId(actor, workspaceId, input.contributorUserId);
  const type = normalizeContributionType(input.type);
  const paymentChoice = normalizePaymentChoice(input.paymentChoice);
  const description = normalizeRequiredText(input.description, "Description");
  const occurredAt = normalizeContributionDate(input.occurredAt);
  const { amountCents, hoursTenths, rateCents } = calculatePracticeContributionAmount({
    type,
    hoursTenths: input.hoursTenths,
    rateCents: input.rateCents,
    amountCents: input.amountCents,
  });
  const { sliceMultiplier, slices, cashStatus } = calculatePracticeContributionSlices({
    type,
    paymentChoice,
    amountCents,
  });

  return prisma.practiceContributionEntry.create({
    data: {
      workspaceId,
      projectId: input.projectId.trim(),
      contributorUserId,
      type,
      paymentChoice,
      cashStatus,
      description,
      occurredAt,
      hoursTenths,
      rateCents,
      amountCents,
      currency: normalizeCurrency(input.currency),
      receiptUrl: normalizeOptionalReceiptUrl(input.receiptUrl),
      sliceMultiplier,
      slices,
    },
  });
}

export async function markPracticeContributionEntryPaid(
  actor: AppActor,
  workspaceId: string,
  entryId: string,
): Promise<PracticeContributionEntry> {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: PRACTICE_FINANCE_MANAGE_ROLES });
  const id = entryId.trim();
  invariant(id, 400, "INVALID_INPUT", "Contribution entry is required.");
  const entry = await prisma.practiceContributionEntry.findUnique({
    where: { id },
    select: { id: true, workspaceId: true, paymentChoice: true, cashStatus: true },
  });
  invariant(entry && entry.workspaceId === workspaceId, 404, "NOT_FOUND", "Contribution entry not found.");
  invariant(entry.paymentChoice === "CASH", 400, "INVALID_STATE", "Only cash entries can be marked paid.");
  invariant(entry.cashStatus !== "PAID", 400, "INVALID_STATE", "Contribution entry is already paid.");
  const updated = await prisma.practiceContributionEntry.updateMany({
    where: { id, workspaceId, paymentChoice: "CASH", cashStatus: "REQUESTED" },
    data: {
      cashStatus: "PAID",
      paidAt: new Date(),
      paidByUserId: actor.kind === "user" ? actor.user.id : null,
    },
  });
  invariant(updated.count === 1, 409, "CONFLICT", "Contribution entry is no longer payable.");
  const paid = await prisma.practiceContributionEntry.findUnique({ where: { id } });
  invariant(paid, 500, "INTERNAL_ERROR", "Paid contribution entry could not be loaded.");
  return paid;
}

export async function getSlicingPieSummary(
  actor: AppActor,
  workspaceId: string,
  options: SlicingPieSummaryOptions = {},
): Promise<SlicingPieSummary> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const [sourcePage, aggregateRows] = await Promise.all([
    findPracticeContributionEntryPage({ workspaceId }, {
      take: options.sourceTake,
      cursor: options.sourceCursor,
    }),
    prisma.practiceContributionEntry.groupBy({
      by: ["contributorUserId", "type", "paymentChoice", "cashStatus"],
      where: { workspaceId },
      _sum: { amountCents: true, slices: true },
    }),
  ]);
  const contributorIds = [...new Set(aggregateRows.map((row) => row.contributorUserId))];
  const users = contributorIds.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: contributorIds } },
    select: { id: true, displayName: true, email: true },
  });
  const usersById = new Map(users.map((user) => [user.id, user]));
  const byContributor = new Map<string, SlicingPieContributorSummary>();
  for (const row of aggregateRows) {
    const user = usersById.get(row.contributorUserId);
    const email = user?.email ?? "unknown@example.invalid";
    const displayName = user?.displayName || email;
    const summary = byContributor.get(row.contributorUserId) ?? {
      userId: row.contributorUserId,
      displayName,
      email,
      timeValueCents: 0,
      expenseValueCents: 0,
      cashRequestedCents: 0,
      cashPaidCents: 0,
      slices: 0,
      ownershipBps: 0,
    };
    const amountCents = row._sum.amountCents ?? 0;
    const slices = row._sum.slices ?? 0;
    if (row.paymentChoice === "SLICING_PIE") {
      if (row.type === "TIME") summary.timeValueCents += amountCents;
      else summary.expenseValueCents += amountCents;
      summary.slices += slices;
    } else if (row.cashStatus === "PAID") {
      summary.cashPaidCents += amountCents;
    } else {
      summary.cashRequestedCents += amountCents;
    }
    byContributor.set(row.contributorUserId, summary);
  }
  const totalSlices = [...byContributor.values()].reduce((sum, contributor) => sum + contributor.slices, 0);
  const contributors = [...byContributor.values()]
    .map((contributor) => ({
      ...contributor,
      ownershipBps: totalSlices > 0 ? Math.round((contributor.slices * 10000) / totalSlices) : 0,
    }))
    .sort((a, b) => b.slices - a.slices || a.displayName.localeCompare(b.displayName));
  return {
    totalSlices,
    contributors,
    entries: sourcePage.entries,
    nextSourceCursor: sourcePage.nextCursor,
  };
}

export async function getCrmAccountPracticeFinance(
  actor: AppActor,
  params: { workspaceId: string; accountId: string },
): Promise<CrmAccountPracticeFinance> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const account = await prisma.crmAccount.findUnique({
    where: { id: params.accountId },
    select: { id: true, workspaceId: true, archivedAt: true },
  });
  invariant(account && account.workspaceId === params.workspaceId && !account.archivedAt, 404, "NOT_FOUND", "Account not found.");

  const projects = await prisma.practiceProject.findMany({
    where: {
      workspaceId: params.workspaceId,
      crmAccountId: params.accountId,
    },
    include: {
      crmDeal: {
        select: {
          id: true,
          title: true,
          stage: true,
          valueCents: true,
          currency: true,
        },
      },
    },
    orderBy: [{ status: "asc" }, { code: "asc" }, { id: "asc" }],
  });
  const now = new Date();
  const recentWindowWeeks = normalizeRecentWindowWeeks(null);
  const projectIds = projects.map((project) => project.id);
  const rollups = await queryNativePracticeLedgerRollups(params.workspaceId, projectIds, weekWindow(now, recentWindowWeeks));
  const projectHealth = projects.map((project) =>
    calculateNativePracticeProjectHealthFromRollup({
      project: nativePracticeProjectFromProject(project),
      rollup: rollups.get(project.id) ?? emptyNativePracticeProjectLedgerRollup(project.id),
      recentWindowWeeks,
    })
  );

  return {
    summary: summarizeNativePracticeFinance(projectHealth),
    projects,
    projectHealth,
  };
}

export async function createPracticeProject(
  actor: AppActor,
  workspaceId: string,
  input: PracticeProjectInput,
): Promise<PracticeProject> {
  await requirePracticeFinanceWrite(actor, workspaceId);

  const code = normalizeRequiredText(input.code, "Project code");
  const name = normalizeRequiredText(input.name, "Project name");
  const clientName = normalizeRequiredText(input.clientName, "Client name");

  return prisma.practiceProject.create({
    data: {
      workspaceId,
      code,
      name,
      clientName,
      status: normalizeProjectStatus(input.status) ?? "ACTIVE",
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

export async function updatePracticeProject(
  actor: AppActor,
  workspaceId: string,
  input: UpdatePracticeProjectInput,
): Promise<PracticeProject> {
  await requirePracticeFinanceWrite(actor, workspaceId);
  const projectId = input.projectId.trim();
  invariant(projectId, 400, "INVALID_INPUT", "Project ID is required.");

  const existing = await prisma.practiceProject.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  });
  invariant(existing && existing.workspaceId === workspaceId, 404, "NOT_FOUND", "Practice project not found.");

  const data = {
    code: normalizeOptionalText(input.code, "Project code"),
    name: normalizeOptionalText(input.name, "Project name"),
    clientName: normalizeOptionalText(input.clientName, "Client name"),
    status: normalizeProjectStatus(input.status),
    poValueCents: normalizeOptionalCents(input.poValueCents, "PO value"),
    serviceBudgetCents: normalizeOptionalCents(input.serviceBudgetCents, "Service budget"),
    expenseBudgetCents: normalizeOptionalCents(input.expenseBudgetCents, "Expense budget"),
    usedCents: normalizeOptionalCents(input.usedCents, "Used"),
    weeklyBurnCents: normalizeOptionalCents(input.weeklyBurnCents, "Weekly burn"),
    targetMarginBps: normalizeOptionalBps(input.targetMarginBps, "Target margin"),
    currentMarginBps: normalizeOptionalBps(input.currentMarginBps, "Current margin"),
  };

  return prisma.practiceProject.update({
    where: { id: projectId },
    data,
  });
}

export async function createPracticeProjectFromWonDeal(
  actor: AppActor,
  workspaceId: string,
  input: CreatePracticeProjectFromWonDealInput,
): Promise<PracticeProject> {
  await requirePracticeFinanceWrite(actor, workspaceId);

  const deal = await prisma.crmDeal.findUnique({
    where: { id: input.dealId },
    include: {
      account: { select: { id: true, workspaceId: true, name: true, slug: true } },
      contact: { select: { id: true, workspaceId: true, email: true, company: true } },
    },
  });
  invariant(deal && deal.workspaceId === workspaceId && !deal.archivedAt, 404, "NOT_FOUND", "Deal not found.");
  invariant(deal.stage === CrmDealStage.CLOSED_WON, 400, "INVALID_STATE", "Only closed-won deals can create finance projects.");
  invariant(!deal.account || deal.account.workspaceId === workspaceId, 400, "INVALID_STATE", "Deal account belongs to another workspace.");
  invariant(deal.contact.workspaceId === workspaceId, 400, "INVALID_STATE", "Deal contact belongs to another workspace.");

  const existing = await prisma.practiceProject.findUnique({
    where: { crmDealId: deal.id },
  });
  if (existing) {
    invariant(existing.workspaceId === workspaceId, 409, "CONFLICT", "Deal is already linked to a finance project in another workspace.");
    return existing;
  }

  const name = input.name?.trim() || deal.title;
  const clientName = input.clientName?.trim() || deal.account?.name || deal.contact.company || deal.contact.email;
  const poValueCents = input.poValueCents ?? deal.valueCents ?? 0;

  return prisma.practiceProject.create({
    data: {
      workspaceId,
      crmAccountId: deal.account?.id ?? null,
      crmDealId: deal.id,
      code: normalizeProjectCode(input.code || defaultProjectCode(deal)),
      name,
      clientName,
      status: "ACTIVE",
      poValueCents: normalizeCents(poValueCents, "PO value"),
      serviceBudgetCents: normalizeCents(input.serviceBudgetCents, "Service budget"),
      expenseBudgetCents: normalizeCents(input.expenseBudgetCents, "Expense budget"),
      usedCents: 0,
      weeklyBurnCents: normalizeCents(input.weeklyBurnCents, "Weekly burn"),
      targetMarginBps: normalizeBps(input.targetMarginBps, "Target margin"),
      currentMarginBps: normalizeBps(input.currentMarginBps, "Current margin"),
      sourceSatelliteId: null,
    },
  });
}
