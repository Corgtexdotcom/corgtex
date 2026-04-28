"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { adminGetWorkspaceDetailAction, adminCreateMemberAction, adminUpdateMemberAction, adminDeactivateMemberAction, adminResendAccessLinkAction } from "./actions";
import { SubmitButton } from "@/lib/components/SubmitButton";

interface Props {
  workspaceId: string;
  targetWorkspaceId: string;
}

export function AdminWorkspaceMemberPanel({ workspaceId, targetWorkspaceId }: Props) {
  const t = useTranslations("admin");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  useEffect(() => {
    adminGetWorkspaceDetailAction(workspaceId, targetWorkspaceId).then(res => {
      setData(res);
      setLoading(false);
    });
  }, [workspaceId, targetWorkspaceId]);

  if (loading) return <div className="muted p-4">Loading details...</div>;
  if (!data) return <div className="muted p-4">Failed to load</div>;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 24 }}>
        
        {/* Members Column */}
        <div className="stack" style={{ gap: 16 }}>
          <h4 className="title-md">{t("panelMembers")}</h4>
          <form action={adminCreateMemberAction} className="stack border-bottom" style={{ gap: 12, paddingBottom: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="targetWorkspaceId" value={targetWorkspaceId} />
            <div style={{ display: "flex", gap: 12 }}>
              <input type="email" name="email" placeholder="Email" className="input" required style={{ flex: 1 }} />
              <input type="text" name="displayName" placeholder="Name" className="input" style={{ flex: 1 }} />
              <select name="role" className="input" style={{ width: 150 }}>
                <option value="CONTRIBUTOR">{t("roleContributor")}</option>
                <option value="ADMIN">{t("roleAdmin")}</option>
                <option value="FACILITATOR">{t("roleFacilitator")}</option>
                <option value="FINANCE_STEWARD">{t("roleFinance")}</option>
              </select>
              <SubmitButton>{t("btnAddMember")}</SubmitButton>
            </div>
          </form>

          <table className="table" style={{ width: "100%", textAlign: "left", fontSize: "14px" }}>
            <thead>
              <tr>
                <th>{t("colUser")}</th>
                <th>{t("colRole")}</th>
                <th>{t("colLastActivity")}</th>
                <th>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{m.user.displayName || "Unknown"}</div>
                    <div className="muted text-sm">{m.user.email}</div>
                  </td>
                  <td>
                    <form action={adminUpdateMemberAction} style={{ display: "flex", gap: 8 }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="targetWorkspaceId" value={targetWorkspaceId} />
                      <input type="hidden" name="memberId" value={m.id} />
                      <select name="role" className="input input-sm" defaultValue={m.role} onChange={(e) => e.target.form?.requestSubmit()}>
                        <option value="CONTRIBUTOR">{t("roleContributor")}</option>
                        <option value="ADMIN">{t("roleAdmin")}</option>
                        <option value="FACILITATOR">{t("roleFacilitator")}</option>
                        <option value="FINANCE_STEWARD">{t("roleFinance")}</option>
                      </select>
                    </form>
                  </td>
                  <td className="muted">
                    {m.user.sessions.length > 0 ? (
                      t("lastLogin", { date: new Date(m.user.sessions[0].createdAt).toLocaleDateString() })
                    ) : (
                      t("neverLoggedIn")
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8 }}>
                      <form action={async (formData) => {
                        const res = await adminResendAccessLinkAction(formData);
                        if (res?.url) {
                          navigator.clipboard.writeText(res.url);
                          setCopiedLink(m.id);
                          setTimeout(() => setCopiedLink(null), 2000);
                        }
                      }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="targetWorkspaceId" value={targetWorkspaceId} />
                        <input type="hidden" name="memberId" value={m.id} />
                        <SubmitButton variant="secondary" className="btn-sm">
                          {copiedLink === m.id ? t("linkCopied") : t("btnCopyLink")}
                        </SubmitButton>
                      </form>

                      {m.isActive && (
                        <form action={adminDeactivateMemberAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="targetWorkspaceId" value={targetWorkspaceId} />
                          <input type="hidden" name="memberId" value={m.id} />
                          <SubmitButton variant="secondary" className="btn-sm">{t("btnDeactivate")}</SubmitButton>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Failed Jobs Column */}
        <div className="stack" style={{ gap: 16 }}>
          <h4 className="title-md">{t("panelFailedJobs")}</h4>
          {data.failedJobs.length === 0 ? (
            <div className="muted">{t("noIssues")}</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {data.failedJobs.map((job: any) => (
                <div key={job.id} className="card p-3 stack" style={{ gap: 4 }}>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>{job.type}</div>
                  <div className="muted text-sm">{job.error?.substring(0, 100)}</div>
                </div>
              ))}
            </div>
          )}

          <h4 className="title-md" style={{ marginTop: 16 }}>{t("panelCommunication")}</h4>
          {data.commInstallations.length === 0 ? (
            <div className="muted">{t("noIssues")}</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {data.commInstallations.map((inst: any) => (
                <div key={inst.id} className="card p-3 stack" style={{ gap: 4 }}>
                  <div style={{ fontWeight: 500, fontSize: "14px" }}>{inst.provider}</div>
                  <div className="muted text-sm">{inst.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        
      </div>
    </div>
  );
}
