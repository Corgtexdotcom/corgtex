"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AdminWorkspaceMemberPanel } from "./AdminWorkspaceMemberPanel";
import { adminCreateWorkspaceAction } from "./actions";
import { SubmitButton } from "@/lib/components/SubmitButton";
import Link from "next/link";

interface Props {
  workspaceId: string;
  workspaces: any[];
}

export function AdminWorkspacesTab({ workspaces, workspaceId }: Props) {
  const t = useTranslations("admin");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="admin-workspaces stack" style={{ gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => setShowCreate(!showCreate)}>
          {t("createWorkspace")}
        </button>
      </div>

      {showCreate && (
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <form action={adminCreateWorkspaceAction} className="stack" style={{ gap: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="form-group">
              <label>{t("formWorkspaceName")}</label>
              <input type="text" name="name" className="input" required />
            </div>
            <div className="form-group">
              <label>{t("formWorkspaceSlug")}</label>
              <input type="text" name="slug" className="input" required />
            </div>
            <div className="form-group">
              <label>{t("formWorkspaceDescription")}</label>
              <input type="text" name="description" className="input" />
            </div>
            <SubmitButton>{t("createWorkspace")}</SubmitButton>
          </form>
        </div>
      )}

      <div className="card">
        <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
              <th style={{ padding: 12 }}>{t("colWorkspace")}</th>
              <th style={{ padding: 12 }}>{t("colSlug")}</th>
              <th style={{ padding: 12 }}>{t("colMembers")}</th>
              <th style={{ padding: 12 }}>{t("colAdmins")}</th>
              <th style={{ padding: 12 }}>{t("colFailedJobs")}</th>
              <th style={{ padding: 12 }}>{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((ws) => (
              <tr key={ws.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: 12 }}>
                  <div style={{ fontWeight: 500 }}>{ws.name}</div>
                  <div className="muted text-sm">{t("colCreated")}: {new Date(ws.createdAt).toLocaleDateString()}</div>
                </td>
                <td style={{ padding: 12 }}><code>{ws.slug}</code></td>
                <td style={{ padding: 12 }}>
                  {ws.activeMemberCount} / {ws.memberCount}
                </td>
                <td style={{ padding: 12 }}>{ws.adminCount}</td>
                <td style={{ padding: 12 }}>
                  {ws.failedJobsCount > 0 ? (
                    <span style={{ color: "var(--red-11)", fontWeight: 500 }}>{ws.failedJobsCount}</span>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
                <td style={{ padding: 12 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Link href={`/workspaces/${ws.id}/overview`} className="btn-secondary btn-sm" target="_blank">
                      {t("btnOpenWorkspace")}
                    </Link>
                    <button 
                      className="btn-secondary btn-sm"
                      onClick={() => setExpandedId(expandedId === ws.id ? null : ws.id)}
                    >
                      {expandedId === ws.id ? t("btnCollapseWorkspace") : t("btnExpandWorkspace")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {expandedId && (
        <div className="card" style={{ padding: 24, background: "var(--gray-2)", marginTop: 8 }}>
          <AdminWorkspaceMemberPanel 
            targetWorkspaceId={expandedId} 
            workspaceId={workspaceId} 
          />
        </div>
      )}
    </div>
  );
}
