import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { prisma } from "@corgtex/shared";
import { requireAgentScope } from "./agent-auth";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { resolveSingleModuleAccess } from "./module-access";
import { defaultWorkspaceFeatureFlags, getModuleByKey, isAtLeast, type MemberRoleKey, type ModuleAccessLevel } from "./modules";

export const FINANCE_PARENT_FLAG = "FINANCE";
export const FINANCE_ALL_MEMBER_WRITE_CONFIG_KEY = "financeAllMemberWrite";

export const FINANCE_SECTIONS = [
  { key: "overview", label: "Overview", href: "/finance", flag: null },
  { key: "projects", label: "Projects", href: "/finance/projects", flag: "FINANCE_PROJECTS" },
  { key: "clients", label: "Clients", href: "/finance/clients", flag: "FINANCE_CLIENTS" },
  { key: "consultants", label: "Consultants", href: "/finance/consultants", flag: "FINANCE_CONSULTANTS" },
  { key: "time", label: "Time", href: "/finance/time", flag: "FINANCE_TIME" },
  { key: "expenses", label: "Expenses", href: "/finance/expenses", flag: "FINANCE_EXPENSES" },
  { key: "reports", label: "Reports", href: "/finance/reports", flag: "FINANCE_REPORTS" },
  { key: "slicing-pie", label: "Slicing Pie", href: "/finance/slicing-pie", flag: "FINANCE_SLICING_PIE" },
  { key: "capital", label: "Capital", href: "/finance/capital", flag: "FINANCE_CAPITAL" },
] as const;

export type FinanceSectionKey = typeof FINANCE_SECTIONS[number]["key"];
export type FinanceCapabilityFlag = Exclude<typeof FINANCE_SECTIONS[number]["flag"], null>;

const FINANCE_FLAG_KEYS = [
  FINANCE_PARENT_FLAG,
  ...FINANCE_SECTIONS.flatMap((section) => section.flag ? [section.flag] : []),
];

const PRISMA_INT_MAX = 2147483647;
const RETIRED_PRACTICE_LEDGER_APP_KEY = "practice-ledger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function financeAllMemberWriteFromConfig(config: unknown): boolean {
  return isRecord(config) && config[FINANCE_ALL_MEMBER_WRITE_CONFIG_KEY] === true;
}

function normalizeCurrency(value: string | null | undefined) {
  const currency = (value ?? "USD").trim().toUpperCase();
  invariant(/^[A-Z]{3}$/.test(currency), 400, "INVALID_INPUT", "Currency must be a three-letter code.");
  return currency;
}

function normalizeName(value: string, label: string) {
  const name = value.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", `${label} is required.`);
  invariant(name.length <= 160, 400, "INVALID_INPUT", `${label} is too long.`);
  return name;
}

function normalizeCents(value: number | null | undefined, label: string, allowZero: boolean) {
  if (value == null) return null;
  invariant(Number.isInteger(value), 400, "INVALID_INPUT", `${label} must be a whole number of cents.`);
  invariant(allowZero ? value >= 0 : value > 0, 400, "INVALID_INPUT", allowZero ? `${label} cannot be negative.` : `${label} must be positive.`);
  invariant(value <= PRISMA_INT_MAX, 400, "INVALID_INPUT", `${label} cannot exceed ${PRISMA_INT_MAX} cents.`);
  return value;
}

function isPrismaUniqueConstraintError(error: unknown, fields: string[]) {
  if (!isRecord(error) || error.code !== "P2002") return false;
  const meta = isRecord(error.meta) ? error.meta : null;
  const target = meta?.target;
  if (Array.isArray(target)) return fields.every((field) => target.includes(field));
  return typeof target !== "string" || fields.every((field) => target.includes(field));
}

async function financeFlagState(workspaceId: string) {
  const [defaults, records] = await Promise.all([
    Promise.resolve(defaultWorkspaceFeatureFlags()),
    prisma.workspaceFeatureFlag.findMany({
      where: { workspaceId, flag: { in: FINANCE_FLAG_KEYS } },
      select: { flag: true, enabled: true, config: true, updatedAt: true },
    }),
  ]);
  const flags: Record<string, boolean> = { ...defaults };
  const configByFlag = new Map<string, unknown>();
  const updatedAtByFlag = new Map<string, Date | null>();
  for (const record of records) {
    flags[record.flag] = record.enabled;
    configByFlag.set(record.flag, record.config ?? null);
    updatedAtByFlag.set(record.flag, record.updatedAt ?? null);
  }
  return {
    flags,
    financeConfig: configByFlag.get(FINANCE_PARENT_FLAG) ?? null,
    updatedAtByFlag,
  };
}

function capabilityEnabled(flags: Record<string, boolean>, flag: FinanceCapabilityFlag | null) {
  if (!flags[FINANCE_PARENT_FLAG]) return false;
  return flag ? Boolean(flags[flag]) : true;
}

function requireHumanActorUserId(actor: AppActor) {
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human workspace member must perform this Finance action.");
  return actor.user.id;
}

async function requireFinanceClientInWorkspace(workspaceId: string, clientId: string | null | undefined) {
  const id = clientId?.trim();
  if (!id) return null;
  const client = await prisma.financeClient.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  invariant(client, 404, "FINANCE_CLIENT_NOT_FOUND", "Finance client not found.");
  return id;
}

async function requireFinanceProjectInWorkspace(workspaceId: string, projectId: string | null | undefined) {
  const id = projectId?.trim();
  if (!id) return null;
  const project = await prisma.financeProject.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  invariant(project, 404, "FINANCE_PROJECT_NOT_FOUND", "Finance project not found.");
  return id;
}

async function requireFinanceConsultantInWorkspace(workspaceId: string, consultantId: string | null | undefined) {
  const id = consultantId?.trim();
  if (!id) return null;
  const consultant = await prisma.financeConsultant.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  invariant(consultant, 404, "FINANCE_CONSULTANT_NOT_FOUND", "Finance consultant not found.");
  return id;
}

async function requireFinanceContributorUserInWorkspace(workspaceId: string, contributorUserId: string | null | undefined, fallbackUserId: string) {
  const userId = contributorUserId?.trim() || fallbackUserId;
  const membership = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { isActive: true },
  });
  invariant(membership?.isActive, 404, "FINANCE_CONTRIBUTOR_NOT_FOUND", "Finance contributor is not an active member of this workspace.");
  return userId;
}

async function resolveFinanceModuleAccess(workspaceId: string, membership: MembershipSummary | null, financeEnabled: boolean): Promise<ModuleAccessLevel> {
  if (!financeEnabled) return "none";
  if (!membership) return "read";
  const financeModule = getModuleByKey("finance");
  invariant(financeModule, 500, "FINANCE_MODULE_MISSING", "Finance module manifest is missing.");
  return resolveSingleModuleAccess({
    workspaceId,
    memberId: membership.id,
    role: membership.role as MemberRoleKey,
    module: financeModule,
  });
}

export async function getFinanceAccessPolicy(actor: AppActor, workspaceId: string) {
  if (actor.kind === "agent") {
    requireAgentScope(actor, "finance:read");
  }
  const [membership, flagState] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    financeFlagState(workspaceId),
  ]);
  const financeEnabled = Boolean(flagState.flags[FINANCE_PARENT_FLAG]);
  const financeAllMemberWrite = financeEnabled && financeAllMemberWriteFromConfig(flagState.financeConfig);
  const memberRole = membership?.role ?? (actor.kind === "agent" ? null : null);
  const accessLevel = await resolveFinanceModuleAccess(workspaceId, membership, financeEnabled);
  const canRead = financeEnabled && isAtLeast(accessLevel, "read");
  const canWrite = financeEnabled && (isAtLeast(accessLevel, "write") || Boolean(membership && financeAllMemberWrite));

  return {
    workspaceId,
    financeEnabled,
    financeAllMemberWrite,
    member: membership,
    role: memberRole,
    canRead,
    canWrite,
    flags: flagState.flags,
    financeConfig: flagState.financeConfig,
    flagUpdatedAtByFlag: flagState.updatedAtByFlag,
  };
}

export async function requireFinanceReadAccess(actor: AppActor, workspaceId: string) {
  const policy = await getFinanceAccessPolicy(actor, workspaceId);
  invariant(policy.canRead, 404, "FINANCE_NOT_ENABLED", "Finance is not enabled for this workspace.");
  return policy;
}

export async function requireFinanceWriteAccess(actor: AppActor, workspaceId: string) {
  const policy = await requireFinanceReadAccess(actor, workspaceId);
  invariant(policy.canWrite, 403, "FORBIDDEN", "You do not have Finance write access.");
  return policy;
}

export async function requireFinanceHumanWriteAccess(actor: AppActor, workspaceId: string) {
  const policy = await requireFinanceWriteAccess(actor, workspaceId);
  requireHumanActorUserId(actor);
  return policy as typeof policy & { member: MembershipSummary };
}

export function requireFinanceCapability(flags: Record<string, boolean>, flag: FinanceCapabilityFlag) {
  invariant(capabilityEnabled(flags, flag), 404, "FINANCE_CAPABILITY_DISABLED", "This Finance section is not enabled for this workspace.");
}

export async function createFinanceProject(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  clientId?: string | null;
  budgetCents?: number | null;
  currency?: string | null;
}) {
  const policy = await requireFinanceHumanWriteAccess(actor, params.workspaceId);
  const actorUserId = requireHumanActorUserId(actor);
  requireFinanceCapability(policy.flags, "FINANCE_PROJECTS");
  const clientId = await requireFinanceClientInWorkspace(params.workspaceId, params.clientId);
  const name = normalizeName(params.name, "Project name");
  const budgetCents = normalizeCents(params.budgetCents, "Budget", true);

  try {
    return await prisma.financeProject.create({
      data: {
        workspaceId: params.workspaceId,
        clientId,
        name,
        budgetCents,
        currency: normalizeCurrency(params.currency),
        createdByUserId: actorUserId,
      },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error, ["workspaceId", "name"])) {
      throw new AppError(409, "FINANCE_PROJECT_ALREADY_EXISTS", "A Finance project with this name already exists.");
    }
    throw error;
  }
}

export async function createFinanceContributionEntry(actor: AppActor, params: {
  workspaceId: string;
  projectId?: string | null;
  consultantId?: string | null;
  contributorUserId?: string | null;
  type: "TIME" | "EXPENSE" | "CAPITAL";
  paymentChoice: "CASH" | "SLICING_PIE" | "CAPITAL";
  occurredAt?: Date | null;
  minutes?: number | null;
  amountCents?: number | null;
  currency?: string | null;
  descriptionMd?: string | null;
}) {
  const policy = await requireFinanceHumanWriteAccess(actor, params.workspaceId);
  const actorUserId = requireHumanActorUserId(actor);
  requireFinanceCapability(policy.flags, params.type === "CAPITAL" ? "FINANCE_CAPITAL" : "FINANCE_SLICING_PIE");
  invariant(params.paymentChoice !== "CAPITAL" || params.type === "CAPITAL", 400, "INVALID_INPUT", "Capital payment choice requires a capital contribution.");
  invariant(params.minutes == null || (Number.isInteger(params.minutes) && params.minutes > 0 && params.minutes <= PRISMA_INT_MAX), 400, "INVALID_INPUT", "Minutes must be a positive whole number within the Prisma Int range.");
  const amountCents = normalizeCents(params.amountCents, "Amount", false);
  invariant(params.type !== "TIME" || params.minutes != null, 400, "INVALID_INPUT", "Time contributions require positive minutes.");
  invariant(params.paymentChoice === "CASH" || params.type === "TIME" || amountCents !== null, 400, "INVALID_INPUT", "Expense and capital contributions require a positive amount.");

  const [projectId, consultantId, contributorUserId] = await Promise.all([
    requireFinanceProjectInWorkspace(params.workspaceId, params.projectId),
    requireFinanceConsultantInWorkspace(params.workspaceId, params.consultantId),
    requireFinanceContributorUserInWorkspace(params.workspaceId, params.contributorUserId, actorUserId),
  ]);
  invariant(params.paymentChoice !== "CASH" || amountCents !== null, 400, "PAYABLE_AMOUNT_REQUIRED", "Cash payables require a positive amount.");
  const cashStatus = params.paymentChoice === "CASH" ? "REQUESTED" : "NOT_APPLICABLE";
  return prisma.financeContributionEntry.create({
    data: {
      workspaceId: params.workspaceId,
      projectId,
      consultantId,
      contributorUserId,
      submittedByUserId: actorUserId,
      type: params.type,
      paymentChoice: params.paymentChoice,
      cashStatus,
      occurredAt: params.occurredAt ?? new Date(),
      minutes: params.minutes ?? null,
      amountCents,
      currency: normalizeCurrency(params.currency),
      descriptionMd: params.descriptionMd?.trim() || null,
    },
  });
}

export async function confirmFinanceCashPayablePaid(actor: AppActor, params: {
  workspaceId: string;
  entryId: string;
  expectedVersion: number;
}) {
  const policy = await requireFinanceHumanWriteAccess(actor, params.workspaceId);
  const actorUserId = requireHumanActorUserId(actor);
  invariant(Number.isInteger(params.expectedVersion) && params.expectedVersion > 0 && params.expectedVersion <= PRISMA_INT_MAX, 400, "INVALID_INPUT", "A payable version within the Prisma Int range is required.");
  const payable = await prisma.financeContributionEntry.findFirst({
    where: { id: params.entryId, workspaceId: params.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      submittedByUserId: true,
      contributorUserId: true,
      paymentChoice: true,
      cashStatus: true,
      type: true,
      version: true,
    },
  });
  invariant(payable, 404, "NOT_FOUND", "Finance payable not found.");
  invariant(payable.paymentChoice === "CASH", 400, "PAYABLE_NOT_CASH", "Only cash payables can be confirmed as paid.");
  invariant(payable.cashStatus !== "PAID", 409, "PAYABLE_ALREADY_PAID", "This payable is already paid.");
  invariant(payable.cashStatus === "REQUESTED", 400, "PAYABLE_NOT_REQUESTED", "This payable is not awaiting payment.");
  requireFinanceCapability(policy.flags, payable.type === "CAPITAL" ? "FINANCE_CAPITAL" : "FINANCE_SLICING_PIE");

  const creatorUserIds = new Set([payable.submittedByUserId, payable.contributorUserId].filter(Boolean));
  invariant(creatorUserIds.size > 0, 409, "PAYABLE_SUBMITTER_REQUIRED", "A human submitter must be recorded before payment can be confirmed.");
  if (creatorUserIds.has(actorUserId)) {
    throw new AppError(403, "PEER_REVIEW_REQUIRED", "Needs another contributor to confirm.");
  }

  const updated = await prisma.financeContributionEntry.updateMany({
    where: {
      id: params.entryId,
      workspaceId: params.workspaceId,
      paymentChoice: "CASH",
      cashStatus: "REQUESTED",
      version: params.expectedVersion,
    },
    data: {
      cashStatus: "PAID",
      paidByUserId: actorUserId,
      paidAt: new Date(),
      version: { increment: 1 },
    },
  });
  invariant(updated.count === 1, 409, "CONFLICT", "The payable changed before payment confirmation. Refresh and try again.");

  return prisma.financeContributionEntry.findUniqueOrThrow({
    where: { id: params.entryId },
  });
}

function latestDate(dates: Array<Date | null | undefined>) {
  return dates.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    return !latest || value > latest ? value : latest;
  }, null);
}

export async function getFinanceReadiness(actor: AppActor, workspaceId: string) {
  const policy = await requireFinanceReadAccess(actor, workspaceId);
  const [
    clients,
    consultants,
    projects,
    timeEntries,
    expenses,
    contributionEntries,
    requestedPayables,
    slicingPieContributionEntries,
    capitalContributionEntries,
    latestClient,
    latestConsultant,
    latestProject,
    latestTimeEntry,
    latestExpense,
    latestContribution,
    activePracticeDefinitions,
    activePracticeCatalogRows,
    activePracticeInstallations,
  ] = await Promise.all([
    prisma.financeClient.count({ where: { workspaceId, status: "ACTIVE", archivedAt: null } }),
    prisma.financeConsultant.count({ where: { workspaceId, status: "ACTIVE", archivedAt: null } }),
    prisma.financeProject.count({ where: { workspaceId, status: { not: "ARCHIVED" }, archivedAt: null } }),
    prisma.financeTimeEntry.count({ where: { workspaceId, status: { not: "ARCHIVED" }, archivedAt: null } }),
    prisma.financeExpense.count({ where: { workspaceId, status: { not: "ARCHIVED" }, archivedAt: null } }),
    prisma.financeContributionEntry.count({ where: { workspaceId } }),
    prisma.financeContributionEntry.count({ where: { workspaceId, paymentChoice: "CASH", cashStatus: "REQUESTED" } }),
    prisma.financeContributionEntry.count({ where: { workspaceId, paymentChoice: "SLICING_PIE" } }),
    prisma.financeContributionEntry.count({ where: { workspaceId, type: "CAPITAL" } }),
    prisma.financeClient.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.financeConsultant.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.financeProject.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.financeTimeEntry.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.financeExpense.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.financeContributionEntry.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.appDefinition.count({ where: { appKey: RETIRED_PRACTICE_LEDGER_APP_KEY, status: "ACTIVE" } }),
    prisma.catalogItem.count({
      where: {
        workspaceId,
        OR: [
          { sourceId: RETIRED_PRACTICE_LEDGER_APP_KEY },
          { slug: RETIRED_PRACTICE_LEDGER_APP_KEY },
          { title: "Practice Ledger" },
        ],
        archivedAt: null,
        status: { not: "ARCHIVED" },
      },
    }),
    prisma.appInstallation.count({
      where: {
        workspaceId,
        status: { not: "DISABLED" },
        appDefinition: { appKey: RETIRED_PRACTICE_LEDGER_APP_KEY },
      },
    }),
  ]);
  const latestRecordUpdateAt = latestDate([
    latestClient?.updatedAt,
    latestConsultant?.updatedAt,
    latestProject?.updatedAt,
    latestTimeEntry?.updatedAt,
    latestExpense?.updatedAt,
    latestContribution?.updatedAt,
  ]);
  const latestFinanceUpdateAt = latestDate([
    latestRecordUpdateAt,
    ...policy.flagUpdatedAtByFlag.values(),
  ]);

  return {
    workspaceId,
    ready: policy.financeEnabled,
    flags: FINANCE_SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      flag: section.flag,
      enabled: capabilityEnabled(policy.flags, section.flag),
    })),
    access: {
      role: policy.role,
      canRead: policy.canRead,
      canWrite: policy.canWrite,
      financeAllMemberWrite: policy.financeAllMemberWrite,
    },
    counts: {
      clients,
      consultants,
      projects,
      timeEntries,
      expenses,
      contributionEntries,
      requestedPayables,
      slicingPieContributionEntries,
      capitalContributionEntries,
    },
    latestFinanceUpdateAt,
    paymentSafety: {
      cashOnlyConfirmation: true,
      peerReviewRequired: true,
      staleConflictProtection: true,
    },
    retiredPracticeLedger: {
      activeDefinitions: activePracticeDefinitions,
      activeCatalogRows: activePracticeCatalogRows,
      activeInstallations: activePracticeInstallations,
      retired: activePracticeDefinitions === 0 && activePracticeCatalogRows === 0 && activePracticeInstallations === 0,
    },
  };
}
