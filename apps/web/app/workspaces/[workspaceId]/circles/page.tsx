import { listCircles, listRoles, listRoleAssignments, listMembers } from "@corgtex/domain";
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

export const dynamic = "force-dynamic";

export default async function CirclesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requirePageActor();

  let circles: Awaited<ReturnType<typeof listCircles>>;
  let roles: Awaited<ReturnType<typeof listRoles>>;
  let assignments: Awaited<ReturnType<typeof listRoleAssignments>>;
  let members: Awaited<ReturnType<typeof listMembers>>;
  let isDemo = false;

  try {
    const currentWorkspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } });
    isDemo = currentWorkspace?.slug === "jnj-demo";

    const [c, r, a, m] = await Promise.all([
      listCircles(workspaceId).catch(e => { console.error("[CirclesPage] listCircles failed:", e); throw e; }),
      listRoles(workspaceId).catch(e => { console.error("[CirclesPage] listRoles failed:", e); throw e; }),
      listRoleAssignments(workspaceId).catch(e => { console.error("[CirclesPage] listRoleAssignments failed:", e); throw e; }),
      listMembers(workspaceId).catch(e => { console.error("[CirclesPage] listMembers failed:", e); throw e; }),
    ]);
    circles = c;
    roles = r;
    assignments = a;
    members = m;
  } catch (error) {
    console.error("[CirclesPage] Failed to load circles data detailed:", error);
    return (
      <>
        <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Circles &amp; Roles</h1>
        </header>
        <section className="ws-section">
          <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
            <h3 style={{ margin: "0 0 8px" }}>Unable to load circles</h3>
            <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
              There was a problem loading the organizational structure. This has been logged and the team has been notified. Please try refreshing.
            </p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Circles &amp; Roles</h1>
        <div className="nr-masthead-meta">
          <span>Organizational structure, accountabilities, and role assignments.</span>
        </div>
      </header>

      <section className="ws-section">
        {(!circles || circles.length === 0) && (
          <div className="nr-item" style={{ textAlign: "center", padding: "48px 24px" }}>
            <h3 style={{ margin: "0 0 8px" }}>What is a Circle?</h3>
            <p className="muted" style={{ margin: 0, maxWidth: 500, marginInline: "auto" }}>
              Circles are autonomous teams with a clear purpose and domain. Start by creating your first circle.
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
                    {circle.name} Circle
                  </h2>
                  {!isDemo && (
                    <form action={deleteCircleAction} style={{ marginLeft: 16 }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="circleId" value={circle.id} />
                      <button type="submit" className="danger small">Delete Circle</button>
                    </form>
                  )}
                </div>
                
                <div style={{ marginBottom: 24 }}>
                  {circle.purposeMd && <div className="nr-excerpt">{circle.purposeMd}</div>}
                  {circle.domainMd && <div className="nr-item-meta">Domain: {circle.domainMd}</div>}
                </div>

                <div>
                  {circleRoles.length === 0 && <div className="nr-item-meta">No roles in this circle yet.</div>}
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
                                <button type="submit" className="danger small">Delete</button>
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
                                  <span>Member: {a.member?.user?.displayName ?? a.member?.user?.email ?? "Unknown"}</span>
                                  {!isDemo && (
                                    <form action={unassignRoleAction}>
                                      <input type="hidden" name="workspaceId" value={workspaceId} />
                                      <input type="hidden" name="roleId" value={role.id} />
                                      <input type="hidden" name="memberId" value={a.member?.id} />
                                      <button type="submit" className="danger small">Unassign</button>
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
                              <button type="submit" className="secondary small">Assign Member</button>
                            </form>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {!isDemo && (
        <div>
          <section className="ws-section" style={{ flex: 1 }}>
            <details>
              <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
                <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ Create Circle</span>
              </summary>
              <form action={createCircleAction} className="stack nr-form-section">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <label>
                  Name
                  <input name="name" required />
                </label>
                <label>
                  Purpose
                  <textarea name="purposeMd" />
                </label>
                <label>
                  Domain
                  <textarea name="domainMd" />
                </label>
                <button type="submit">Create circle</button>
              </form>
            </details>
          </section>

          <section className="ws-section" style={{ flex: 1 }}>
            <details>
              <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
                <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>+ Create Role</span>
              </summary>
              <form action={createRoleAction} className="stack nr-form-section">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <label>
                  Circle
                  <select name="circleId" required defaultValue={circles[0]?.id ?? ""}>
                    {circles.map((circle) => (
                      <option key={circle.id} value={circle.id}>{circle.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Name
                  <input name="name" required />
                </label>
                <label>
                  Purpose
                  <textarea name="purposeMd" />
                </label>
                <label>
                  Accountabilities
                  <textarea name="accountabilities" placeholder="One per line" />
                </label>
                <button type="submit" disabled={circles.length === 0}>Create role</button>
              </form>
            </details>
          </section>
        </div>
      )}
    </>
  );
}
