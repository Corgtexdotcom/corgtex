import { requirePageActor } from "@/lib/auth";
import { getProposal, listDeliberationEntries } from "@corgtex/domain";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { 
  postDeliberationEntryAction, 
  resolveDeliberationEntryAction,
  publishProposalAction,
  submitProposalAction,
  initiateAdviceProcessAction,
  recordAdviceAction,
  executeAdviceProcessDecisionAction,
  withdrawAdviceProcessAction,
  archiveProposalAction
} from "../actions";
import { prisma } from "@corgtex/shared";

export const dynamic = "force-dynamic";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; proposalId: string }>;
}) {
  const { workspaceId, proposalId } = await params;
  const actor = await requirePageActor();

  let proposal;
  try {
    proposal = await getProposal(actor, { workspaceId, proposalId });
  } catch (err: any) {
    if (err.code === "NOT_FOUND") return notFound();
    throw err;
  }

  const [currentWorkspace, entries] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    listDeliberationEntries(actor, { workspaceId, parentType: "PROPOSAL", parentId: proposalId })
  ]);
  
  const isDemo = currentWorkspace?.slug === "jnj-demo";

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
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <p className="nr-meta" style={{ marginBottom: "12px", display: "flex", gap: "12px" }}>
          <span><Link href={`/workspaces/${workspaceId}/proposals`} style={{ color: "inherit", textDecoration: "none" }}>← Back to Proposals</Link></span>
          <span>·</span>
          <span>{proposal.author.displayName || proposal.author.email || "Unknown"}</span>
          <span>·</span>
          <span className={`tag ${statusClass}`}>{proposal.status}</span>
        </p>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {proposal.title}
        </h1>
      </header>

      <section className="ws-section">
        <div className="nr-item" style={{ padding: "32px" }}>
          <div className="nr-prose" dangerouslySetInnerHTML={{ __html: proposal.bodyMd }} />
        </div>
      </section>

      <section className="ws-section" style={{ marginTop: "40px" }}>
        <div className="nr-item" style={{ padding: "32px" }}>
          <h2 style={{ marginTop: 0, marginBottom: "24px" }}>Deliberation</h2>
          <DeliberationThread 
            entries={entries} 
            canResolve={isAuthor} 
            resolveAction={resolveDeliberationEntryAction} 
          />

          {(proposal.status === "SUBMITTED" || proposal.status === "ADVICE_GATHERING") && (
            <DeliberationComposer 
              postAction={postDeliberationEntryAction}
              hiddenFields={{ workspaceId, proposalId }}
            />
          )}
        </div>
      </section>
    </>
  );
}
