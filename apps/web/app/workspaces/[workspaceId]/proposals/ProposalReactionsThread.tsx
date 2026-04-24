"use client";

import { useTransition } from "react";
import { postReactionAction, resolveReactionAction } from "../actions";

export function ProposalReactionsThread({ 
  workspaceId, 
  proposal, 
  currentUserId 
}: { 
  workspaceId: string; 
  proposal: any; 
  currentUserId: string | null; 
}) {
  const [isPending, startTransition] = useTransition();

  const handleSupport = () => {
    startTransition(() => {
      const formData = new FormData();
      formData.append("workspaceId", workspaceId);
      formData.append("proposalId", proposal.id);
      formData.append("reaction", "SUPPORT");
      postReactionAction(formData);
    });
  };

  const supportCount = proposal.reactions?.filter((r: any) => r.reaction === "SUPPORT").length || 0;
  const objections = proposal.reactions?.filter((r: any) => r.reaction === "OBJECTION") || [];
  const reactions = proposal.reactions?.filter((r: any) => r.reaction === "REACTION" || r.reaction === "QUESTION" || r.reaction === "CONCERN") || [];

  const unresolvedObjectionsCount = objections.filter((o: any) => !o.resolvedAt).length;

  return (
    <div style={{ marginTop: 16 }}>
      {objections.length > 0 && (
        <div style={{ padding: "16px", border: "2px solid var(--danger, red)", borderRadius: 4, marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 12px 0", color: "var(--danger, red)" }}>
            Objections {unresolvedObjectionsCount > 0 ? `(${unresolvedObjectionsCount} unresolved)` : "(All resolved)"}
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {objections.map((o: any) => (
              <div key={o.id} style={{ fontSize: "0.85rem" }}>
                <strong>⚠️ {o.user.displayName || o.user.email}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(o.createdAt).toLocaleString()}</span>
                <div style={{ marginTop: 4 }}>{o.bodyMd}</div>
                {o.resolvedAt ? (
                  <div style={{ marginTop: 8, padding: "8px", background: "var(--bg-alt, #f1f5f9)", borderRadius: 4 }}>
                    <strong>✅ Resolved: </strong> {o.resolvedNote}
                  </div>
                ) : (
                  currentUserId === proposal.authorUserId && (
                    <form action={resolveReactionAction} style={{ marginTop: 8, display: "flex", gap: "8px" }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="reactionId" value={o.id} />
                      <input type="text" name="resolvedNote" required placeholder="How was this addressed?" style={{ flex: 1, padding: "4px 8px" }} />
                      <button type="submit" className="primary small">Resolve</button>
                    </form>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {reactions.length > 0 && (
        <div style={{ padding: "16px", background: "var(--bg-alt, #f8fafc)", borderRadius: 4, marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 12px 0" }}>Reactions ({reactions.length})</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {reactions.map((r: any) => (
              <div key={r.id} style={{ fontSize: "0.85rem", borderBottom: "1px solid var(--line)", paddingBottom: "12px" }}>
                <strong>💬 {r.user.displayName || r.user.email}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(r.createdAt).toLocaleString()}</span>
                <div style={{ marginTop: 4 }}>{r.bodyMd}</div>
                {r.resolvedAt ? (
                  <div style={{ marginTop: 8, padding: "4px 8px", background: "rgba(0,0,0,0.05)", borderRadius: 4 }}>
                    <strong>✅ Resolved: </strong> {r.resolvedNote}
                  </div>
                ) : (
                  currentUserId === proposal.authorUserId && (
                    <form action={resolveReactionAction} style={{ marginTop: 8, display: "flex", gap: "8px" }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="reactionId" value={r.id} />
                      <input type="text" name="resolvedNote" required placeholder="Resolution note..." style={{ flex: 1, padding: "4px 8px" }} />
                      <button type="submit" className="secondary small">Resolve</button>
                    </form>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="actions-inline" style={{ marginTop: 12, alignItems: "flex-start" }}>
        <button onClick={handleSupport} disabled={isPending} className="secondary small">
          👍 Support {supportCount > 0 && `(${supportCount})`}
        </button>
        
        <form action={postReactionAction} style={{ display: "flex", gap: "8px", flex: 1 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <input type="hidden" name="reaction" value="REACTION" />
          <input type="text" name="bodyMd" required placeholder="Share a reaction, question, or suggestion..." style={{ flex: 1 }} />
          <button type="submit" className="secondary small">💬 React</button>
        </form>

        <form action={postReactionAction} style={{ display: "flex", gap: "8px" }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <input type="hidden" name="reaction" value="OBJECTION" />
          <input type="text" name="bodyMd" required placeholder="Reason for objection..." style={{ width: "200px" }} />
          <button type="submit" className="danger small">⚠️ Raise Objection</button>
        </form>
      </div>
    </div>
  );
}
