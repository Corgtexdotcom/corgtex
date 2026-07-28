import type { ReactNode } from "react";
import { Prisma } from "@prisma/client";
import { WorkspaceSubnav } from "@/lib/components/ControlPrimitives";

export type PracticeFinanceSection =
  | "overview"
  | "projects"
  | "clients"
  | "consultants"
  | "time"
  | "expenses"
  | "reports"
  | "slicing-pie";

const navItems: Array<{ key: PracticeFinanceSection; label: string; href: (workspaceId: string) => string }> = [
  { key: "overview", label: "Overview", href: (workspaceId) => `/workspaces/${workspaceId}/finance` },
  { key: "projects", label: "Projects", href: (workspaceId) => `/workspaces/${workspaceId}/finance/projects` },
  { key: "clients", label: "Clients", href: (workspaceId) => `/workspaces/${workspaceId}/finance/clients` },
  { key: "consultants", label: "Consultants", href: (workspaceId) => `/workspaces/${workspaceId}/finance/consultants` },
  { key: "time", label: "Time", href: (workspaceId) => `/workspaces/${workspaceId}/finance/time` },
  { key: "expenses", label: "Expenses", href: (workspaceId) => `/workspaces/${workspaceId}/finance/expenses` },
  { key: "reports", label: "Reports", href: (workspaceId) => `/workspaces/${workspaceId}/finance/reports` },
  { key: "slicing-pie", label: "Slicing Pie", href: (workspaceId) => `/workspaces/${workspaceId}/finance/slicing-pie` },
];

const projectFinanceSections = new Set<PracticeFinanceSection>(["projects", "clients", "consultants", "time", "expenses", "reports"]);

export const metricStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 8,
  flex: "1 1 150px",
  minWidth: 130,
  padding: "12px 14px",
};

export const labelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

export const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
};

export function PracticeFinanceNav({
  workspaceId,
  active,
  financeProjectsEnabled = true,
  slicingPieEnabled = false,
}: {
  workspaceId: string;
  active: PracticeFinanceSection;
  financeProjectsEnabled?: boolean;
  slicingPieEnabled?: boolean;
}) {
  return (
    <WorkspaceSubnav
      label="Finance sections"
      items={navItems
        .filter((item) => financeProjectsEnabled || !projectFinanceSections.has(item.key))
        .filter((item) => item.key !== "slicing-pie" || slicingPieEnabled)
        .map((item) => ({
          key: item.key,
          label: item.label,
          href: item.href(workspaceId),
          active: item.key === active,
        }))}
    />
  );
}

export function PracticeMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={metricStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 24, marginTop: 6 }}>{value}</div>
    </div>
  );
}

export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      currency,
      style: "currency",
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toLocaleString("en-US", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })}`;
  }
}

export function wholeMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      currency,
      maximumFractionDigits: 0,
      style: "currency",
    }).format(cents / 100);
  } catch {
    return `${currency} ${Math.round(cents / 100).toLocaleString("en-US")}`;
  }
}

export function rateDerivedCents(hours: { toString(): string }, rateCents: number): number {
  return new Prisma.Decimal(hours.toString()).mul(rateCents).toDecimalPlaces(0).toNumber();
}

export function timeBillAmount(entry: {
  billAmountCents: number | null;
  billCurrency: string | null;
  currency: string;
  functionalCurrency: string | null;
  hours: { toString(): string };
  billRateCents: number;
}): { cents: number; currency: string } {
  if (entry.billAmountCents != null) {
    return { cents: entry.billAmountCents, currency: entry.functionalCurrency ?? entry.billCurrency ?? entry.currency };
  }
  return { cents: rateDerivedCents(entry.hours, entry.billRateCents), currency: entry.billCurrency ?? entry.currency };
}

export function timeCostAmount(entry: {
  costAmountCents: number | null;
  costCurrency: string | null;
  currency: string;
  functionalCurrency: string | null;
  hours: { toString(): string };
  costRateCents: number;
}): { cents: number; currency: string } {
  if (entry.costAmountCents != null) {
    return { cents: entry.costAmountCents, currency: entry.functionalCurrency ?? entry.costCurrency ?? entry.currency };
  }
  return { cents: rateDerivedCents(entry.hours, entry.costRateCents), currency: entry.costCurrency ?? entry.currency };
}

export function expenseAmount(entry: {
  amountCents: number;
  amountFunctionalCents: number | null;
  currency: string;
  functionalCurrency: string | null;
}): { cents: number; currency: string } {
  if (entry.amountFunctionalCents != null && entry.functionalCurrency?.trim()) {
    return { cents: entry.amountFunctionalCents, currency: entry.functionalCurrency };
  }
  return { cents: entry.amountCents, currency: entry.currency };
}

export function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function statusLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function marginLabel(bps: number | null): string {
  return bps == null ? "-" : `${(bps / 100).toFixed(1)}%`;
}

export function hoursLabel(value: { toString(): string }): string {
  return Number.parseFloat(value.toString()).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

export function nextHref(basePath: string, searchParams: Record<string, string | null | undefined>, nextCursor: string | null) {
  if (!nextCursor) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value) params.set(key, value);
  }
  params.set("cursor", nextCursor);
  return `${basePath}?${params.toString()}`;
}
