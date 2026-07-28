import {
  canManagePracticeFinanceProjects,
  listNativePracticeProjectExportRows,
  requireWorkspaceMembership,
  summarizeNativePracticeFinance,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/lib/components/DataTable";
import { WorkspaceEmptyState, WorkspacePageHeader } from "@/lib/components/ControlPrimitives";
import { isWorkspaceFinanceCapabilityEnabled, requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { PracticeProjectAddPanel } from "../../add/PracticeProjectAddPanel";
import { createPracticeProjectAction } from "../actions";
import { PracticeFinanceNav, PracticeMetric, marginLabel, nextHref, statusLabel, wholeMoney } from "../components";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function usedPercent(usedCents: number, budgetCents: number) {
  if (budgetCents <= 0) return "-";
  return `${((usedCents / budgetCents) * 100).toFixed(1)}%`;
}

function runwayLabel(weeks: number | null) {
  if (weeks == null) return "-";
  if (!Number.isFinite(weeks)) return "No current burn";
  return `${weeks.toFixed(1)} weeks`;
}

export default async function FinanceProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const cursor = firstQueryValue(query?.cursor);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  const [membership, workspace, projectPage, slicingPieEnabled] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listNativePracticeProjectExportRows(actor, workspaceId, { take: 50, cursor }),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "slicingPie"),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canManageProjects = !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const summary = summarizeNativePracticeFinance(projectPage.items.map((item) => item.health));
  const nextPageHref = nextHref(`/workspaces/${workspaceId}/finance/projects`, {}, projectPage.nextCursor);
  const projectColumns: DataTableColumn[] = [
    { id: "project", label: "Project" },
    { id: "client", label: "Client" },
    { id: "status", label: "Status" },
    { id: "budget", label: "Budget", align: "right" },
    { id: "used", label: "Used", align: "right" },
    { id: "remaining", label: "Remaining", align: "right" },
    { id: "usedPercent", label: "Used %", align: "right" },
    { id: "margin", label: "Margin", align: "right" },
    { id: "runway", label: "Runway", align: "right" },
  ];
  const projectRows: DataTableRow[] = projectPage.items.map(({ project, health }) => ({
    id: project.id,
    cells: {
      project: (
        <>
          <a className="nr-table-link" href={`/workspaces/${workspaceId}/finance/projects/${project.id}`}>{project.name}</a>
          <div className="nr-item-meta nr-table-cell-meta">{project.code}</div>
        </>
      ),
      client: health.clientId
        ? <a className="nr-table-link" href={`/workspaces/${workspaceId}/finance/clients/${health.clientId}`}>{health.clientName}</a>
        : health.clientName,
      status: statusLabel(project.status),
      budget: wholeMoney(health.budgetCents, health.currency),
      used: wholeMoney(health.usedBudgetCents, health.currency),
      remaining: wholeMoney(health.remainingBudgetCents, health.currency),
      usedPercent: usedPercent(health.usedBudgetCents, health.budgetCents),
      margin: marginLabel(health.grossMarginBps),
      runway: runwayLabel(health.weeksToBudgetExhaustion),
    },
  }));

  return (
    <section className="stack nr-workspace-surface" data-finance-surface="projects">
      <WorkspacePageHeader
        className="nr-workspace-page-header-flush"
        eyebrow={<a className="nr-link" href={`/workspaces/${workspaceId}/finance`}>Back to Finance</a>}
        title="Projects"
        description="Finance projects with budget, burn, margin, and runway signals."
        subnav={<PracticeFinanceNav workspaceId={workspaceId} active="projects" slicingPieEnabled={slicingPieEnabled} />}
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <PracticeMetric label="Active projects" value={summary.activeProjects.toLocaleString("en-US")} />
        <PracticeMetric label="Budget" value={summary.currency == null ? "Mixed" : wholeMoney(summary.budgetCents, summary.currency)} />
        <PracticeMetric label="Remaining" value={summary.currency == null ? "Mixed" : wholeMoney(summary.remainingCents, summary.currency)} />
        <PracticeMetric label="Margin" value={marginLabel(summary.marginBps)} />
        <PracticeMetric label="Budget risks" value={summary.riskBudgetCount.toLocaleString("en-US")} />
      </div>

      {canManageProjects && (
        <details>
          <summary className="link-button small" style={{ cursor: "pointer", width: "fit-content" }}>Create project</summary>
          <PracticeProjectAddPanel
            action={createPracticeProjectAction}
            canManagePracticeProjects
            returnTo={`/workspaces/${workspaceId}/finance/projects`}
            workspaceId={workspaceId}
          />
        </details>
      )}

      <div className="nr-section-card">
        <div className="nr-section-card-header">
          <strong>Projects</strong>
        </div>
        <DataTable
          caption="Finance projects"
          columns={projectColumns}
          rows={projectRows}
          empty={
            <WorkspaceEmptyState
              title="No Finance projects have been created yet."
              description="Create a project to begin tracking budget, time, expenses, and margin."
            />
          }
          surfaceClassName="nr-section-card-table"
        />
        {nextPageHref && (
          <div className="nr-section-card-footer">
            <a className="link-button small secondary" href={nextPageHref}>Next projects</a>
          </div>
        )}
      </div>
    </section>
  );
}
