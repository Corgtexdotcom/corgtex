import { listNativePracticeConsultants } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { PracticeFinanceNav, nextHref } from "../components";

export const dynamic = "force-dynamic";

export default async function PracticeConsultantsPage({
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
  const [consultants, slicingPieEnabled] = await Promise.all([
    listNativePracticeConsultants(actor, workspaceId, { take: 50, cursor }),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
  ]);
  const nextPageHref = nextHref(`/workspaces/${workspaceId}/finance/consultants`, {}, consultants.nextCursor);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-consultants">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>
        <h1 style={{ marginTop: 12 }}>Practice consultants</h1>
        <div className="nr-masthead-meta">
          <span>Native consultants linked to assignments, submitted time, expenses, and payment batches.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="consultants" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Consultants</strong>
        </div>
        {consultants.items.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No consultants have been linked yet. Submitting native time or expenses creates the consultant relationship.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Consultant</th>
                  <th>Status</th>
                  <th>Currency</th>
                  <th style={{ textAlign: "right" }}>Assignments</th>
                  <th style={{ textAlign: "right" }}>Time</th>
                  <th style={{ textAlign: "right" }}>Expenses</th>
                  <th style={{ textAlign: "right" }}>Batches</th>
                </tr>
              </thead>
              <tbody>
                {consultants.items.map((consultant) => (
                  <tr key={consultant.id}>
                    <td>
                      <a href={`/workspaces/${workspaceId}/finance/consultants/${consultant.id}`}>{consultant.name}</a>
                      {consultant.email && <div className="nr-item-meta" style={{ fontSize: 11 }}>{consultant.email}</div>}
                    </td>
                    <td>{consultant.active ? "active" : "inactive"}</td>
                    <td>{consultant.homeCurrency}</td>
                    <td style={{ textAlign: "right" }}>{consultant._count.assignments}</td>
                    <td style={{ textAlign: "right" }}>{consultant._count.timeEntries}</td>
                    <td style={{ textAlign: "right" }}>{consultant._count.expenses}</td>
                    <td style={{ textAlign: "right" }}>{consultant._count.paymentBatches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextPageHref && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <a className="link-button small secondary" href={nextPageHref}>Next consultants</a>
          </div>
        )}
      </div>
    </section>
  );
}
