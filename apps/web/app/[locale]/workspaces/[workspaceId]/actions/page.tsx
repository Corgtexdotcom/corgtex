import { listActions, listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createActionAction,
  updateActionAction,
  deleteActionAction,
  publishActionAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function ActionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const [{ items: actions }, { items: proposals }] = await Promise.all([
    listActions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
  ]);
  
  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "SUBMITTED");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";

  const groupedActions = {
    PERSONAL: actions.filter((a) => a.isPrivate),
    OPEN: actions.filter((a) => a.status === "OPEN" && !a.isPrivate),
    IN_PROGRESS: actions.filter((a) => a.status === "IN_PROGRESS" && !a.isPrivate),
    COMPLETED: actions.filter((a) => a.status === "COMPLETED" && !a.isPrivate),
    ALL: actions,
  };

  const displayActions = statusFilter === "ALL" 
    ? groupedActions.ALL 
    : groupedActions[statusFilter as keyof typeof groupedActions] || groupedActions.OPEN;

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? "today" : `${days}d ago`;
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Actions</h1>
        <div className="nr-masthead-meta">
          <span>Tracked tasks, follow-ups, and commitments across circles.</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-filter-bar">
          {(["PERSONAL", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const).map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {s.replace("_", " ")} ({groupedActions[s].length})
            </a>
          ))}
        </div>

        <div>
          {displayActions.length === 0 && <p className="muted">No actions found.</p>}
          {displayActions.map((action) => (
            <div className="nr-item" key={action.id}>
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {action.isPrivate && <span title="Private (only visible to you)" style={{ marginRight: 6 }}>◆</span>}
                  {action.title}
                </strong>
                <span className={`tag ${action.status === "OPEN" ? "warning" : action.status === "IN_PROGRESS" ? "info" : "success"}`}>{action.status}</span>
              </div>
              {action.bodyMd && <div className="nr-excerpt">{action.bodyMd}</div>}
              
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                 Creator: {action.author.displayName || action.author.email} · {ageText(action.createdAt)}
                 {action.assigneeMember && ` · Assignee: ${action.assigneeMember.user.displayName || action.assigneeMember.user.email}`}
                 {action.dueAt && ` · Due: ${new Date(action.dueAt).toLocaleDateString()}`}
                 {action.proposal && ` · Linked to Proposal: ${action.proposal.title}`}
              </div>

              <div className="actions-inline" style={{ marginTop: 12 }}>
                {action.isPrivate && (
                  <form action={publishActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <button type="submit" className="primary small">Publish to Workspace</button>
                  </form>
                )}
                {!action.isPrivate && action.status === "OPEN" && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="IN_PROGRESS" />
                    <button type="submit" className="secondary small">Start</button>
                  </form>
                )}
                {!action.isPrivate && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="COMPLETED" />
                    <button type="submit" className="secondary small">Complete</button>
                  </form>
                )}
                {!action.isPrivate && (action.status === "OPEN" || action.status === "IN_PROGRESS") && (
                  <form action={updateActionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="actionId" value={action.id} />
                    <input type="hidden" name="status" value="CANCELLED" />
                    <button type="submit" className="warning small">Cancel</button>
                  </form>
                )}
                <form action={deleteActionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="actionId" value={action.id} />
                  <button type="submit" className="danger small">Delete</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="ws-section">
        <details open={resolvedSearch.open === "new"}>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ Create action</span>
          </summary>
          <form action={createActionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Notes
              <textarea name="bodyMd" />
            </label>
            <label>
              Link to Proposal
              <select name="proposalId" defaultValue="">
                <option value="">None</option>
                {activeProposals.map((p) => (
                  <option value={p.id} key={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
              <input type="checkbox" name="isPrivate" defaultChecked />
              <span>Private list (only visible to me)</span>
            </label>
            <button type="submit">Create action</button>
          </form>
        </details>
      </section>
    </>
  );
}
