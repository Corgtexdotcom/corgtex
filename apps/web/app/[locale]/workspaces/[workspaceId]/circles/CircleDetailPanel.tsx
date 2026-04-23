"use client";

export default function CircleDetailPanel({
  open,
  circleId,
  treeData,
  onClose,
  isDemo
}: {
  open: boolean;
  circleId: string | null;
  treeData: any[];
  onClose: () => void;
  isDemo: boolean;
}) {
  function findCircle(id: string | null, nodes: any[]): any {
    if (!id) return null;
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = findCircle(id, node.childCircles);
      if (found) return found;
    }
    return null;
  }

  const circle = findCircle(circleId, treeData);

  return (
    <>
      <div className={`slide-over-overlay ${open ? "open" : ""}`} onClick={onClose} />
      <div className={`slide-over-panel ${open ? "open" : ""}`}>
        <div className="slide-over-header">
          <h2 className="slide-over-title">{circle?.name || "Circle Details"}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "1.2rem", color: "var(--muted)" }}>×</button>
        </div>
        
        <div className="slide-over-content">
          {circle ? (
            <div className="stack">
              <div>
                <strong style={{ display: "block", marginBottom: 4 }}>Purpose</strong>
                <p className="nr-excerpt" style={{ margin: 0 }}>{circle.purposeMd || "No purpose defined."}</p>
              </div>
              
              {circle.domainMd && (
                <div>
                  <strong style={{ display: "block", marginBottom: 4 }}>Domain</strong>
                  <p className="nr-item-meta" style={{ margin: 0 }}>{circle.domainMd}</p>
                </div>
              )}

              <div>
                <strong style={{ display: "block", marginBottom: 4 }}>Maturity Stage</strong>
                <div style={{ padding: "8px 12px", background: "var(--bg-alt)", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", display: "inline-block" }}>
                  {circle.maturityStage}
                </div>
              </div>

              <div>
                <strong style={{ display: "block", marginBottom: 16 }}>Roles ({circle.roles?.length || 0})</strong>
                {!circle.roles?.length && <p className="nr-item-meta">No roles in this circle yet.</p>}
                
                <div className="stack" style={{ gap: 12 }}>
                  {circle.roles?.map((role: any) => (
                    <div key={role.id} style={{ padding: 12, border: "1px solid var(--line)", borderRadius: "var(--radius-sm)" }}>
                      <strong style={{ display: "block" }}>{role.name}</strong>
                      {role.purposeMd && <div className="nr-excerpt" style={{ fontSize: "0.8rem", marginTop: 4 }}>{role.purposeMd}</div>}
                      
                      <div style={{ marginTop: 12 }}>
                        <strong style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Assigned to:</strong>
                        {role.assignments?.length > 0 ? (
                          <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {role.assignments.map((a: any) => (
                              <span key={a.id} style={{ display: "inline-flex", background: "var(--bg)", padding: "2px 8px", borderRadius: "12px", fontSize: "0.75rem", border: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                                {a.member?.user?.displayName || a.member?.user?.email || "Unknown"}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="nr-item-meta" style={{ marginTop: 4 }}>Unassigned</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {!isDemo && (
                <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                   <p className="muted" style={{ fontSize: "0.85rem" }}>To edit roles or settings, switch to the List view.</p>
                </div>
              )}
            </div>
          ) : (
            <p className="muted">Select a circle to view its details.</p>
          )}
        </div>
      </div>
    </>
  );
}
