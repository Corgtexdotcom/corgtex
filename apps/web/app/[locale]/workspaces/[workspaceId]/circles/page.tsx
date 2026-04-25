import { listCircles, listCircleTree, listRoles, listRoleAssignments, listMembers } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createCircleAction,
  deleteCircleAction,
  createRoleAction,
  deleteRoleAction,
  assignRoleAction,
  unassignRoleAction,
} from "../actions";
import { prisma } from "@corgtex/shared";
import CircleGraph from "./CircleGraph";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function CirclesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { workspaceId } = await params;
  const { view } = await searchParams;
  const viewMode = view === "list" ? "list" : "graph";
  await requirePageActor();
  const t = await getTranslations("circles");

  let circles: Awaited<ReturnType<typeof listCircles>>;
  let treeData: Awaited<ReturnType<typeof listCircleTree>>;
  let roles: Awaited<ReturnType<typeof listRoles>>;
  let assignments: Awaited<ReturnType<typeof listRoleAssignments>>;
  let members: Awaited<ReturnType<typeof listMembers>>;
  let agentAssignments: any[] = [];
  let allAgents: any[] = [];
  let isDemo = false;

  try {
    const currentWorkspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } });
    isDemo = currentWorkspace?.slug === "jnj-demo";

    const [c, t, r, a, m] = await Promise.all([
      listCircles(workspaceId).catch(e => { console.error("[CirclesPage] listCircles failed:", e); throw e; }),
      listCircleTree(workspaceId).catch(e => { console.error("[CirclesPage] listCircleTree failed:", e); throw e; }),
      listRoles(workspaceId).catch(e => { console.error("[CirclesPage] listRoles failed:", e); throw e; }),
      listRoleAssignments(workspaceId).catch(e => { console.error("[CirclesPage] listRoleAssignments failed:", e); throw e; }),
      listMembers(workspaceId).catch(e => { console.error("[CirclesPage] listMembers failed:", e); throw e; }),
    ]);
    circles = c;
    treeData = t;
    roles = r;
    assignments = a;
    members = m;

    agentAssignments = await prisma.circleAgentAssignment.findMany({
      where: { circle: { workspaceId } },
      include: { agentIdentity: true },
    });
    
    allAgents = await prisma.agentIdentity.findMany({
      where: { workspaceId, isActive: true }
    });
  } catch (error) {
    console.error("[CirclesPage] Failed to load circles data detailed:", error);
    return (
      <>
        <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        </header>
        <section className="ws-section">
          <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
            <h3 style={{ margin: "0 0 8px" }}>{t("errorLoadTitle")}</h3>
            <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
              {t("errorLoadDesc")}
            </p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
            <div className="nr-masthead-meta">
              <span>{t("pageDescription")}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <a href={`/workspaces/${workspaceId}/circles?view=graph`} className="secondary small" style={{ opacity: viewMode === "graph" ? 1 : 0.6, background: viewMode === "graph" ? "var(--bg-alt)" : "transparent" }}>{t("btnGraphView")}</a>
            <a href={`/workspaces/${workspaceId}/circles?view=list`} className="secondary small" style={{ opacity: viewMode === "list" ? 1 : 0.6, background: viewMode === "list" ? "var(--bg-alt)" : "transparent" }}>{t("btnListView")}</a>
          </div>
        </div>
      </header>

      {viewMode === "graph" ? (
        <section className="ws-section" style={{ padding: "0 24px" }}>
          {(!treeData || treeData.length === 0) ? (
            <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
              <h3 style={{ margin: "0 0 8px" }}>{t("whatIsCircleTitle")}</h3>
              <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
                {t("whatIsCircleDescGraph")}
              </p>
            </div>
          ) : (
            <CircleGraph treeData={treeData} isDemo={isDemo} />
          )}
        </section>
      ) : (
      <section className="ws-section">
        {(!circles || circles.length === 0) && (
          <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
            <h3 style={{ margin: "0 0 8px" }}>{t("whatIsCircleTitle")}</h3>
            <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
              {t("whatIsCircleDescList")}
            </p>
          </div>
        )}
        <div>
          {circles.map((circle) => {
            const circleRoles = roles.filter(r => r.circle?.id === circle.id);
            return (
              <div key={circle.id} style={{ marginBottom: 48 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <h2 className="nr-section-header" style={{ flex: 1, borderTop: "2px solid var(--text)" }}>
                    {t("circleTitle", { name: circle.name })}
                  </h2>
                  {!isDemo && (
                    <form action={deleteCircleAction} style={{ marginLeft: 16 }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="circleId" value={circle.id} />
                      <button type="submit" className="danger small">{t("btnDeleteCircle")}</button>
                    </form>
                  )}
                </div>
                
                <div style={{ marginBottom: 24 }}>
                  {circle.purposeMd && <div className="nr-excerpt">{circle.purposeMd}</div>}
                  {circle.domainMd && <div className="nr-item-meta">{t("domain", { domain: circle.domainMd })}</div>}
                </div>

                <div>
                  {circleRoles.length === 0 && <div className="nr-item-meta">{t("noRoles")}</div>}
                  {circleRoles.map((role) => {
                    const roleAssignments = assignments.filter((a) => a.role?.id === role.id);
                    return (
                      <div className="nr-item" key={role.id}>
                        <div className="row">
                          <strong className="nr-item-title">{role.name}</strong>
                          {!isDemo && (
                            <div className="actions-inline">
                              <form action={deleteRoleAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="roleId" value={role.id} />
                                <button type="submit" className="danger small">{t("btnDelete")}</button>
                              </form>
                            </div>
                          )}
                        </div>
                        {role.purposeMd && <div className="nr-excerpt" style={{ marginTop: 4 }}>{role.purposeMd}</div>}
                        {role.accountabilities.length > 0 && (
                          <div className="nr-item-meta" style={{ marginTop: 4 }}>
                            {role.accountabilities.join(" · ")}
                          </div>
                        )}
                        
                        <div style={{ marginTop: 12, paddingTop: 8 }}>
                          {roleAssignments.length > 0 && (
                            <div style={{ marginBottom: 6 }}>
                              {roleAssignments.map((a) => (
                                <div key={a.id} className="row" style={{ fontSize: "0.85rem", padding: "4px 0" }}>
                                  <span>{t("memberAssignment", { name: a.member?.user?.displayName ?? a.member?.user?.email ?? t("memberUnknown") })}</span>
                                  {!isDemo && (
                                    <form action={unassignRoleAction}>
                                      <input type="hidden" name="workspaceId" value={workspaceId} />
                                      <input type="hidden" name="roleId" value={role.id} />
                                      <input type="hidden" name="memberId" value={a.member?.id} />
                                      <button type="submit" className="danger small">{t("btnUnassign")}</button>
                                    </form>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {!isDemo && (
                            <form action={assignRoleAction} className="actions-inline">
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="roleId" value={role.id} />
                              <select name="memberId" style={{ width: "auto", minWidth: 120 }}>
                                {members.map((m) => (
                                  <option key={m.id} value={m.id}>{m.user.displayName ?? m.user.email}</option>
                                ))}
                              </select>
                              <button type="submit" className="secondary small">{t("btnAssignMember")}</button>
                            </form>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="nr-section-header" style={{ marginTop: 24, padding: "8px 0" }}>
                  <h3 style={{ fontSize: "1.1rem", margin: 0 }}>{t("agentMembersTitle")}</h3>
                </div>
                <div>
                  {(() => {
                    const circleAgents = agentAssignments.filter((a: any) => a.circleId === circle.id);
                    if (circleAgents.length === 0) {
                      return <div className="nr-item-meta">{t("noAgentsAssigned")}</div>;
                    }
                    return circleAgents.map((a: any) => (
                      <div className="nr-item" key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span title={t("agentTooltip")}>⬡</span>
                          <span style={{ fontWeight: 600 }}>{a.agentIdentity.displayName}</span>
                          <span className="nr-item-meta" style={{ fontSize: "0.8rem", padding: "2px 6px", background: a.agentIdentity.memberType === "INTERNAL" ? "var(--accent-muted)" : "var(--bg-alt)", border: "1px solid var(--border)", borderRadius: 12 }}>
                            {a.agentIdentity.memberType}
                          </span>
                        </div>
                        {!isDemo && (
                          <form action={async () => {
                            "use server";
                            const { removeAgentFromCircle } = await import("@corgtex/domain");
                            const { requirePageActor } = await import("@/lib/auth");
                            const { revalidatePath } = await import("next/cache");
                            const actor = await requirePageActor();
                            await removeAgentFromCircle(actor, { workspaceId, agentIdentityId: a.agentIdentityId, circleId: circle.id });
                            revalidatePath(`/workspaces/${workspaceId}/circles`);
                          }}>
                            <button type="submit" className="danger small">{t("btnUnassign")}</button>
                          </form>
                        )}
                      </div>
                    ));
                  })()}
                </div>
                
                <div style={{ marginTop: 12, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
                  {!isDemo && (
                    <form action={async (formData: FormData) => {
                      "use server";
                      const agentIdentityId = formData.get("agentIdentityId") as string;
                      if (!agentIdentityId) return;
                      const { assignAgentToCircle } = await import("@corgtex/domain");
                      const { requirePageActor } = await import("@/lib/auth");
                      const { revalidatePath } = await import("next/cache");
                      const actor = await requirePageActor();
                      await assignAgentToCircle(actor, { workspaceId, agentIdentityId, circleId: circle.id });
                      revalidatePath(`/workspaces/${workspaceId}/circles`);
                    }} className="actions-inline">
                      <select name="agentIdentityId" style={{ width: "auto", minWidth: 120 }} required>
                        <option value="">{t("selectAgentOption")}</option>
                        {allAgents.map((agent: any) => (
                          <option key={agent.id} value={agent.id}>{agent.displayName}</option>
                        ))}
                      </select>
                      <button type="submit" className="secondary small">{t("btnAssignAgent")}</button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      )}

      {!isDemo && (
        <div>
          <section className="ws-section" style={{ flex: 1 }}>
            <details>
              <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
                <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newCircleTitle")}</span>
              </summary>
              <form action={createCircleAction} className="stack nr-form-section">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <label>
                  {t("formName")}
                  <input name="name" required />
                </label>
                <label>
                  {t("formParentCircle")}
                  <select name="parentCircleId">
                    <option value="">{t("formParentCircleNone")}</option>
                    {circles.map((circle) => (
                      <option key={circle.id} value={circle.id}>{circle.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("formPurpose")}
                  <textarea name="purposeMd" />
                </label>
                <label>
                  {t("formDomain")}
                  <textarea name="domainMd" />
                </label>
                <button type="submit">{t("btnCreateCircle")}</button>
              </form>
            </details>
          </section>

          <section className="ws-section" style={{ flex: 1 }}>
            <details>
              <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
                <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>{t("newRoleTitle")}</span>
              </summary>
              <form action={createRoleAction} className="stack nr-form-section">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <label>
                  {t("formCircle")}
                  <select name="circleId" required defaultValue={circles[0]?.id ?? ""}>
                    {circles.map((circle) => (
                      <option key={circle.id} value={circle.id}>{circle.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("formName")}
                  <input name="name" required />
                </label>
                <label>
                  {t("formPurpose")}
                  <textarea name="purposeMd" />
                </label>
                <label>
                  {t("formAccountabilities")}
                  <textarea name="accountabilities" placeholder={t("formAccountabilitiesPlaceholder")} />
                </label>
                <button type="submit" disabled={circles.length === 0}>{t("btnCreateRole")}</button>
              </form>
            </details>
          </section>
        </div>
      )}
    </>
  );
}
