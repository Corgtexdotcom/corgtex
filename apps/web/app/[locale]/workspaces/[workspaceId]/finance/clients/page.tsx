import { listNativePracticeClients } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { DataTable, type DataTableColumn, type DataTableRow } from "@/lib/components/DataTable";
import { WorkspaceEmptyState, WorkspacePageHeader } from "@/lib/components/ControlPrimitives";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { PracticeFinanceNav, nextHref, statusLabel } from "../components";

export const dynamic = "force-dynamic";

export default async function PracticeClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const cursor = Array.isArray(query?.cursor) ? query.cursor[0] : query?.cursor;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFeature(workspaceId, "PRACTICE_PROJECTS");
  const [clients, slicingPieEnabled] = await Promise.all([
    listNativePracticeClients(actor, workspaceId, { take: 50, cursor }),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
  ]);
  const nextPageHref = nextHref(`/workspaces/${workspaceId}/finance/clients`, {}, clients.nextCursor);
  const clientColumns: DataTableColumn[] = [
    { id: "client", label: "Client" },
    { id: "crmAccount", label: "CRM account" },
    { id: "status", label: "Status" },
    { id: "projects", label: "Projects", align: "right" },
    { id: "time", label: "Time", align: "right" },
    { id: "expenses", label: "Expenses", align: "right" },
  ];
  const clientRows: DataTableRow[] = clients.items.map((client) => ({
    id: client.id,
    cells: {
      client: (
        <>
          <a className="nr-table-link" href={`/workspaces/${workspaceId}/finance/clients/${client.id}`}>{client.name}</a>
          <div className="nr-item-meta nr-table-cell-meta">{client.code}</div>
        </>
      ),
      crmAccount: client.crmAccount ? client.crmAccount.name : "-",
      status: statusLabel(client.status),
      projects: client._count.projects,
      time: client._count.timeEntries,
      expenses: client._count.expenses,
    },
  }));

  return (
    <section className="stack nr-workspace-surface" data-finance-surface="practice-clients">
      <WorkspacePageHeader
        className="nr-workspace-page-header-flush"
        eyebrow={<a className="nr-link" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>}
        title="Practice clients"
        description="Native clients linked from CRM accounts, projects, time, and expenses."
        subnav={<PracticeFinanceNav workspaceId={workspaceId} active="clients" slicingPieEnabled={slicingPieEnabled} />}
      />

      <div className="nr-section-card">
        <div className="nr-section-card-header">
          <strong>Clients</strong>
        </div>
        <DataTable
          caption="Practice clients"
          columns={clientColumns}
          rows={clientRows}
          empty={
            <WorkspaceEmptyState
              title="No native Practice Ledger clients have been linked yet."
              description="Submitting time or expenses on a project will create the native client relationship."
            />
          }
          surfaceClassName="nr-section-card-table"
        />
        {nextPageHref && (
          <div className="nr-section-card-footer">
            <a className="link-button small secondary" href={nextPageHref}>Next clients</a>
          </div>
        )}
      </div>
    </section>
  );
}
