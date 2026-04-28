"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { SubmitButton } from "@/lib/components/SubmitButton";
import { 
  adminRegisterInstanceAction, 
  adminProvisionHostedCustomerAction,
  adminRemoveInstanceAction, 
  adminProbeInstanceHealthAction,
  adminSuspendHostedInstanceAction,
  adminTriggerBootstrapAction,
  adminUpgradeHostedInstanceAction,
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
  const [showProvision, setShowProvision] = useState(false);

  return (
    <div className="admin-operations stack" style={{ gap: 32 }}>
      
      <section className="stack" style={{ gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="title-lg">{t("externalInstances")}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setShowProvision(!showProvision)}>
              Provision hosted customer
            </button>
            <button className="btn" onClick={() => setShowRegister(!showRegister)}>
              {t("registerInstance")}
            </button>
          </div>
        </div>

        {showProvision && (
          <div className="card" style={{ padding: 24 }}>
            <form action={adminProvisionHostedCustomerAction} className="stack" style={{ gap: 16 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
                <div className="form-group">
                  <label>Customer label</label>
                  <input type="text" name="label" className="input" required placeholder="Acme Production" />
                </div>
                <div className="form-group">
                  <label>Customer slug</label>
                  <input type="text" name="customerSlug" className="input" required placeholder="acme-prod" />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <input type="text" name="region" className="input" required placeholder="eu-west4" />
                </div>
                <div className="form-group">
                  <label>Data residency</label>
                  <input type="text" name="dataResidency" className="input" required placeholder="eu" />
                </div>
                <div className="form-group">
                  <label>Custom domain</label>
                  <input type="text" name="customDomain" className="input" placeholder="acme.corgtex.com" />
                </div>
                <div className="form-group">
                  <label>Support owner</label>
                  <input type="email" name="supportOwnerEmail" className="input" placeholder="ops@corgtex.com" />
                </div>
                <div className="form-group">
                  <label>Release version</label>
                  <input type="text" name="releaseVersion" className="input" placeholder="0.1.0" />
                </div>
                <div className="form-group">
                  <label>Release image tag</label>
                  <input type="text" name="releaseImageTag" className="input" required placeholder="sha-..." />
                </div>
                <div className="form-group">
                  <label>Web image</label>
                  <input type="text" name="webImage" className="input" required placeholder="ghcr.io/corgtexdotcom/corgtex/web:sha-..." />
                </div>
                <div className="form-group">
                  <label>Worker image</label>
                  <input type="text" name="workerImage" className="input" required placeholder="ghcr.io/corgtexdotcom/corgtex/worker:sha-..." />
                </div>
                <div className="form-group">
                  <label>Bundle URI</label>
                  <input type="url" name="bootstrapBundleUri" className="input" placeholder="https://private-storage.example/bundle.json" />
                </div>
                <div className="form-group">
                  <label>Bundle checksum</label>
                  <input type="text" name="bootstrapBundleChecksum" className="input" placeholder="sha256 hex" />
                </div>
                <div className="form-group">
                  <label>Bundle schema</label>
                  <input type="text" name="bootstrapBundleSchemaVersion" className="input" placeholder="stable-client-v1" />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <SubmitButton>Provision hosted customer</SubmitButton>
              </div>
            </form>
          </div>
        )}

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
                <div className="form-group">
                  <label>Customer slug</label>
                  <input type="text" name="customerSlug" className="input" placeholder="acme-prod" />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <input type="text" name="region" className="input" placeholder="eu-west4" />
                </div>
                <div className="form-group">
                  <label>Release image tag</label>
                  <input type="text" name="releaseImageTag" className="input" placeholder="sha-..." />
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
                  <th style={{ padding: 12 }}>Region</th>
                  <th style={{ padding: 12 }}>Release</th>
                  <th style={{ padding: 12 }}>Provisioning</th>
                  <th style={{ padding: 12 }}>Bootstrap</th>
                  <th style={{ padding: 12 }}>{t("instanceLastChecked")}</th>
                  <th style={{ padding: 12 }}>{t("colStatus")}</th>
                  <th style={{ padding: 12 }}>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.instances.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ padding: 24, textAlign: "center" }} className="muted">
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
                  <td style={{ padding: 12 }}>{inst.region || "—"}</td>
                  <td style={{ padding: 12 }}>{inst.releaseImageTag || inst.releaseVersion || "—"}</td>
                  <td style={{ padding: 12 }}>{inst.provisioningStatus || "draft"}</td>
                  <td style={{ padding: 12 }}>{inst.bootstrapStatus || "not_started"}</td>
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
                      <form action={adminSuspendHostedInstanceAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="instanceId" value={inst.id} />
                        <SubmitButton variant="secondary" className="btn-sm">Suspend</SubmitButton>
                      </form>
                    </div>
                    {inst.bootstrapBundleUri && (
                      <form action={adminTriggerBootstrapAction} style={{ display: "grid", gap: 6, marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="instanceId" value={inst.id} />
                        <input type="password" name="bootstrapToken" className="input" placeholder="Bootstrap token" required />
                        <input type="datetime-local" name="expiresAt" className="input" required />
                        <SubmitButton variant="secondary" className="btn-sm">Trigger bootstrap</SubmitButton>
                      </form>
                    )}
                    {inst.railwayWebServiceId && inst.railwayWorkerServiceId && (
                      <form action={adminUpgradeHostedInstanceAction} style={{ display: "grid", gap: 6, marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="instanceId" value={inst.id} />
                        <input type="text" name="releaseVersion" className="input" placeholder="Release version" />
                        <input type="text" name="releaseImageTag" className="input" placeholder="sha-..." required />
                        <input type="text" name="webImage" className="input" placeholder="Web image" required />
                        <input type="text" name="workerImage" className="input" placeholder="Worker image" required />
                        <SubmitButton variant="secondary" className="btn-sm">Upgrade release</SubmitButton>
                      </form>
                    )}
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
