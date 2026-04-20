import { listProposals } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import {
  createProposalAction,
  submitProposalAction,
  reactToProposalAction,
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
  const [{ items: proposals }, currentWorkspace] = await Promise.all([
    listProposals(actor, workspaceId, { take: 50 }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";

  const resolvedSearch = searchParams ? await searchParams : {};
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "ACTIVE";

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
            <div className="nr-item" key={proposal.id}>
              <div className="row" style={{ alignItems: "center" }}>
                <strong className="nr-item-title">
                  {proposal.isPrivate && <span title="Private draft" style={{ marginRight: 6 }}>🔒</span>}
                  {proposal.title}
                </strong>
                <span className={`tag ${proposal.status === "DRAFT" ? "info" : proposal.status === "SUBMITTED" ? "warning" : proposal.status === "ADVICE_GATHERING" ? "info" : proposal.status === "APPROVED" ? "success" : proposal.status === "REJECTED" ? "danger" : ""}`}>
                  {proposal.status === "ADVICE_GATHERING" ? "GATHERING ADVICE" : proposal.status}
                </span>
              </div>
              <div className="nr-excerpt">{proposal.summary ?? proposal.bodyMd.slice(0, 150) + "..."}</div>
              
              <div className="nr-item-meta" style={{ marginTop: 8 }}>
                 {proposal.author.displayName || proposal.author.email} · {new Date(proposal.createdAt).toLocaleDateString()}
                 {" · "} Support: {getReactionCount(proposal, "SUPPORT")} {" · "} Questions: {getReactionCount(proposal, "QUESTION")} {" · "} Concerns: {getReactionCount(proposal, "CONCERN")}
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

              <div className="actions-inline" style={{ marginTop: 12 }}>
                {!isDemo && proposal.isPrivate && (
                  <form action={publishProposalAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <button type="submit" className="primary small">Publish Draft</button>
                  </form>
                )}
                {!isDemo && proposal.status === "DRAFT" && (
                  <>
                    <form action={submitProposalAction} style={{ display: "inline-block" }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button type="submit" className="secondary small">Submit for approval</button>
                    </form>
                    <form action={initiateAdviceProcessAction} style={{ display: "inline-block" }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="proposalId" value={proposal.id} />
                      <button type="submit" className="primary small">Start Advice Process</button>
                    </form>
                  </>
                )}
                {!isDemo && !proposal.isPrivate && proposal.status === "SUBMITTED" && (
                <form action={reactToProposalAction} className="actions-inline">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  <button type="submit" name="reaction" value="SUPPORT" className="secondary small">Support</button>
                  <button type="submit" name="reaction" value="QUESTION" className="secondary small">Question</button>
                  <button type="submit" name="reaction" value="CONCERN" className="warning small">Concern</button>
                </form>
                )}
                {!proposal.isPrivate && proposal.status === "ADVICE_GATHERING" && proposal.adviceProcess && (
                  <div style={{ padding: "16px", background: "rgba(255, 0, 128, 0.05)", borderLeft: "3px solid var(--accent)", marginTop: 12, borderRadius: 4, width: "100%" }}>
                    <h4 style={{ margin: "0 0 8px 0" }}>Advice Process Active</h4>
                    {proposal.adviceProcess.advisorySuggestionsJson && typeof proposal.adviceProcess.advisorySuggestionsJson === "object" && Array.isArray((proposal.adviceProcess.advisorySuggestionsJson as any).advisors) && (proposal.adviceProcess.advisorySuggestionsJson as any).advisors.length > 0 && (
                      <div className="muted" style={{ marginBottom: 12, fontSize: "0.85rem" }}>
                        <strong>AI Recommended Advisors:</strong>{" "}
                        {(proposal.adviceProcess.advisorySuggestionsJson as any).advisors.map((a: any) => (
                          <span key={a.memberId} title={a.reason} style={{ textDecoration: "underline dotted", cursor: "help", marginRight: 8 }}>{a.name}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: "16px", flexDirection: "column" }}>
                      {proposal.adviceProcess.records.map((r: any) => (
                        <div key={r.id} style={{ fontSize: "0.9rem" }}>
                          <strong>{r.member.user.displayName || r.member.user.email}</strong> 
                          <span className={`tag ${r.type === "ENDORSE" ? "success" : "warning"}`} style={{ marginLeft: 8, fontSize: "0.7rem" }}>
                            {r.type}
                          </span>
                          <div style={{ marginTop: 4 }}>{r.bodyMd}</div>
                        </div>
                      ))}
                    </div>
                    
                    {!isDemo && (
                      <form action={recordAdviceAction} className="stack" style={{ marginTop: 16 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="processId" value={proposal.adviceProcess.id} />
                        <textarea name="bodyMd" required placeholder="Leave your advice here..." style={{ minHeight: "60px" }}></textarea>
                        <div className="actions-inline">
                          <button type="submit" name="type" value="ENDORSE" className="primary small">Endorse</button>
                          <button type="submit" name="type" value="CONCERN" className="warning small">Raise Concern</button>
                        </div>
                      </form>
                    )}

                    {actor.kind === "user" && proposal.authorUserId === actor.user.id && !isDemo && (
                      <div className="actions-inline" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-color)" }}>
                        <form action={executeAdviceProcessDecisionAction} className="actions-inline">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="processId" value={proposal.adviceProcess.id} />
                          <button type="submit" className="primary small">Execute Decision</button>
                        </form>
                        <form action={withdrawAdviceProcessAction} className="actions-inline">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="processId" value={proposal.adviceProcess.id} />
                          <button type="submit" className="danger small">Withdraw</button>
                        </form>
                      </div>
                    )}
                  </div>
                )}
                {!isDemo && (proposal.status === "DRAFT" || proposal.status === "APPROVED" || proposal.status === "REJECTED") && (
                  <form action={archiveProposalAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <button type="submit" className="warning small">Archive</button>
                  </form>
                )}
              </div>
            </div>
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
