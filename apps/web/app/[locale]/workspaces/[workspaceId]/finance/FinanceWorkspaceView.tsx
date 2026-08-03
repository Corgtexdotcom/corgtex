import {
  FINANCE_SECTIONS,
  getFinanceReadiness,
  type FinanceSectionKey,
} from "@corgtex/domain";
import { WorkspaceEmptyState, WorkspacePageHeader, WorkspaceSubnav } from "@/lib/components/ControlPrimitives";
import { FinanceReportImportPanel } from "./FinanceReportImportPanel";
import { financeImportCanWrite } from "./financeReportImportView";

type FinanceReadiness = Awaited<ReturnType<typeof getFinanceReadiness>>;

function workspaceFinanceHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

function sectionDescription(section: FinanceSectionKey, enabled: boolean) {
  if (!enabled) return "Capability not enabled for this workspace.";
  if (section === "overview") return "Ready for workspace-scoped records and governed write access.";
  if (section === "slicing-pie") return "Cash payable confirmation requires another human contributor.";
  if (section === "capital") return "Capital contribution records are scoped to this workspace.";
  return "Records for this section are ready to be created.";
}

function sectionCount(readiness: FinanceReadiness, section: FinanceSectionKey) {
  switch (section) {
    case "projects":
      return readiness.counts.projects;
    case "clients":
      return readiness.counts.clients;
    case "consultants":
      return readiness.counts.consultants;
    case "time":
      return readiness.counts.timeEntries;
    case "expenses":
      return readiness.counts.expenses;
    case "slicing-pie":
      return readiness.counts.slicingPieContributionEntries;
    case "capital":
      return readiness.counts.capitalContributionEntries;
    default:
      return null;
  }
}

export function FinanceWorkspaceView({
  workspaceId,
  sectionKey,
  readiness,
  demoReadOnly = false,
}: {
  workspaceId: string;
  sectionKey: FinanceSectionKey;
  readiness: FinanceReadiness;
  demoReadOnly?: boolean;
}) {
  const activeSection = FINANCE_SECTIONS.find((section) => section.key === sectionKey) ?? FINANCE_SECTIONS[0];
  const readinessByKey = new Map(readiness.flags.map((section) => [section.key, section]));
  const activeReadiness = readinessByKey.get(activeSection.key);
  const enabled = Boolean(activeReadiness?.enabled);
  const count = sectionCount(readiness, activeSection.key);
  const showReportImports = activeSection.key === "reports" && enabled && readiness.capabilities.reportImports;
  const canWrite = financeImportCanWrite(readiness.access.canWrite, demoReadOnly);

  return (
    <div className="stack">
      <WorkspacePageHeader
        title={activeSection.key === "overview" ? "Finance" : activeSection.label}
        description="Native Finance V2 runs inside Corgtex and uses workspace-scoped Finance records."
        meta={(
          <>
            <span className="status-chip">{demoReadOnly ? "Read-only demo" : canWrite ? "Write access" : "Read access"}</span>
            {readiness.access.financeAllMemberWrite && <span className="status-chip">All-member write</span>}
            {showReportImports && <span className="status-chip">Report imports enabled</span>}
            <span className="status-chip">{readiness.retiredPracticeLedger.retired ? "Standalone ledger retired" : "Ledger review needed"}</span>
          </>
        )}
        subnav={(
          <WorkspaceSubnav
            label="Finance sections"
            items={FINANCE_SECTIONS.map((section) => ({
              key: section.key,
              label: section.label,
              href: workspaceFinanceHref(workspaceId, section.href),
              active: section.key === activeSection.key,
            }))}
          />
        )}
      />

      <div className="ws-stat-row">
        <div className="ws-stat-card">
          <strong>{readiness.counts.projects}</strong>
          <span>Projects</span>
        </div>
        <div className="ws-stat-card">
          <strong>{readiness.counts.clients}</strong>
          <span>Clients</span>
        </div>
        <div className="ws-stat-card">
          <strong>{readiness.counts.consultants}</strong>
          <span>Consultants</span>
        </div>
        <div className="ws-stat-card">
          <strong>{readiness.counts.requestedPayables}</strong>
          <span>Cash payables</span>
        </div>
      </div>

      {showReportImports ? (
        <FinanceReportImportPanel workspaceId={workspaceId} canWrite={canWrite} />
      ) : (
        <WorkspaceEmptyState
          className="finance-empty-state"
          title={enabled ? `${activeSection.label} records are ready` : `${activeSection.label} is not enabled`}
          description={count === null
            ? sectionDescription(activeSection.key, enabled)
            : `${sectionDescription(activeSection.key, enabled)} Current records: ${count}.`}
        />
      )}
    </div>
  );
}
