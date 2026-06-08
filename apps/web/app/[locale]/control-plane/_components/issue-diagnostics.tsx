"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge, controlPlaneButtonClass, controlPlaneLabel } from "./control-plane-ui";

export type ControlPlaneIssueView = {
  id: string;
  source: string;
  severity: "warning" | "critical";
  title: string;
  status: string;
  detail: string;
  observedAt: string | null;
  suggestedAction: string;
  agentPrompt: string;
};

function observedLabel(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function serializeControlPlaneIssues(issues: Array<Omit<ControlPlaneIssueView, "observedAt"> & { observedAt?: Date | string | null }>): ControlPlaneIssueView[] {
  return issues.map((issue) => ({
    ...issue,
    observedAt: issue.observedAt
      ? (issue.observedAt instanceof Date ? issue.observedAt.toISOString() : issue.observedAt)
      : null,
  }));
}

export function ControlPlaneIssueDiagnostics({
  issues,
  className,
  maxVisible = 3,
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  triggerIssueId,
  hideBadges = false,
}: {
  issues: ControlPlaneIssueView[];
  className?: string;
  maxVisible?: number;
  triggerLabel?: ReactNode;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  triggerIssueId?: string;
  hideBadges?: boolean;
}) {
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const selectedIssue = useMemo(
    () => issues.find((issue) => issue.id === selectedIssueId) ?? null,
    [issues, selectedIssueId],
  );
  const visibleIssues = issues.slice(0, maxVisible);
  const hiddenCount = Math.max(issues.length - visibleIssues.length, 0);

  if (issues.length === 0) return null;

  return (
    <>
      {triggerLabel && (
        <button
          type="button"
          onClick={() => setSelectedIssueId(triggerIssueId ?? issues[0]?.id ?? null)}
          className={triggerClassName}
          aria-label={triggerAriaLabel}
        >
          {triggerLabel}
        </button>
      )}
      {!hideBadges && (
        <div className={cn("flex flex-wrap gap-1.5", className)}>
          {visibleIssues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => setSelectedIssueId(issue.id)}
              className={cn(
                "rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-wide transition-colors",
                issue.severity === "critical"
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
              )}
            >
              {controlPlaneLabel(issue.source)}
            </button>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIssueId(issues[maxVisible]?.id ?? issues[0]?.id ?? null)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-[9px] font-semibold text-muted hover:bg-surface-strong"
            >
              +{hiddenCount}
            </button>
          )}
        </div>
      )}

      {selectedIssue && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close issue details"
            className="absolute inset-0 bg-black/50"
            onClick={() => setSelectedIssueId(null)}
          />
          <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-line bg-bg-alt p-5 text-text-strong shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
              <div className="min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                  {controlPlaneLabel(selectedIssue.source)}
                </span>
                <h2 className="mt-1 text-base font-semibold text-white">{selectedIssue.title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <StatusBadge status={selectedIssue.status} />
                  <span className="text-[10px] text-muted">Observed {observedLabel(selectedIssue.observedAt)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedIssueId(null)}
                className="rounded-md border border-line bg-surface p-1.5 text-muted hover:text-white"
                aria-label="Close issue details"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto py-4">
              <section className="rounded-md border border-line bg-surface p-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted">Detail</h3>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-text">{selectedIssue.detail}</p>
              </section>
              <section className="rounded-md border border-line bg-surface p-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted">Next Action</h3>
                <p className="mt-2 text-xs leading-5 text-text">{selectedIssue.suggestedAction}</p>
              </section>
              <section className="rounded-md border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted">Agent Brief</h3>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(selectedIssue.agentPrompt)}
                    className={controlPlaneButtonClass}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <pre className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-bg p-3 text-[10px] leading-4 text-muted">
                  {selectedIssue.agentPrompt}
                </pre>
              </section>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
