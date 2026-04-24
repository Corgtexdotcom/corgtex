import { listTensions, listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createTensionAction,
  updateTensionAction,
  upvoteTensionAction,
  deleteTensionAction,
  publishTensionAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function TensionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const [{ items: tensions }, { items: proposals }] = await Promise.all([
    listTensions(actor, workspaceId, { take: 50 }),
    listProposals(actor, workspaceId, { take: 50 }),
  ]);

  const activeProposals = proposals.filter(p => p.status === "DRAFT" || p.status === "SUBMITTED");

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "OPEN";

  const groupedTensions = {
    MY_INBOX: tensions.filter((t) => t.isPrivate),
    OPEN: tensions.filter((t) => t.status === "OPEN" && !t.isPrivate),
    IN_PROGRESS: tensions.filter((t) => t.status === "IN_PROGRESS" && !t.isPrivate),
    COMPLETED: tensions.filter((t) => t.status === "COMPLETED" && !t.isPrivate),
    ALL: tensions,
  };

  const displayTensions = statusFilter === "ALL" 
    ? groupedTensions.ALL 
    : groupedTensions[statusFilter as keyof typeof groupedTensions] || groupedTensions.OPEN;

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    return days === 0 ? "today" : `${days}d ago`;
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Tensions</h1>
        <div className="nr-masthead-meta">
          <span>Issues, gaps, and opportunities sensed across the workspace.</span>
        </div>
      </header>

      <section className="ws-section">
        <div className="nr-filter-bar">
          {(["MY_INBOX", "OPEN", "IN_PROGRESS", "COMPLETED", "ALL"] as const).map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {s.replace("_", " ")} ({groupedTensions[s].length})
            </a>
          ))}
        </div>

        <div>
          {(!displayTensions || displayTensions.length === 0) && (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>What is a Tension?</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                A tension is any gap between what is and what could be. It&apos;s the most important signal in a self-managed organization. File a tension whenever you sense an opportunity for improvement.
              </p>
            </div>
          )}
          {displayTensions.map((tension) => (
            <div className="nr-item" key={tension.id}>
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {tension.isPrivate && <span title="Private inbox item" style={{ marginRight: 6 }}>🔒</span>}
                  <a href={`/workspaces/${workspaceId}/tensions/${tension.id}`} style={{ color: "inherit" }}>
                    {tension.title}
                  </a>
                </strong>
                <span className={`tag ${tension.status === "OPEN" ? "warning" : tension.status === "IN_PROGRESS" ? "info" : "success"}`}>{tension.status}</span>
              </div>
              {tension.bodyMd && <div className="nr-excerpt">{tension.bodyMd}</div>}
              
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                {tension.author.displayName || tension.author.email} · {ageText(tension.createdAt)}
                {" · "} {tension.upvotes.length} upvotes {" · "} Priority {tension.priority}
                {tension.proposal && ` · Linked to Proposal: ${tension.proposal.title}`}
              </div>

              <div className="actions-inline" style={{ marginTop: 12 }}>
                {tension.isPrivate && (
                  <form action={publishTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <button type="submit" className="primary small">Publish to Workspace</button>
                  </form>
                )}
                {!tension.isPrivate && tension.status === "OPEN" && (
                  <form action={updateTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <input type="hidden" name="status" value="IN_PROGRESS" />
                    <button type="submit" className="secondary small">Start</button>
                  </form>
                )}
                {!tension.isPrivate && (tension.status === "OPEN" || tension.status === "IN_PROGRESS") && (
                  <form action={updateTensionAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="tensionId" value={tension.id} />
                    <input type="hidden" name="status" value="COMPLETED" />
                    <button type="submit" className="secondary small">Resolve</button>
                  </form>
                )}
                {!tension.isPrivate && (
                <form action={upvoteTensionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="tensionId" value={tension.id} />
                  <button type="submit" className="secondary small">Upvote</button>
                </form>
                )}
                <form action={deleteTensionAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="tensionId" value={tension.id} />
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
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ New tension</span>
          </summary>
          <form action={createTensionAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Description
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
              <span>Private inbox (only visible to me)</span>
            </label>
            <button type="submit">Create tension</button>
          </form>
        </details>
      </section>
    </>
  );
}
