import { listCycles, listMembers } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createCycleAction,
  updateCycleAction,
  upsertCycleUpdateAction,
  createAllocationAction,
  updateAllocationAction,
  deleteAllocationAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function CyclesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const currentUserId = actor.kind === "user" ? actor.user.id : "";
  const [cyclesResult, members] = await Promise.all([
    listCycles(workspaceId, { take: 20 }),
    listMembers(workspaceId),
  ]);
  const cycles = cyclesResult.items;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Cycles</h1>
        <div className="nr-masthead-meta">
          <span>Contribution cycles, member updates, and peer allocations.</span>
        </div>
      </header>

      <section className="ws-section">
        <div>
          {cycles.length === 0 && <p className="muted">No cycles active or planned yet.</p>}
          {cycles.map((cycle) => (
            <div key={cycle.id} style={{ marginBottom: 64 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "2px solid var(--text)", paddingTop: 12, marginBottom: 16 }}>
                <div>
                  <h2 className="nr-section-header" style={{ borderTop: "none", padding: 0, margin: 0 }}>{cycle.name}</h2>
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>
                    {new Date(cycle.startDate).toLocaleDateString()} - {new Date(cycle.endDate).toLocaleDateString()}
                    {" · "} {cycle.cadence}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className={`tag ${cycle.status === "PLANNED" ? "info" : cycle.status === "FINALIZED" ? "success" : "warning"}`} style={{ fontSize: "1rem" }}>{cycle.status}</span>
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>{cycle.pointsPerUser} points/member</div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "32px", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 300px" }}>
                  <h3 className="nr-section-header" style={{ fontSize: "0.95rem", paddingBottom: 4, marginBottom: 12, color: "var(--muted)", borderTop: "1px solid var(--line)" }}>Updates</h3>
                  {cycle.updates.length === 0 && <p className="nr-item-meta">No member updates submitted yet.</p>}
                  {cycle.updates.length > 0 && (
                    <div>
                      {cycle.updates.map((update) => (
                        <div className="nr-item" key={update.id} style={{ padding: "8px 0" }}>
                          <strong className="nr-item-title">{update.user.displayName ?? update.user.email}</strong>
                          <div className="nr-excerpt" style={{ fontSize: "0.9rem", marginTop: 4 }}>{update.updateMd}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {cycle.status === "OPEN_UPDATES" && (
                    <details style={{ marginTop: 16 }}>
                      <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>+ Submit Your Update</summary>
                      <form action={upsertCycleUpdateAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="cycleId" value={cycle.id} />
                        <label>
                          Your update
                          <textarea name="updateMd" required />
                        </label>
                        <div className="actions-inline">
                          <input name="cashPaidCents" type="number" min={0} placeholder="Cash paid (cents)" />
                          <input name="cashPaidCurrency" placeholder="Cash currency" defaultValue="USD" />
                        </div>
                        <div className="actions-inline">
                          <input name="valueEstimateCents" type="number" min={0} placeholder="Value estimate (cents)" />
                          <input name="valueEstimateCurrency" placeholder="Value currency" defaultValue="USD" />
                          <input name="valueConfidence" placeholder="Confidence" />
                        </div>
                        <button type="submit" className="secondary">Save update</button>
                      </form>
                    </details>
                  )}
                </div>

                <div style={{ flex: "1 1 300px" }}>
                  <h3 className="nr-section-header" style={{ fontSize: "0.95rem", paddingBottom: 4, marginBottom: 12, color: "var(--muted)", borderTop: "1px solid var(--line)" }}>Allocations</h3>
                  {cycle.allocations.length === 0 && <p className="nr-item-meta">No allocations made yet.</p>}
                  {cycle.allocations.length > 0 && (
                    <div>
                      {cycle.allocations.map((allocation) => (
                        <div className="nr-item" key={allocation.id} style={{ padding: "8px 0" }}>
                          <div className="row">
                            <strong className="nr-item-title">
                              {allocation.fromUser.displayName ?? allocation.fromUser.email}
                              {" -> "}
                              {allocation.toUser.displayName ?? allocation.toUser.email}
                            </strong>
                            <span className="tag" style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}>{allocation.points} pts</span>
                          </div>
                          {allocation.note && <div className="nr-item-meta" style={{ marginTop: 4 }}>{allocation.note}</div>}
                          
                          {cycle.status === "OPEN_ALLOCATIONS" && (
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)" }}>Edit</summary>
                              <form action={updateAllocationAction} className="actions-inline" style={{ marginTop: 8 }}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="cycleId" value={cycle.id} />
                                <input type="hidden" name="allocationId" value={allocation.id} />
                                <input name="points" type="number" min={1} defaultValue={allocation.points} style={{ width: 90 }} />
                                <input name="note" defaultValue={allocation.note ?? ""} />
                                <button type="submit" className="secondary small">Save</button>
                              </form>
                              <form action={deleteAllocationAction} style={{ marginTop: 8 }}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="cycleId" value={cycle.id} />
                                <input type="hidden" name="allocationId" value={allocation.id} />
                                <button type="submit" className="danger small">Delete Allocation</button>
                              </form>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {cycle.status === "OPEN_ALLOCATIONS" && (
                    <details style={{ marginTop: 16 }}>
                      <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>+ New Allocation</summary>
                      <form action={createAllocationAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="cycleId" value={cycle.id} />
                        <div className="actions-inline">
                          <label style={{ flex: 1 }}>
                            From
                            <select name="fromUserId" defaultValue={currentUserId}>
                              {members.map((m) => (
                                <option key={m.id} value={m.userId}>{m.user.displayName ?? m.user.email}</option>
                              ))}
                            </select>
                          </label>
                          <label style={{ flex: 1 }}>
                            To
                            <select name="toUserId" required defaultValue={members[0]?.userId ?? ""}>
                              {members.map((m) => (
                                <option key={m.id} value={m.userId}>{m.user.displayName ?? m.user.email}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="actions-inline">
                          <input name="points" type="number" min={1} placeholder="Points" required />
                          <input name="note" placeholder="Note" />
                        </div>
                        <button type="submit" className="secondary">Create allocation</button>
                      </form>
                    </details>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 24, borderTop: "1px dashed var(--line)", paddingTop: 16 }}>
                <form action={updateCycleAction} className="actions-inline">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="cycleId" value={cycle.id} />
                  <span className="nr-meta">Update phase:</span>
                  <select name="status" defaultValue={cycle.status} style={{ width: "auto" }}>
                    <option value="PLANNED">Planned</option>
                    <option value="OPEN_UPDATES">Open updates</option>
                    <option value="OPEN_ALLOCATIONS">Open allocations</option>
                    <option value="REVIEW">Review</option>
                    <option value="FINALIZED">Finalized</option>
                  </select>
                  <button type="submit" className="secondary small">Update status</button>
                </form>
              </div>

            </div>
          ))}
        </div>
      </section>

      <section className="ws-section" style={{ marginTop: 32 }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ Create Cycle</span>
          </summary>
          <form action={createCycleAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Cadence
              <input name="cadence" defaultValue="monthly" required />
            </label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>
                Start date
                <input name="startDate" type="date" required />
              </label>
              <label style={{ flex: 1 }}>
                End date
                <input name="endDate" type="date" required />
              </label>
            </div>
            <label>
              Points per member
              <input name="pointsPerUser" type="number" min={1} defaultValue={100} required />
            </label>
            <button type="submit">Create cycle</button>
          </form>
        </details>
      </section>
    </>
  );
}
