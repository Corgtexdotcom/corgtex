import { randomUUID } from "node:crypto";
import {
  canManagePracticeFinanceProjects,
  listNativePracticeExpensePage,
  listPracticeProjects,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { createNativePracticeExpenseAction } from "../actions";
import {
  PracticeFinanceNav,
  formGridStyle,
  formatDate,
  money,
  nextHref,
  statusLabel,
} from "../components";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PracticeExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const cursor = firstQueryValue(query?.cursor);
  const projectId = firstQueryValue(query?.projectId);
  const consultantId = firstQueryValue(query?.consultantId);
  const clientId = firstQueryValue(query?.clientId);
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFeature(workspaceId, "PRACTICE_PROJECTS");
  const [membership, workspace, page, projects, slicingPieEnabled] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listNativePracticeExpensePage(actor, workspaceId, { take: 50, cursor, projectId, consultantId, clientId }),
    listPracticeProjects(actor, workspaceId, { take: 200 }),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canSubmit = !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0];
  const nextPageHref = nextHref(`/workspaces/${workspaceId}/finance/expenses`, {
    projectId,
    consultantId,
    clientId,
  }, page.nextCursor);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-expenses">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>
        <h1 style={{ marginTop: 12 }}>Expenses</h1>
        <div className="nr-masthead-meta">
          <span>Submit and review native Practice Ledger expenses.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="expenses" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      {canSubmit && (
        <form action={createNativePracticeExpenseAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="idempotencyKey" value={`manual-expense-${randomUUID()}`} />
          <strong>Submit expense</strong>
          <label>
            Project
            <select name="projectId" required defaultValue={selectedProject?.id ?? ""} disabled={projects.length === 0}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.code} - {project.name}</option>
              ))}
            </select>
          </label>
          <div style={formGridStyle}>
            <label>Date<input name="spentOn" type="date" required /></label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Currency<input name="currency" defaultValue={selectedProject?.currency ?? "USD"} required /></label>
          </div>
          <div style={formGridStyle}>
            <label>Vendor<input name="vendor" /></label>
            <label>Category<input name="category" defaultValue="Client expense" required /></label>
          </div>
          <div style={formGridStyle}>
            <label>Consultant<input name="consultantName" /></label>
            <label>Email<input name="consultantEmail" type="email" /></label>
          </div>
          <label>Business purpose<input name="businessPurpose" required /></label>
          <label style={{ alignItems: "center", display: "flex", flexDirection: "row", gap: 8 }}>
            <input name="billable" type="checkbox" defaultChecked />
            Billable to client
          </label>
          <button type="submit" className="fin-action-btn" disabled={projects.length === 0}>Submit expense</button>
          {projects.length === 0 && <p className="nr-item-meta" style={{ margin: 0 }}>Create a project before submitting expenses.</p>}
        </form>
      )}

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent expenses</strong>
        </div>
        {page.items.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No expenses match this view.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Consultant</th>
                  <th>Category</th>
                  <th>Purpose</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Billable</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.spentOn)}</td>
                    <td>
                      <a href={`/workspaces/${workspaceId}/finance/projects/${entry.project.id}`}>{entry.project.name}</a>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.project.code}</div>
                    </td>
                    <td><a href={`/workspaces/${workspaceId}/finance/clients/${entry.client.id}`}>{entry.client.name}</a></td>
                    <td>
                      {entry.consultant ? (
                        <a href={`/workspaces/${workspaceId}/finance/consultants/${entry.consultant.id}`}>{entry.consultant.name}</a>
                      ) : "-"}
                    </td>
                    <td>{entry.category}</td>
                    <td>{entry.businessPurpose}</td>
                    <td style={{ textAlign: "right" }}>{money(entry.amountFunctionalCents ?? entry.amountCents, entry.functionalCurrency ?? entry.currency)}</td>
                    <td>{entry.billable ? "Yes" : "No"}</td>
                    <td>{statusLabel(entry.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextPageHref && (
          <div style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <a className="link-button small secondary" href={nextPageHref}>Next expenses</a>
          </div>
        )}
      </div>
    </section>
  );
}
