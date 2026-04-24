import { notFound } from "next/navigation";
import Link from "next/link";
import { getProposal, listDeliberationEntries } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { renderMarkdown } from "@/lib/markdown";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { postDeliberationEntryAction, resolveDeliberationEntryAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; proposalId: string }>;
}) {
  const { workspaceId, proposalId } = await params;
  const actor = await requirePageActor();

  const proposal = await getProposal(actor, { workspaceId, proposalId });
  if (!proposal) notFound();

  const deliberationEntries = await listDeliberationEntries(actor, {
    workspaceId,
    parentType: "PROPOSAL",
    parentId: proposalId,
  });

  const htmlContent = renderMarkdown(proposal.bodyMd);

  const ageText = (date: Date) => {
    const days = Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  };

  const statusClass = (() => {
    if (proposal.status === "DRAFT") return "info";
    if (proposal.status === "SUBMITTED" || proposal.status === "ADVICE_GATHERING") return "warning";
    if (proposal.status === "APPROVED") return "success";
    if (proposal.status === "REJECTED") return "danger";
    return "";
  })();

  const isAuthor = proposal.authorUserId === (actor.kind === "user" ? actor.user.id : "");

  return (
    <>
      <div className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <p className="nr-meta" style={{ marginBottom: "12px", display: "flex", gap: "12px" }}>
          <span><Link href={`/workspaces/${workspaceId}/proposals`} style={{ color: "inherit", textDecoration: "none" }}>← Back to Proposals</Link></span>
          <span>·</span>
          <span>{proposal.author.displayName || proposal.author.email}</span>
          <span>·</span>
          <span className={`tag ${statusClass}`}>{proposal.status}</span>
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid var(--line)", paddingBottom: 16 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem", maxWidth: "800px" }}>{proposal.title}</h1>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Updated {ageText(proposal.updatedAt)}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "64px" }}>
        {/* Main Article Body */}
        <article style={{ fontSize: "1.1rem", lineHeight: 1.8, color: "var(--text)" }}>
          <div 
            className="nr-markdown" 
            dangerouslySetInnerHTML={{ __html: htmlContent }} 
            style={{ marginBottom: "48px" }}
          />

          <hr className="nr-divider" style={{ margin: "48px 0" }} />

          <h3 className="font-playfair font-semibold mb-6 text-[1.4rem]">Deliberation</h3>
          <DeliberationThread
            entries={deliberationEntries.map((e) => ({
              id: e.id,
              entryType: e.entryType,
              authorName: e.author?.displayName || "Unknown",
              authorInitials: (e.author?.displayName || "U").substring(0, 2).toUpperCase(),
              bodyMd: e.bodyMd,
              createdAt: e.createdAt,
              resolvedAt: e.resolvedAt,
              resolvedNote: e.resolvedNote,
            }))}
            canResolve={isAuthor || actor.kind === "agent"}
            resolveAction={resolveDeliberationEntryAction}
            hiddenFields={{ workspaceId, proposalId }}
          />

          {(proposal.status === "SUBMITTED" || proposal.status === "ADVICE_GATHERING") && (
            <DeliberationComposer
              postAction={postDeliberationEntryAction}
              hiddenFields={{ workspaceId, proposalId }}
              entryTypes={[
                { value: "SUPPORT", label: "Support", variant: "success" },
                { value: "QUESTION", label: "Question", variant: "info" },
                { value: "CONCERN", label: "Concern", variant: "warning" },
                { value: "OBJECTION", label: "Objection", variant: "danger" },
              ]}
            />
          )}
        </article>

        {/* Sidebar */}
        <aside style={{ borderLeft: "1px solid var(--line)", paddingLeft: "32px", paddingRight: "16px" }}>
          {isAuthor && proposal.status === "DRAFT" && (
            <div className="stack mb-8">
              <form action="../actions/submit" method="post" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="proposalId" value={proposal.id} />
                <button formAction="../actions/submit" className="w-full">Submit Proposal</button>
              </form>
            </div>
          )}
          
          <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text)", marginBottom: "16px" }}>About</h3>
          <div className="nr-meta mb-4">
            <strong>Created:</strong> {new Date(proposal.createdAt).toLocaleDateString()}
          </div>
          {proposal.summary && (
            <div className="nr-meta mb-4">
              <strong>Summary:</strong> {proposal.summary}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
