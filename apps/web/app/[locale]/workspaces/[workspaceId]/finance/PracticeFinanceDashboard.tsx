import {
  projectBudgetRunwayWeeks,
  projectRemainingCents,
  projectUsedRatio,
  type PracticeAttentionItem,
  type PracticeFinanceSummary,
} from "@corgtex/domain";
import type { PracticeProject } from "@prisma/client";

/**
 * Native first-party practice-finance dashboard - the cutover UI for the
 * Practice Ledger satellite. Renders entirely from Corgtex Postgres
 * (`PracticeProject`) via the `practice-finance` domain: portfolio metrics,
 * the Attention queue, and the projects table.
 */

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function marginPct(bps: number | null): string {
  return bps == null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

function weeksLabel(weeks: number | null): string {
  return weeks == null ? "No risk" : `${weeks.toFixed(1)}w`;
}

function statusLabel(status: PracticeProject["status"]): string {
  return status.toLowerCase().replace("_", " ");
}

const METRIC: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 140,
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "14px 16px",
};

const LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

export function PracticeFinanceDashboard({
  summary,
  attention,
  projects,
}: {
  summary: PracticeFinanceSummary;
  attention: PracticeAttentionItem[];
  projects: PracticeProject[];
}) {
  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-dashboard">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <h1>Practice finance dashboard</h1>
        <div className="nr-masthead-meta">
          <span>Project margin, budget burn, client portfolio, and alerts for the active practice.</span>
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="nr-item" style={{ padding: 24, textAlign: "center" }}>
          <strong style={{ display: "block", marginBottom: 6 }}>No practice projects yet</strong>
          <p className="nr-item-meta" style={{ margin: "0 auto", maxWidth: 460 }}>
            Add your first project to track budgets, burn, and margin here. If you are moving from the Practice Ledger
            app, import your existing projects with <code>scripts/import-practice-ledger-export.mjs</code>. Expenses and
            ledger accounts are available in the tabs below in the meantime.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={METRIC}>
              <div style={LABEL}>Active projects</div>
              <div style={{ fontSize: 26, marginTop: 6 }}>{summary.activeProjects}</div>
            </div>
            <div style={METRIC}>
              <div style={LABEL}>Budget</div>
              <div style={{ fontSize: 26, marginTop: 6 }}>{usd(summary.budgetCents)}</div>
            </div>
            <div style={METRIC}>
              <div style={LABEL}>Used</div>
              <div style={{ fontSize: 26, marginTop: 6 }}>{usd(summary.usedCents)}</div>
            </div>
            <div style={METRIC}>
              <div style={LABEL}>Remaining</div>
              <div style={{ fontSize: 26, marginTop: 6 }}>{usd(summary.remainingCents)}</div>
            </div>
            <div style={METRIC}>
              <div style={LABEL}>Margin</div>
              <div style={{ fontSize: 26, marginTop: 6 }}>{marginPct(summary.marginBps)}</div>
            </div>
          </div>

          <div className="nr-item" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
              <strong>Attention</strong>
            </div>
            {attention.length === 0 ? (
              <p className="nr-item-meta" style={{ padding: 16, margin: 0 }}>No projects need attention.</p>
            ) : (
              <table className="nr-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Project</th>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Issue</th>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Weeks</th>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map((item, idx) => (
                    <tr key={`${item.projectId}-${item.issue}-${idx}`} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "8px 16px" }}>{item.projectName}</td>
                      <td
                        style={{
                          padding: "8px 16px",
                          color: item.issue === "setup" ? "var(--muted)" : "var(--danger)",
                        }}
                      >
                        {item.issue}
                      </td>
                      <td style={{ padding: "8px 16px" }}>{item.weeks == null ? "—" : item.weeks.toFixed(1)}</td>
                      <td style={{ padding: "8px 16px" }} className="nr-item-meta">{item.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="nr-item" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
              <strong>Projects</strong>
            </div>
            {projects.length === 0 ? (
              <p className="nr-item-meta" style={{ padding: 16, margin: 0 }}>No practice projects yet.</p>
            ) : (
              <table className="nr-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Project</th>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Client</th>
                    <th style={{ textAlign: "left", padding: "8px 16px", ...LABEL }}>Status</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Budget</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Used</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Remaining</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Used %</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Margin</th>
                    <th style={{ textAlign: "right", padding: "8px 16px", ...LABEL }}>Budget runway</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "8px 16px" }}>
                        <div>{p.name}</div>
                        <div className="nr-item-meta" style={{ fontSize: 11 }}>{p.code}</div>
                      </td>
                      <td style={{ padding: "8px 16px" }}>{p.clientName}</td>
                      <td style={{ padding: "8px 16px" }}>{statusLabel(p.status)}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>{usd(p.poValueCents)}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>{usd(p.usedCents)}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>{usd(projectRemainingCents(p))}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>{pct(projectUsedRatio(p))}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>{marginPct(p.currentMarginBps)}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>
                        {weeksLabel(projectBudgetRunwayWeeks(p))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
