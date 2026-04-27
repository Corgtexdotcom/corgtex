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
import { getTranslations } from "next-intl/server";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

export default async function CyclesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "CYCLES");
  const actor = await requirePageActor();
  const t = await getTranslations("cycles");
  const currentUserId = actor.kind === "user" ? actor.user.id : "";
  const [cyclesResult, members] = await Promise.all([
    listCycles(workspaceId, { take: 20 }),
    listMembers(workspaceId),
  ]);
  const cycles = cyclesResult.items;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        <div>
          {cycles.length === 0 && <p className="muted">{t("noActiveCycles")}</p>}
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
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>{t("pointsPerMember", { points: cycle.pointsPerUser })}</div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "32px", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 300px" }}>
                  <h3 className="nr-section-header" style={{ fontSize: "0.95rem", paddingBottom: 4, marginBottom: 12, color: "var(--muted)", borderTop: "1px solid var(--line)" }}>{t("sectionUpdates")}</h3>
                  {cycle.updates.length === 0 && <p className="nr-item-meta">{t("noUpdates")}</p>}
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
                      <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>{t("btnSubmitUpdate")}</summary>
                      <form action={upsertCycleUpdateAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="cycleId" value={cycle.id} />
                        <label>
                          {t("formYourUpdate")}
                          <textarea name="updateMd" required />
                        </label>
                        <div className="actions-inline">
                          <input name="cashPaidCents" type="number" min={0} placeholder={t("formCashPaid")} />
                          <input name="cashPaidCurrency" placeholder={t("formCashCurrency")} defaultValue="USD" />
                        </div>
                        <div className="actions-inline">
                          <input name="valueEstimateCents" type="number" min={0} placeholder={t("formValueEstimate")} />
                          <input name="valueEstimateCurrency" placeholder={t("formValueCurrency")} defaultValue="USD" />
                          <input name="valueConfidence" placeholder={t("formConfidence")} />
                        </div>
                        <button type="submit" className="secondary">{t("btnSaveUpdate")}</button>
                      </form>
                    </details>
                  )}
                </div>

                <div style={{ flex: "1 1 300px" }}>
                  <h3 className="nr-section-header" style={{ fontSize: "0.95rem", paddingBottom: 4, marginBottom: 12, color: "var(--muted)", borderTop: "1px solid var(--line)" }}>{t("sectionAllocations")}</h3>
                  {cycle.allocations.length === 0 && <p className="nr-item-meta">{t("noAllocations")}</p>}
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
                            <span className="tag" style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}>{t("points", { points: allocation.points })}</span>
                          </div>
                          {allocation.note && <div className="nr-item-meta" style={{ marginTop: 4 }}>{allocation.note}</div>}
                          
                          {cycle.status === "OPEN_ALLOCATIONS" && (
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)" }}>{t("btnEdit")}</summary>
                              <form action={updateAllocationAction} className="actions-inline" style={{ marginTop: 8 }}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="cycleId" value={cycle.id} />
                                <input type="hidden" name="allocationId" value={allocation.id} />
                                <input name="points" type="number" min={1} defaultValue={allocation.points} style={{ width: 90 }} />
                                <input name="note" defaultValue={allocation.note ?? ""} />
                                <button type="submit" className="secondary small">{t("btnSave")}</button>
                              </form>
                              <form action={deleteAllocationAction} style={{ marginTop: 8 }}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="cycleId" value={cycle.id} />
                                <input type="hidden" name="allocationId" value={allocation.id} />
                                <button type="submit" className="danger small">{t("btnDeleteAllocation")}</button>
                              </form>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {cycle.status === "OPEN_ALLOCATIONS" && (
                    <details style={{ marginTop: 16 }}>
                      <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>{t("btnNewAllocation")}</summary>
                      <form action={createAllocationAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="cycleId" value={cycle.id} />
                        <div className="actions-inline">
                          <label style={{ flex: 1 }}>
                            {t("formFrom")}
                            <select name="fromUserId" defaultValue={currentUserId}>
                              {members.map((m) => (
                                <option key={m.id} value={m.userId}>{m.user.displayName ?? m.user.email}</option>
                              ))}
                            </select>
                          </label>
                          <label style={{ flex: 1 }}>
                            {t("formTo")}
                            <select name="toUserId" required defaultValue={members[0]?.userId ?? ""}>
                              {members.map((m) => (
                                <option key={m.id} value={m.userId}>{m.user.displayName ?? m.user.email}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="actions-inline">
                          <input name="points" type="number" min={1} placeholder={t("formPoints")} required />
                          <input name="note" placeholder={t("formNote")} />
                        </div>
                        <button type="submit" className="secondary">{t("btnCreateAllocation")}</button>
                      </form>
                    </details>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 24, borderTop: "1px dashed var(--line)", paddingTop: 16 }}>
                <form action={updateCycleAction} className="actions-inline">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="cycleId" value={cycle.id} />
                  <span className="nr-meta">{t("updatePhase")}</span>
                  <select name="status" defaultValue={cycle.status} style={{ width: "auto" }}>
                    <option value="PLANNED">{t("phasePlanned")}</option>
                    <option value="OPEN_UPDATES">{t("phaseOpenUpdates")}</option>
                    <option value="OPEN_ALLOCATIONS">{t("phaseOpenAllocations")}</option>
                    <option value="REVIEW">{t("phaseReview")}</option>
                    <option value="FINALIZED">{t("phaseFinalized")}</option>
                  </select>
                  <button type="submit" className="secondary small">{t("btnUpdateStatus")}</button>
                </form>
              </div>

            </div>
          ))}
        </div>
      </section>

      <section className="ws-section" style={{ marginTop: 32 }}>
        <details>
          <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
            <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newCycleTitle")}</span>
          </summary>
          <form action={createCycleAction} className="stack nr-form-section">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <label>
              {t("formName")}
              <input name="name" required />
            </label>
            <label>
              {t("formCadence")}
              <input name="cadence" defaultValue="monthly" required />
            </label>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>
                {t("formStartDate")}
                <input name="startDate" type="date" required />
              </label>
              <label style={{ flex: 1 }}>
                {t("formEndDate")}
                <input name="endDate" type="date" required />
              </label>
            </div>
            <label>
              {t("formPointsPerMember")}
              <input name="pointsPerUser" type="number" min={1} defaultValue={100} required />
            </label>
            <button type="submit">{t("btnCreateCycle")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
