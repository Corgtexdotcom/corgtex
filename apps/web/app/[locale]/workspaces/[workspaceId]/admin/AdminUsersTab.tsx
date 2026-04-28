"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  workspaceId: string;
  users: any[];
}

export function AdminUsersTab({ users, workspaceId }: Props) {
  const t = useTranslations("admin");
  const [search, setSearch] = useState("");

  const filteredUsers = users.filter(u => 
    u.email.toLowerCase().includes(search.toLowerCase()) || 
    (u.displayName && u.displayName.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="admin-users stack" style={{ gap: 24 }}>
      <div className="card" style={{ padding: 24, display: "flex", gap: 16, alignItems: "center" }}>
        <input 
          type="text" 
          placeholder={t("placeholderSearchUsers")}
          className="input" 
          style={{ flex: 1, maxWidth: 400 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card">
        <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
              <th style={{ padding: 12 }}>{t("colUser")}</th>
              <th style={{ padding: 12 }}>{t("colEmail")}</th>
              <th style={{ padding: 12 }}>{t("colMemberships")}</th>
              <th style={{ padding: 12 }}>{t("colRole")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: 12 }}>
                  <div style={{ fontWeight: 500 }}>{u.displayName || "Unknown"}</div>
                  <div className="muted text-sm">
                    {u.sessions.length > 0 ? (
                      t("lastLogin", { date: new Date(u.sessions[0].createdAt).toLocaleDateString() })
                    ) : (
                      t("neverLoggedIn")
                    )}
                  </div>
                </td>
                <td style={{ padding: 12 }}>{u.email}</td>
                <td style={{ padding: 12 }}>
                  <div className="stack" style={{ gap: 4 }}>
                    <div style={{ fontWeight: 500 }}>{t("membershipsCount", { count: u.memberships.length })}</div>
                    <div className="muted text-sm">
                      {u.memberships.map((m: any) => m.workspace.name).join(", ")}
                    </div>
                  </div>
                </td>
                <td style={{ padding: 12 }}>
                  {u.globalRole === "OPERATOR" ? (
                    <span style={{ color: "var(--accent-11)", fontWeight: 600 }}>OPERATOR</span>
                  ) : (
                    "USER"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
