import { listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import Link from "next/link";
import {
  createProposalAction,
  submitProposalAction,
  postReactionAction,
  archiveProposalAction,
  publishProposalAction,
  initiateAdviceProcessAction,
  recordAdviceAction,
  withdrawAdviceProcessAction,
  executeAdviceProcessDecisionAction
} from "../actions";
import { prisma } from "@corgtex/shared";

export const dynamic = "force-dynamic";

export default async function ProposalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "ACTIVE";
  const circleFilter = typeof resolvedSearch.circleId === "string" ? resolvedSearch.circleId : null;

  const [{ items: proposals }, currentWorkspace, circles] = await Promise.all([
    listProposals(actor, workspaceId, { take: 50, circleId: circleFilter }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    prisma.circle.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";

  const groupedProposals = {
    PRIVATE: proposals.filter((p) => p.isPrivate),
    ACTIVE: proposals.filter((p) => (p.status === "DRAFT" || p.status === "SUBMITTED" || p.status === "ADVICE_GATHERING") && !p.isPrivate),
    DRAFT: proposals.filter((p) => p.status === "DRAFT" && !p.isPrivate),
    SUBMITTED: proposals.filter((p) => p.status === "SUBMITTED" && !p.isPrivate),
    ADVICE_GATHERING: proposals.filter((p) => p.status === "ADVICE_GATHERING" && !p.isPrivate),
    RESOLVED: proposals.filter((p) => (p.status === "APPROVED" || p.status === "REJECTED") && !p.isPrivate),
    ARCHIVED: proposals.filter((p) => p.status === "ARCHIVED" && !p.isPrivate),
  };

  const displayProposals = groupedProposals[statusFilter as keyof typeof groupedProposals] || groupedProposals.ACTIVE;

  const getReactionCount = (proposal: any, type: string) => 
    proposal.reactions.filter((r: any) => r.reaction === type).length;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Proposals</h1>
        <div className="nr-masthead-meta">
          <span>Governance proposals for policy changes, new processes, and decisions.</span>
        </div>
      </header>

      <section className="ws-section">
        <div style={{ marginBottom: 16 }}>
          <form method="get" style={{ display: "inline-block" }}>
            {statusFilter !== "ACTIVE" && <input type="hidden" name="status" value={statusFilter} />}
            <select name="circleId" defaultValue={circleFilter || ""} style={{ padding: "4px 8px", borderRadius: 4, marginRight: 8 }}>
              <option value="">All Circles</option>
              {circles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button type="submit" className="small secondary">Filter</button>
          </form>
        </div>
        <div className="nr-filter-bar">
          {(["PRIVATE", "ACTIVE", "DRAFT", "SUBMITTED", "ADVICE_GATHERING", "RESOLVED", "ARCHIVED"] as const).map((s) => (
            <a 
              key={s} 
              href={`?status=${s}`} 
              className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
            >
              {s === "ADVICE_GATHERING" ? "Advice Process" : s.charAt(0) + s.slice(1).toLowerCase()} ({groupedProposals[s].length})
            </a>
          ))}
        </div>

        <div>
          {(!displayProposals || displayProposals.length === 0) && (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>What is a Proposal?</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                Proposals are how decisions get made. Draft a proposal, gather advice from stakeholders, and let the team decide by consent.
              </p>
            </div>
          )}
          {displayProposals.map((proposal) => (
            <Link 
              key={proposal.id} 
              href={`/workspaces/${workspaceId}/proposals/${proposal.id}`}
              className="nr-item" 
              style={{ display: "block", textDecoration: "none", color: "inherit", cursor: "pointer", transition: "background 0.2s" }}
            >
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {proposal.isPrivate && <span title="Private draft" style={{ marginRight: 6 }}>🔒</span>}
                  {proposal.title}
                </strong>
                <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "SUBMITTED" ? "warning" : proposal.status === "ADVICE_GATHERING" ? "info" : proposal.status === "APPROVED" ? "success" : proposal.status === "REJECTED" ? "danger" : ""}`}>
                  {proposal.status === "ADVICE_GATHERING" ? "GATHERING ADVICE" : proposal.status}
                </span>
              </div>
              <div className="nr-excerpt" style={{ marginTop: 6, color: "var(--muted)" }}>
                {proposal.summary ?? proposal.bodyMd.replace(/\0/g, "").slice(0, 150) + "..."}
              </div>
              
              <div className="nr-item-meta" style={{ marginTop: 12 }}>
                 <span>{proposal.author.displayName || proposal.author.email}</span>
                 <span style={{ margin: "0 8px" }}>·</span>
                 <span>{new Date(proposal.createdAt).toLocaleDateString()}</span>
                 <span style={{ margin: "0 8px" }}>·</span>
                 <span>{proposal.reactions.length} entries</span>
              </div>

              {(proposal.tensions?.length > 0 || proposal.actions?.length > 0) && (
                <div style={{ marginTop: 8, fontSize: "0.82rem", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {proposal.tensions?.map((t: any) => (
                    <span key={t.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                      Tension: {t.title}
                    </span>
                  ))}
                  {proposal.actions?.map((a: any) => (
                    <span key={a.id} className="tag info" style={{ padding: "2px 6px", fontSize: "0.75rem" }}>
                      Action: {a.title}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      </section>

      {!isDemo && (
        <section className="ws-section">
          <details open={resolvedSearch.open === "new"}>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ Draft a proposal</span>
            </summary>
            <form action={createProposalAction} className="stack nr-form-section">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                Title
                <input name="title" required />
              </label>
              <label>
                Summary
                <input name="summary" />
              </label>
              <label>
                Body
                <MarkdownEditor name="bodyMd" required placeholder="Write proposal content in markdown..." />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
                <input type="checkbox" name="isPrivate" defaultChecked />
                <span>Private draft (only visible to me)</span>
              </label>
              <button type="submit">Create draft proposal</button>
            </form>
          </details>
        </section>
      )}
    </>
  );
}
