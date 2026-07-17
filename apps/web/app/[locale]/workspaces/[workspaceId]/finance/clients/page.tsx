import { listNativePracticeClients } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
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

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-clients">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>
        <h1 style={{ marginTop: 12 }}>Practice clients</h1>
        <div className="nr-masthead-meta">
          <span>Native clients linked from CRM accounts, projects, time, and expenses.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="clients" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Clients</strong>
        </div>
        {clients.items.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No native Practice Ledger clients have been linked yet. Submitting time or expenses on a project will create the native client relationship.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>CRM account</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Projects</th>
                  <th style={{ textAlign: "right" }}>Time</th>
                  <th style={{ textAlign: "right" }}>Expenses</th>
                </tr>
              </thead>
              <tbody>
                {clients.items.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <a href={`/workspaces/${workspaceId}/finance/clients/${client.id}`}>{client.name}</a>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{client.code}</div>
                    </td>
                    <td>{client.crmAccount ? client.crmAccount.name : "-"}</td>
                    <td>{statusLabel(client.status)}</td>
                    <td style={{ textAlign: "right" }}>{client._count.projects}</td>
                    <td style={{ textAlign: "right" }}>{client._count.timeEntries}</td>
                    <td style={{ textAlign: "right" }}>{client._count.expenses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextPageHref && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <a className="link-button small secondary" href={nextPageHref}>Next clients</a>
          </div>
        )}
      </div>
    </section>
  );
}
