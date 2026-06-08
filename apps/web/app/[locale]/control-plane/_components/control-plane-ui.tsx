import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function controlPlaneLabel(value?: string | null) {
  return value ? value.replace(/_/g, " ") : "unknown";
}

export function controlPlaneTone(status?: string | null) {
  const normalized = status?.toLowerCase();
  if (["ok", "active", "connected", "ready", "managed", "completed", "passed", "enabled", "aligned", "available"].includes(normalized ?? "")) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-400";
  }
  if (["attention", "degraded", "provisioning", "configured", "pending", "needs_setup", "not_configured", "requires_connector", "unavailable", "running", "blocked", "trialing", "review_required"].includes(normalized ?? "")) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-400";
  }
  if (["down", "suspended", "failed", "disabled", "past_due"].includes(normalized ?? "")) {
    return "border-rose-500/25 bg-rose-500/10 text-rose-400";
  }
  return "border-slate-500/25 bg-slate-500/10 text-muted";
}

export function StatusBadge({
  status,
  children,
  className,
}: {
  status?: string | null;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold capitalize leading-5",
        controlPlaneTone(status),
        className,
      )}
    >
      {children ?? controlPlaneLabel(status)}
    </span>
  );
}

export function ControlPlanePageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted">
            {eyebrow}
          </span>
        )}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export function ControlPlaneSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("rounded-lg border border-line bg-bg-alt p-4", className)}>
      <div className="mb-4 flex flex-col gap-3 border-b border-line pb-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {description && <p className="mt-0.5 text-[10px] leading-4 text-muted">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function ControlPlaneStatusStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; detail?: string; status?: string | null; action?: ReactNode }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "relative rounded-lg border border-line bg-bg-alt px-3 py-2",
            item.action ? "transition-colors hover:border-amber-500/40 hover:bg-surface" : null,
          )}
        >
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{item.label}</span>
          <span className="mt-1 block text-xl font-semibold text-white">{item.value}</span>
          {item.detail && <span className={cn("mt-0.5 block text-[10px]", item.status ? controlPlaneTone(item.status).split(" ").at(-1) : "text-muted")}>{item.detail}</span>}
          {item.action}
        </div>
      ))}
    </div>
  );
}

export function controlPlaneCacheAgeLabel(cachedAt: Date) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - cachedAt.getTime()) / 1000));
  if (ageSeconds < 5) return "just now";
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  return `${Math.floor(ageSeconds / 60)}m ago`;
}

export function ControlPlaneCacheMeta({
  cachedAt,
  cacheStatus,
  refreshAction,
}: {
  cachedAt: Date;
  cacheStatus: "hit" | "miss" | "refresh";
  refreshAction?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
      <span className="rounded-md border border-line bg-surface px-2 py-1">
        {cacheStatus === "refresh" ? "Refreshed" : "Cached"} {controlPlaneCacheAgeLabel(cachedAt)}
      </span>
      {refreshAction}
    </div>
  );
}

export function DisabledActionHint({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-300">
      {children}
    </p>
  );
}

export const controlPlaneInputClass =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-line";

export const controlPlaneButtonClass =
  "inline-flex min-h-8 items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-text transition-colors hover:bg-surface-strong disabled:cursor-not-allowed disabled:bg-surface/40 disabled:text-muted";
