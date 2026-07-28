import { randomUUID } from "node:crypto";
import {
  canManagePracticeFinanceProjects,
  listNativePracticeExpensePage,
  listPracticeProjectsWithSelection,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFinanceCapabilityEnabled, requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { createNativePracticeExpenseAction } from "../actions";
import {
  PracticeFinanceNav,
  expenseAmount,
  formatDate,
  money,
  nextHref,
  statusLabel,
} from "../components";
import { PracticeExpenseSubmitForm } from "./PracticeExpenseSubmitForm";

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
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  const [membership, workspace, page, projects, slicingPieEnabled] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listNativePracticeExpensePage(actor, workspaceId, { take: 50, cursor, projectId, consultantId, clientId }),
    listPracticeProjectsWithSelection(actor, workspaceId, { take: 200, selectedProjectId: projectId }),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "slicingPie"),
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
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Finance</a>
        <h1 style={{ marginTop: 12 }}>Expenses</h1>
        <div className="nr-masthead-meta">
          <span>Submit and review Finance expenses.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="expenses" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      {canSubmit && (
        <PracticeExpenseSubmitForm
          action={createNativePracticeExpenseAction}
          idempotencyKey={`manual-expense-${randomUUID()}`}
          projects={projects.map((project) => ({
            code: project.code,
            currency: project.currency,
            id: project.id,
            name: project.name,
          }))}
          selectedProjectId={selectedProject?.id ?? ""}
          workspaceId={workspaceId}
        />
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
                {page.items.map((entry) => {
                  const amount = expenseAmount(entry);
                  return (
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
                      <td style={{ textAlign: "right" }}>{money(amount.cents, amount.currency)}</td>
                      <td>{entry.billable ? "Yes" : "No"}</td>
                      <td>{statusLabel(entry.status)}</td>
                    </tr>
                  );
                })}
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
