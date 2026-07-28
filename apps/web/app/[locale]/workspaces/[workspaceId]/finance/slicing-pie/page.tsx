import { getSlicingPieSummary } from "@corgtex/domain";
import type { PracticeContributionEntryWithContext } from "@corgtex/domain";

import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFinanceCapabilityEnabled, requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { PracticeFinanceNav } from "../components";

export const dynamic = "force-dynamic";

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;
}

function ownership(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function dateLabel(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function paymentLabel(entry: PracticeContributionEntryWithContext): string {
  if (entry.paymentChoice === "SLICING_PIE") return `Slicing Pie ${entry.sliceMultiplier}x`;
  return entry.cashStatus === "PAID" ? "Cash paid" : "Cash requested";
}

function personLabel(person: { displayName: string | null; email: string } | null): string {
  if (!person) return "Unassigned";
  return person.displayName || person.email;
}

export default async function SlicingPiePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const sourceCursor = Array.isArray(query?.sourceCursor) ? query?.sourceCursor[0] : query?.sourceCursor;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "slicingPie");
  const [summary, financeProjectsEnabled] = await Promise.all([
    getSlicingPieSummary(actor, workspaceId, {
      sourceTake: 50,
      sourceCursor,
    }),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "projects"),
  ]);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="slicing-pie">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <div style={{ alignItems: "flex-start", display: "flex", gap: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1>Slicing Pie</h1>
            <div className="nr-masthead-meta">
              <span>Internal ownership calculation from Finance time and expense contributions.</span>
            </div>
          </div>
          <a href={`/workspaces/${workspaceId}/finance`} className="link-button secondary">Finance</a>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav
            workspaceId={workspaceId}
            active="slicing-pie"
            financeProjectsEnabled={financeProjectsEnabled}
            slicingPieEnabled
          />
        </div>
      </header>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, flex: "1 1 180px", padding: "14px 16px" }}>
          <div className="nr-item-meta">Total slices</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{summary.totalSlices.toLocaleString("en-US")}</div>
        </div>
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, flex: "1 1 180px", padding: "14px 16px" }}>
          <div className="nr-item-meta">Contributors</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{summary.contributors.length}</div>
        </div>
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <strong>Ownership</strong>
        </div>
        {summary.contributors.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No Slicing Pie contributions have been recorded.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Contributor</th>
                  <th style={{ textAlign: "right" }}>Time value</th>
                  <th style={{ textAlign: "right" }}>Expense value</th>
                  <th style={{ textAlign: "right" }}>Cash requested</th>
                  <th style={{ textAlign: "right" }}>Cash paid</th>
                  <th style={{ textAlign: "right" }}>Slices</th>
                  <th style={{ textAlign: "right" }}>Ownership</th>
                </tr>
              </thead>
              <tbody>
                {summary.contributors.map((contributor) => (
                  <tr key={contributor.userId}>
                    <td>
                      <div>{contributor.displayName}</div>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{contributor.email}</div>
                    </td>
                    <td style={{ textAlign: "right" }}>{usd(contributor.timeValueCents)}</td>
                    <td style={{ textAlign: "right" }}>{usd(contributor.expenseValueCents)}</td>
                    <td style={{ textAlign: "right" }}>{usd(contributor.cashRequestedCents)}</td>
                    <td style={{ textAlign: "right" }}>{usd(contributor.cashPaidCents)}</td>
                    <td style={{ textAlign: "right" }}>{contributor.slices.toLocaleString("en-US")}</td>
                    <td style={{ textAlign: "right" }}>{ownership(contributor.ownershipBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <strong>Source entries</strong>
        </div>
        {summary.entries.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No contribution entries are available.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Contributor</th>
                  <th>Submitted by</th>
                  <th>Project</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Value</th>
                  <th>Payment</th>
                  <th style={{ textAlign: "right" }}>Slices</th>
                </tr>
              </thead>
              <tbody>
                {summary.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{dateLabel(entry.occurredAt)}</td>
                    <td>{personLabel(entry.contributor)}</td>
                    <td>{personLabel(entry.submittedBy)}</td>
                    <td>
                      <div>{entry.project.name}</div>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.project.code}</div>
                    </td>
                    <td>{entry.type === "TIME" ? "Time" : "Expense"}</td>
                    <td style={{ textAlign: "right" }}>{usd(entry.amountCents)}</td>
                    <td>{paymentLabel(entry)}</td>
                    <td style={{ textAlign: "right" }}>{entry.slices.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {summary.nextSourceCursor && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance/slicing-pie?sourceCursor=${encodeURIComponent(summary.nextSourceCursor)}`}>
              Next source entries
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
