import { NextResponse } from "next/server";
import {
  AppError,
  listNativePracticeClients,
  listNativePracticeConsultants,
  listNativePracticeExpensePage,
  listNativePracticeTimeEntryPage,
  listPracticeProjects,
} from "@corgtex/domain";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const EXPORT_PAGE_SIZE = 200;
const EXPORT_ROW_LIMIT = 5000;
const EXPORT_KINDS = ["projects", "clients", "consultants", "time", "expenses"] as const;

type ExportKind = typeof EXPORT_KINDS[number];

function isExportKind(value: string): value is ExportKind {
  return EXPORT_KINDS.includes(value as ExportKind);
}

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

function dateOnly(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  if (!/[",\n\r]/.test(safeText)) return safeText;
  return `"${safeText.replaceAll("\"", "\"\"")}"`;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => row.map(csvEscape).join(",")),
  ].join("\n");
}

async function requirePracticeLedgerExport(workspaceId: string) {
  const flags = await getWorkspaceFeatureFlags(workspaceId);
  if (!flags.FINANCE || !flags.PRACTICE_PROJECTS) {
    throw new AppError(404, "NOT_FOUND", "Practice Ledger exports are not enabled for this workspace.");
  }
}

async function projectCsv(actor: Parameters<typeof listPracticeProjects>[0], workspaceId: string) {
  const rows: Awaited<ReturnType<typeof listPracticeProjects>> = [];
  let cursor: string | null = null;
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listPracticeProjects(actor, workspaceId, { take: EXPORT_PAGE_SIZE, cursor });
    rows.push(...page);
    if (page.length < EXPORT_PAGE_SIZE) break;
    cursor = page.at(-1)?.id ?? null;
    if (!cursor) break;
  }
  return csv(
    [
      "code",
      "name",
      "client",
      "status",
      "currency",
      "po_value",
      "service_budget",
      "expense_budget",
      "used",
      "weekly_burn",
      "target_margin_bps",
      "current_margin_bps",
      "crm_account_id",
      "crm_deal_id",
      "source_satellite_id",
    ],
    rows.slice(0, EXPORT_ROW_LIMIT).map((project) => [
      project.code,
      project.name,
      project.clientName,
      project.status,
      project.currency,
      dollars(project.poValueCents),
      dollars(project.serviceBudgetCents),
      dollars(project.expenseBudgetCents),
      dollars(project.usedCents),
      dollars(project.weeklyBurnCents),
      project.targetMarginBps ?? "",
      project.currentMarginBps ?? "",
      project.crmAccountId ?? "",
      project.crmDealId ?? "",
      project.sourceSatelliteId ?? "",
    ]),
  );
}

async function clientCsv(actor: Parameters<typeof listNativePracticeClients>[0], workspaceId: string) {
  const rows: Awaited<ReturnType<typeof listNativePracticeClients>>["items"] = [];
  let cursor: string | null = null;
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listNativePracticeClients(actor, workspaceId, { take: EXPORT_PAGE_SIZE, cursor });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return csv(
    ["code", "name", "crm_account", "status", "projects", "time_entries", "expenses", "source_satellite_id"],
    rows.slice(0, EXPORT_ROW_LIMIT).map((client) => [
      client.code,
      client.name,
      client.crmAccount?.name ?? "",
      client.status,
      client._count.projects,
      client._count.timeEntries,
      client._count.expenses,
      client.sourceSatelliteId ?? "",
    ]),
  );
}

async function consultantCsv(actor: Parameters<typeof listNativePracticeConsultants>[0], workspaceId: string) {
  const rows: Awaited<ReturnType<typeof listNativePracticeConsultants>>["items"] = [];
  let cursor: string | null = null;
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listNativePracticeConsultants(actor, workspaceId, { take: EXPORT_PAGE_SIZE, cursor });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return csv(
    ["name", "email", "home_currency", "active", "assignments", "time_entries", "expenses", "payment_batches", "source_satellite_id"],
    rows.slice(0, EXPORT_ROW_LIMIT).map((consultant) => [
      consultant.name,
      consultant.email ?? "",
      consultant.homeCurrency,
      consultant.active ? "true" : "false",
      consultant._count.assignments,
      consultant._count.timeEntries,
      consultant._count.expenses,
      consultant._count.paymentBatches,
      consultant.sourceSatelliteId ?? "",
    ]),
  );
}

async function timeCsv(actor: Parameters<typeof listNativePracticeTimeEntryPage>[0], workspaceId: string) {
  const rows: Awaited<ReturnType<typeof listNativePracticeTimeEntryPage>>["items"] = [];
  let cursor: string | null = null;
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listNativePracticeTimeEntryPage(actor, workspaceId, { take: EXPORT_PAGE_SIZE, cursor });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return csv(
    [
      "worked_on",
      "week_ending_on",
      "project_code",
      "project",
      "client",
      "consultant",
      "consultant_email",
      "hours",
      "assignment_type",
      "currency",
      "bill_rate",
      "cost_rate",
      "bill_amount",
      "cost_amount",
      "status",
      "source_satellite_id",
    ],
    rows.slice(0, EXPORT_ROW_LIMIT).map((entry) => [
      dateOnly(entry.workedOn),
      dateOnly(entry.weekEndingOn),
      entry.project.code,
      entry.project.name,
      entry.client.name,
      entry.consultant.name,
      entry.consultant.email ?? "",
      entry.hours.toString(),
      entry.assignmentType,
      entry.currency,
      dollars(entry.billRateCents),
      dollars(entry.costRateCents),
      dollars(entry.billAmountCents),
      dollars(entry.costAmountCents),
      entry.status,
      entry.sourceSatelliteId ?? "",
    ]),
  );
}

async function expenseCsv(actor: Parameters<typeof listNativePracticeExpensePage>[0], workspaceId: string) {
  const rows: Awaited<ReturnType<typeof listNativePracticeExpensePage>>["items"] = [];
  let cursor: string | null = null;
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listNativePracticeExpensePage(actor, workspaceId, { take: EXPORT_PAGE_SIZE, cursor });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return csv(
    [
      "spent_on",
      "project_code",
      "project",
      "client",
      "consultant",
      "consultant_email",
      "vendor",
      "category",
      "business_purpose",
      "amount",
      "currency",
      "functional_amount",
      "functional_currency",
      "billable",
      "status",
      "source_satellite_id",
    ],
    rows.slice(0, EXPORT_ROW_LIMIT).map((entry) => [
      dateOnly(entry.spentOn),
      entry.project.code,
      entry.project.name,
      entry.client.name,
      entry.consultant?.name ?? "",
      entry.consultant?.email ?? "",
      entry.vendor ?? "",
      entry.category,
      entry.businessPurpose,
      dollars(entry.amountCents),
      entry.currency,
      dollars(entry.amountFunctionalCents),
      entry.functionalCurrency ?? "",
      entry.billable ? "true" : "false",
      entry.status,
      entry.sourceSatelliteId ?? "",
    ]),
  );
}

export const GET = withWorkspaceRoute(async (_req, { actor, workspaceId, params }) => {
  const kind = params.kind;
  if (!isExportKind(kind)) {
    throw new AppError(404, "NOT_FOUND", "Unknown Practice Ledger export.");
  }
  await requirePracticeLedgerExport(workspaceId);
  const body = kind === "projects"
    ? await projectCsv(actor, workspaceId)
    : kind === "clients"
      ? await clientCsv(actor, workspaceId)
      : kind === "consultants"
        ? await consultantCsv(actor, workspaceId)
        : kind === "time"
          ? await timeCsv(actor, workspaceId)
          : await expenseCsv(actor, workspaceId);

  return new NextResponse(body, {
    headers: {
      "Content-Disposition": `attachment; filename="practice-ledger-${kind}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
});
