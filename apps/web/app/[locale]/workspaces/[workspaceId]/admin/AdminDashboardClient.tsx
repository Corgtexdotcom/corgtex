"use client";

import { useState } from "react";
import { adminResetPasswordAction, adminAddToWorkspaceAction, adminRemoveFromWorkspaceAction } from "./actions";
import { useTranslations } from "next-intl";

type WorkspaceItem = { id: string; slug: string; name: string; createdAt: Date; memberCount: number };
type UserItem = {
  id: string; email: string; displayName: string | null;
  memberships: { id: string; role: string; isActive: boolean; workspace: { slug: string; name: string; } }[];
};

export function AdminDashboardClient({
  workspaceId,
  workspaces,
  users,
}: {
  workspaceId: string;
  workspaces: WorkspaceItem[];
  users: UserItem[];
}) {
  const t = useTranslations("admin");
  const [tab, setTab] = useState<"users" | "workspaces">("users");
  const [userQuery, setUserQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserItem | null>(null);

  const filteredUsers = users.filter((u) => {
    const term = userQuery.toLowerCase();
    return u.email.toLowerCase().includes(term) || (u.displayName && u.displayName.toLowerCase().includes(term));
  });

  return (
    <div className="stack">
      <div className="nr-tabs" style={{ marginBottom: 16 }}>
        <button className={tab === "users" ? "active" : ""} onClick={() => { setTab("users"); setSelectedUser(null); }}>{t("usersTab")}</button>
        <button className={tab === "workspaces" ? "active" : ""} onClick={() => setTab("workspaces")}>{t("workspacesTab")}</button>
      </div>

      {tab === "workspaces" && (
        <section className="panel">
          <table className="nr-table">
            <thead>
              <tr>
                <th>{t("colWorkspace")}</th>
                <th>{t("colSlug")}</th>
                <th>{t("colCreated")}</th>
                <th>{t("colMembers")}</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.name}</strong></td>
                  <td><code style={{ fontSize: "0.75rem" }}>{w.slug}</code></td>
                  <td>{new Date(w.createdAt).toLocaleDateString()}</td>
                  <td>{w.memberCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "users" && !selectedUser && (
        <section className="panel stack">
          <input 
            type="search" 
            placeholder={t("placeholderSearchUsers")} 
            value={userQuery} 
            onChange={(e) => setUserQuery(e.target.value)}
            style={{ width: "100%", maxWidth: 400 }}
          />

          <table className="nr-table">
            <thead>
              <tr>
                <th>{t("colUser")}</th>
                <th>{t("colEmail")}</th>
                <th>{t("titleMemberships")}</th>
                <th>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.displayName || "—"}</strong></td>
                  <td>{u.email}</td>
                  <td>{t("workspaceCount", { count: u.memberships.length })}</td>
                  <td>
                    <button className="small secondary" onClick={() => setSelectedUser(u)}>{t("btnManage")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "users" && selectedUser && (
        <section className="panel stack">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="title-md">{t("managingUser", { email: selectedUser.email })}</h2>
            <button className="small" onClick={() => setSelectedUser(null)}>{t("btnBackToList")}</button>
          </div>
          
          <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <form action={adminResetPasswordAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="email" value={selectedUser.email} />
              <button type="submit" className="secondary danger">{t("btnTriggerPasswordReset")}</button>
            </form>
          </div>

          <h3 className="title-sm" style={{ marginTop: 24, borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>{t("titleMemberships")}</h3>
          {selectedUser.memberships.length === 0 ? (
            <p className="muted">{t("noMemberships")}</p>
          ) : (
            <table className="nr-table" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th>{t("colWorkspace")}</th>
                  <th>{t("colRole")}</th>
                  <th>{t("colStatus")}</th>
                  <th>{t("colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {selectedUser.memberships.map((m) => (
                  <tr key={m.id}>
                    <td>{m.workspace.name} <code>({m.workspace.slug})</code></td>
                    <td>{m.role}</td>
                    <td>{m.isActive ? t("statusActive") : t("statusInactive")}</td>
                    <td>
                      <form action={adminRemoveFromWorkspaceAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="memberId" value={m.id} />
                        <button type="submit" className="small danger" style={{ padding: "4px 8px" }}>{t("btnRemove")}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <details style={{ background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 8, marginTop: 24 }}>
            <summary className="nr-section-header" style={{ borderTop: "none", display: "block", padding: "16px", margin: 0, cursor: "pointer", color: "var(--accent)" }}>
              <span style={{ fontWeight: 600 }}>{t("btnAddWorkspace")}</span>
            </summary>
            <div style={{ padding: "0 16px 16px" }}>
              <form action={adminAddToWorkspaceAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="userId" value={selectedUser.id} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <label>
                    {t("labelTargetWorkspace")}
                    <select name="targetWorkspaceId" required>
                      <option value="">{t("selectWorkspace")}</option>
                      {workspaces.map(w => (
                        <option key={w.id} value={w.id}>{w.name} ({w.slug})</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("colRole")}
                    <select name="role" defaultValue="CONTRIBUTOR">
                      <option value="CONTRIBUTOR">{t("roleContributor")}</option>
                      <option value="ADMIN">{t("roleAdmin")}</option>
                    </select>
                  </label>
                </div>
                <button type="submit" style={{ alignSelf: "flex-start" }}>{t("addToWorkspaceBtn")}</button>
              </form>
            </div>
          </details>

        </section>
      )}
    </div>
  );
}
