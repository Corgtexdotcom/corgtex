import { randomUUID } from "node:crypto";
import {
  canManagePracticeFinanceProjects,
  listNativePracticeTimeEntryPage,
  listPracticeProjectsWithSelection,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFinanceCapabilityEnabled, requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import { createNativePracticeTimeEntryAction } from "../actions";
import {
  PracticeFinanceNav,
  formGridStyle,
  formatDate,
  hoursLabel,
  money,
  nextHref,
  statusLabel,
  timeBillAmount,
  timeCostAmount,
} from "../components";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PracticeTimePage({
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
    listNativePracticeTimeEntryPage(actor, workspaceId, { take: 50, cursor, projectId, consultantId, clientId }),
    listPracticeProjectsWithSelection(actor, workspaceId, { take: 200, selectedProjectId: projectId }),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "slicingPie"),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canSubmit = !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const selectedProjectId = projectId && projects.some((project) => project.id === projectId) ? projectId : projects[0]?.id ?? "";
  const nextPageHref = nextHref(`/workspaces/${workspaceId}/finance/time`, {
    projectId,
    consultantId,
    clientId,
  }, page.nextCursor);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-time">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Finance</a>
        <h1 style={{ marginTop: 12 }}>Time</h1>
        <div className="nr-masthead-meta">
          <span>Submit and review Finance time entries.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="time" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      {canSubmit && (
        <form action={createNativePracticeTimeEntryAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="idempotencyKey" value={`manual-time-${randomUUID()}`} />
          <strong>Submit time</strong>
          <label>
            Project
            <select name="projectId" required defaultValue={selectedProjectId} disabled={projects.length === 0}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.code} - {project.name}</option>
              ))}
            </select>
          </label>
          <div style={formGridStyle}>
            <label>Consultant<input name="consultantName" required /></label>
            <label>Email<input name="consultantEmail" type="email" /></label>
          </div>
          <div style={formGridStyle}>
            <label>Date<input name="workedOn" type="date" required /></label>
            <label>Hours<input name="hours" type="number" min="0.01" step="0.01" required /></label>
            <label>Assignment<input name="assignmentType" defaultValue="CONSULTING" required /></label>
          </div>
          <div style={formGridStyle}>
            <label>Bill rate<input name="billRate" type="number" min="0" step="0.01" defaultValue="0.00" /></label>
            <label>Cost rate<input name="costRate" type="number" min="0" step="0.01" defaultValue="0.00" /></label>
          </div>
          <button type="submit" className="fin-action-btn" disabled={projects.length === 0}>Submit time</button>
          {projects.length === 0 && <p className="nr-item-meta" style={{ margin: 0 }}>Create a project before submitting time.</p>}
        </form>
      )}

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent time entries</strong>
        </div>
        {page.items.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No time entries match this view.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Consultant</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  <th style={{ textAlign: "right" }}>Bill amount</th>
                  <th style={{ textAlign: "right" }}>Cost amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((entry) => {
                  const billAmount = timeBillAmount(entry);
                  const costAmount = timeCostAmount(entry);
                  return (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.workedOn)}</td>
                      <td>
                        <a href={`/workspaces/${workspaceId}/finance/projects/${entry.project.id}`}>{entry.project.name}</a>
                        <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.project.code}</div>
                      </td>
                      <td><a href={`/workspaces/${workspaceId}/finance/clients/${entry.client.id}`}>{entry.client.name}</a></td>
                      <td><a href={`/workspaces/${workspaceId}/finance/consultants/${entry.consultant.id}`}>{entry.consultant.name}</a></td>
                      <td style={{ textAlign: "right" }}>{hoursLabel(entry.hours)}</td>
                      <td style={{ textAlign: "right" }}>{money(billAmount.cents, billAmount.currency)}</td>
                      <td style={{ textAlign: "right" }}>{money(costAmount.cents, costAmount.currency)}</td>
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
            <a className="link-button small secondary" href={nextPageHref}>Next time entries</a>
          </div>
        )}
      </div>
    </section>
  );
}
