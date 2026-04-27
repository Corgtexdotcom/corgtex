"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { SubmitButton } from "@/lib/components/SubmitButton";
import { 
  adminRegisterInstanceAction, 
  adminRemoveInstanceAction, 
  adminProbeInstanceHealthAction,
  adminDiscardFailedJobAction,
  adminRetryFailedJobAction
} from "./actions";

interface Props {
  workspaceId: string;
  data: {
    instances: any[];
    failedJobs: any[];
    commErrors: any[];
  };
}

export function AdminOperationsTab({ data, workspaceId }: Props) {
  const t = useTranslations("admin");
  const [showRegister, setShowRegister] = useState(false);

  return (
    <div className="admin-operations stack" style={{ gap: 32 }}>
      
      <section className="stack" style={{ gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="title-lg">{t("externalInstances")}</h2>
          <button className="btn" onClick={() => setShowRegister(!showRegister)}>
            {t("registerInstance")}
          </button>
        </div>

        {showRegister && (
          <div className="card" style={{ padding: 24 }}>
            <form action={adminRegisterInstanceAction} className="stack" style={{ gap: 16 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div className="form-group">
                  <label>{t("instanceLabel")}</label>
                  <input type="text" name="label" className="input" required placeholder="e.g. Acme Corp Prod" />
                </div>
                <div className="form-group">
                  <label>{t("instanceUrl")}</label>
                  <input type="url" name="url" className="input" required placeholder="https://acme.corgtex.com" />
                </div>
                <div className="form-group">
                  <label>{t("instanceEnvironment")}</label>
                  <input type="text" name="environment" className="input" placeholder="production" />
                </div>
                <div className="form-group">
                  <label>{t("formNotes")}</label>
                  <input type="text" name="notes" className="input" placeholder="Self-hosted region EU" />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <SubmitButton>{t("registerInstance")}</SubmitButton>
              </div>
            </form>
          </div>
        )}

        <div className="card">
          <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <th style={{ padding: 12 }}>{t("instanceLabel")}</th>
                <th style={{ padding: 12 }}>{t("instanceUrl")}</th>
                <th style={{ padding: 12 }}>{t("instanceEnvironment")}</th>
                <th style={{ padding: 12 }}>{t("instanceLastChecked")}</th>
                <th style={{ padding: 12 }}>{t("colStatus")}</th>
                <th style={{ padding: 12 }}>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.instances.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 24, textAlign: "center" }} className="muted">
                    No instances registered.
                  </td>
                </tr>
              ) : data.instances.map(inst => (
                <tr key={inst.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <td style={{ padding: 12 }}>{inst.label}</td>
                  <td style={{ padding: 12 }}>
                    <a href={inst.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent-11)" }}>
                      {inst.url}
                    </a>
                  </td>
                  <td style={{ padding: 12 }}>{inst.environment || "—"}</td>
                  <td style={{ padding: 12 }}>
                    {inst.lastHealthCheck ? new Date(inst.lastHealthCheck).toLocaleString() : "Never"}
                  </td>
                  <td style={{ padding: 12 }}>
                    {inst.lastHealthStatus === "ok" ? (
                      <span style={{ color: "var(--green-11)", fontWeight: 500 }}>{t("instanceHealthOk")}</span>
                    ) : inst.lastHealthStatus === "degraded" ? (
                      <span style={{ color: "var(--orange-11)", fontWeight: 500 }}>{t("instanceHealthDegraded")}</span>
                    ) : inst.lastHealthStatus === "down" ? (
                      <span style={{ color: "var(--red-11)", fontWeight: 500 }}>{t("instanceHealthDown")}</span>
                    ) : (
                      <span className="muted">{t("instanceHealthUnknown")}</span>
                    )}
                  </td>
                  <td style={{ padding: 12 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <form action={adminProbeInstanceHealthAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="instanceId" value={inst.id} />
                        <SubmitButton variant="secondary" className="btn-sm">{t("btnCheckNow")}</SubmitButton>
                      </form>
                      <form action={adminRemoveInstanceAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="instanceId" value={inst.id} />
                        <SubmitButton variant="secondary" className="btn-sm">{t("btnRemoveInstance")}</SubmitButton>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: 16 }}>
        <h2 className="title-lg">{t("crossWorkspaceFailedJobs")}</h2>
        
        {data.failedJobs.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: "center" }}>
            <div className="muted">{t("noFailedJobsGlobal")}</div>
          </div>
        ) : (
          <div className="card">
            <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <th style={{ padding: 12 }}>{t("colWorkspace")}</th>
                  <th style={{ padding: 12 }}>Type</th>
                  <th style={{ padding: 12 }}>Error</th>
                  <th style={{ padding: 12 }}>{t("colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.failedJobs.map(job => (
                  <tr key={job.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                    <td style={{ padding: 12 }}>{job.workspace.name}</td>
                    <td style={{ padding: 12 }}>{job.type}</td>
                    <td style={{ padding: 12 }} className="muted text-sm">{job.error?.substring(0, 100)}</td>
                    <td style={{ padding: 12 }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <form action={adminRetryFailedJobAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="targetWorkspaceId" value={job.workspaceId} />
                          <input type="hidden" name="jobId" value={job.id} />
                          <SubmitButton variant="secondary" className="btn-sm">Retry</SubmitButton>
                        </form>
                        <form action={adminDiscardFailedJobAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="targetWorkspaceId" value={job.workspaceId} />
                          <input type="hidden" name="jobId" value={job.id} />
                          <SubmitButton variant="secondary" className="btn-sm">Discard</SubmitButton>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack" style={{ gap: 16 }}>
        <h2 className="title-lg">{t("communicationErrors")}</h2>
        
        {data.commErrors.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: "center" }}>
            <div className="muted">{t("noCommunicationErrors")}</div>
          </div>
        ) : (
          <div className="card">
            <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <th style={{ padding: 12 }}>{t("colWorkspace")}</th>
                  <th style={{ padding: 12 }}>Provider</th>
                  <th style={{ padding: 12 }}>{t("colStatus")}</th>
                  <th style={{ padding: 12 }}>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.commErrors.map(err => (
                  <tr key={err.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                    <td style={{ padding: 12 }}>{err.workspace.name}</td>
                    <td style={{ padding: 12 }}>{err.provider}</td>
                    <td style={{ padding: 12 }}>
                      <span style={{ color: "var(--red-11)", fontWeight: 500 }}>{err.status}</span>
                    </td>
                    <td style={{ padding: 12 }} className="muted text-sm">{err.lastError?.substring(0, 100) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
