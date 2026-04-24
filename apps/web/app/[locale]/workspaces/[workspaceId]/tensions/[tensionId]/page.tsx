import { getTension, listDeliberationEntries } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { postTensionDeliberationAction, resolveTensionDeliberationAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function TensionDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; tensionId: string }>;
}) {
  const { workspaceId, tensionId } = await params;
  const actor = await requirePageActor();
  const tension = await getTension(actor, { workspaceId, tensionId });
  const entries = await listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId });
  const mappedEntries = entries.map((e: any) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || "Unknown",
    authorInitials: (e.author?.displayName || e.author?.email || "?").substring(0, 2).toUpperCase()
  }));

  const priorityText = tension.priority > 0 ? `P${tension.priority}` : "No Priority";

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <a href={`/workspaces/${workspaceId}/tensions`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            ← Back to Tensions
          </a>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {tension.isPrivate && <span title="Private inbox item" style={{ marginRight: 6 }}>◆</span>}
          {tension.title}
        </h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${tension.status === "OPEN" ? "warning" : tension.status === "IN_PROGRESS" ? "info" : "success"}`}>
            {tension.status}
          </span>
          <span> · {tension.author.displayName || tension.author.email}</span>
          <span> · {priorityText}</span>
          <span> · {new Date(tension.createdAt).toLocaleDateString()}</span>
        </div>
      </header>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">Description</h2>
        <div className="nr-item">
          {tension.bodyMd ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{tension.bodyMd}</div>
          ) : (
            <em className="muted">No description provided.</em>
          )}
        </div>
      </section>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">Discussion</h2>
        <DeliberationThread entries={mappedEntries} canResolve={true} resolveAction={resolveTensionDeliberationAction} hiddenFields={{ workspaceId, parentId: tensionId }} />
        <div style={{ marginTop: 24 }}>
          <DeliberationComposer
            postAction={postTensionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: tensionId }}
            entryTypes={[
              { value: "SUPPORT", label: "Support", variant: "success" },
              { value: "QUESTION", label: "Question", variant: "info" },
              { value: "CONCERN", label: "Concern", variant: "warning" },
              { value: "REACTION", label: "Reaction", variant: "secondary" }
            ]}
          />
        </div>
      </section>
    </>
  );
}
