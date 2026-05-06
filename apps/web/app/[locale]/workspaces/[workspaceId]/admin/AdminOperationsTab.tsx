"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { SubmitButton } from "@/lib/components/SubmitButton";
import { 
  adminRegisterCustomerDeploymentAction,
  adminProvisionCustomerDeploymentAction,
  adminRemoveCustomerDeploymentAction,
  adminProbeCustomerDeploymentHealthAction,
  adminSuspendCustomerDeploymentAction,
  adminTriggerBootstrapAction,
  adminUpgradeCustomerDeploymentAction,
  adminDiscardFailedJobAction,
  adminRetryFailedJobAction
} from "./actions";

interface Props {
  workspaceId: string;
  data: {
    deployments: any[];
    failedJobs: any[];
    commErrors: any[];
  };
}

function readinessLabel(status?: string) {
  return status === "ready" ? "Ready" : "Needs attention";
}

function readinessColor(status?: string) {
  return status === "ready" ? "var(--green-11)" : "var(--orange-11)";
}

export function AdminOperationsTab({ data, workspaceId }: Props) {
  const t = useTranslations("admin");
  const [showRegister, setShowRegister] = useState(false);
  const [showProvision, setShowProvision] = useState(false);

  return (
    <div className="admin-operations stack" style={{ gap: 32 }}>
      
      <section className="stack" style={{ gap: 16 }}>
        <div className="admin-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="title-lg">{t("customerDeployments")}</h2>
          <div className="admin-header-actions" style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setShowProvision(!showProvision)}>
              Provision customer deployment
            </button>
            <button className="btn" onClick={() => setShowRegister(!showRegister)}>
              {t("registerDeployment")}
            </button>
          </div>
        </div>

        {showProvision && (
          <div className="card" style={{ padding: 24 }}>
            <form action={adminProvisionCustomerDeploymentAction} className="stack" style={{ gap: 16 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div className="admin-form-grid admin-form-grid-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
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
                  <input type="text" name="webImage" className="input" placeholder="ghcr.io/corgtexdotcom/corgtex/web:sha-..." />
                </div>
                <div className="form-group">
                  <label>Worker image</label>
                  <input type="text" name="workerImage" className="input" placeholder="ghcr.io/corgtexdotcom/corgtex/worker:sha-..." />
                </div>
                <div className="form-group">
                  <label>Railway bucket</label>
                  <input type="text" name="storageBucketName" className="input" placeholder="customer-bucket-name" />
                </div>
                <div className="form-group">
                  <label>Web repo</label>
                  <input type="text" name="webRepo" className="input" defaultValue="Corgtexdotcom/corgtex" />
                </div>
                <div className="form-group">
                  <label>Web branch</label>
                  <input type="text" name="webBranch" className="input" defaultValue="main" />
                </div>
                <div className="form-group">
                  <label>Web Dockerfile</label>
                  <input type="text" name="webDockerfilePath" className="input" defaultValue="deploy/Dockerfile.web" />
                </div>
                <div className="form-group">
                  <label>Worker repo</label>
                  <input type="text" name="workerRepo" className="input" defaultValue="Corgtexdotcom/corgtex" />
                </div>
                <div className="form-group">
                  <label>Worker branch</label>
                  <input type="text" name="workerBranch" className="input" defaultValue="main" />
                </div>
                <div className="form-group">
                  <label>Worker Dockerfile</label>
                  <input type="text" name="workerDockerfilePath" className="input" defaultValue="deploy/Dockerfile.worker" />
                </div>
                <div className="form-group">
                  <label>Web commit</label>
                  <input type="text" name="webCommitSha" className="input" placeholder="optional commit SHA" />
                </div>
                <div className="form-group">
                  <label>Worker commit</label>
                  <input type="text" name="workerCommitSha" className="input" placeholder="optional commit SHA" />
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
                <SubmitButton>Provision customer deployment</SubmitButton>
              </div>
            </form>
          </div>
        )}

        {showRegister && (
          <div className="card" style={{ padding: 24 }}>
            <form action={adminRegisterCustomerDeploymentAction} className="stack" style={{ gap: 16 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div className="admin-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div className="form-group">
                  <label>{t("deploymentLabel")}</label>
                  <input type="text" name="label" className="input" required placeholder="e.g. Acme Corp Prod" />
                </div>
                <div className="form-group">
                  <label>{t("deploymentUrl")}</label>
                  <input type="url" name="url" className="input" required placeholder="https://acme.corgtex.com" />
                </div>
                <div className="form-group">
                  <label>{t("deploymentEnvironment")}</label>
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
                <div className="form-group">
                  <label>Railway bucket</label>
                  <input type="text" name="storageBucketName" className="input" placeholder="customer-bucket-name" />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <SubmitButton>{t("registerDeployment")}</SubmitButton>
              </div>
            </form>
          </div>
        )}

        <div className="card admin-table-card admin-instance-table">
          <table className="table" style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                <th style={{ padding: 12 }}>{t("deploymentLabel")}</th>
                <th style={{ padding: 12 }}>{t("deploymentUrl")}</th>
                <th style={{ padding: 12 }}>{t("deploymentEnvironment")}</th>
                  <th style={{ padding: 12 }}>Region</th>
                  <th style={{ padding: 12 }}>Release</th>
                  <th style={{ padding: 12 }}>Readiness</th>
                  <th style={{ padding: 12 }}>Provisioning</th>
                  <th style={{ padding: 12 }}>Bootstrap</th>
                  <th style={{ padding: 12 }}>{t("deploymentLastChecked")}</th>
                  <th style={{ padding: 12 }}>{t("colStatus")}</th>
                  <th style={{ padding: 12 }}>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.deployments.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ padding: 24, textAlign: "center" }} className="muted">
                    No customer deployments registered.
                  </td>
                </tr>
              ) : data.deployments.map(deployment => (
                <tr key={deployment.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <td data-label={t("deploymentLabel")} style={{ padding: 12 }}>{deployment.label}</td>
                  <td data-label={t("deploymentUrl")} style={{ padding: 12 }}>
                    <a href={deployment.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent-11)" }}>
                      {deployment.url}
                    </a>
                  </td>
                  <td data-label={t("deploymentEnvironment")} style={{ padding: 12 }}>{deployment.environment || "—"}</td>
                  <td data-label="Region" style={{ padding: 12 }}>{deployment.region || "—"}</td>
                  <td data-label="Release" style={{ padding: 12 }}>{deployment.releaseImageTag || deployment.releaseVersion || "—"}</td>
                  <td data-label="Readiness" style={{ padding: 12, minWidth: 220 }}>
                    <details>
                      <summary style={{ color: readinessColor(deployment.readiness?.status), fontWeight: 600 }}>
                        {readinessLabel(deployment.readiness?.status)}
                      </summary>
                      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
                        {(deployment.readiness?.checks ?? []).map((check: any) => (
                          <div key={check.key} className="text-sm">
                            <span style={{
                              color: check.status === "ok" ? "var(--green-11)" : check.status === "warning" ? "var(--orange-11)" : "var(--red-11)",
                              fontWeight: 600,
                            }}>
                              {check.label}
                            </span>
                            <div className="muted">{check.detail}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                  <td data-label="Provisioning" style={{ padding: 12 }}>{deployment.provisioningStatus || "draft"}</td>
                  <td data-label="Bootstrap" style={{ padding: 12 }}>{deployment.bootstrapStatus || "not_started"}</td>
                  <td data-label={t("deploymentLastChecked")} style={{ padding: 12 }}>
                    {deployment.lastHealthCheck ? new Date(deployment.lastHealthCheck).toLocaleString() : "Never"}
                  </td>
                  <td data-label={t("colStatus")} style={{ padding: 12 }}>
                    {deployment.lastHealthStatus === "ok" ? (
                      <span style={{ color: "var(--green-11)", fontWeight: 500 }}>{t("deploymentHealthOk")}</span>
                    ) : deployment.lastHealthStatus === "degraded" ? (
                      <span style={{ color: "var(--orange-11)", fontWeight: 500 }}>{t("deploymentHealthDegraded")}</span>
                    ) : deployment.lastHealthStatus === "down" ? (
                      <span style={{ color: "var(--red-11)", fontWeight: 500 }}>{t("deploymentHealthDown")}</span>
                    ) : (
                      <span className="muted">{t("deploymentHealthUnknown")}</span>
                    )}
                  </td>
                  <td data-label={t("colActions")} style={{ padding: 12 }}>
                    <div className="admin-table-actions" style={{ display: "flex", gap: 8 }}>
                      <form action={adminProbeCustomerDeploymentHealthAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="deploymentId" value={deployment.id} />
                        <SubmitButton variant="secondary" className="btn-sm">{t("btnCheckNow")}</SubmitButton>
                      </form>
                      <form action={adminRemoveCustomerDeploymentAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="deploymentId" value={deployment.id} />
                        <SubmitButton variant="secondary" className="btn-sm">{t("btnRemoveDeployment")}</SubmitButton>
                      </form>
                      <form action={adminSuspendCustomerDeploymentAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="deploymentId" value={deployment.id} />
                        <SubmitButton variant="secondary" className="btn-sm">Suspend</SubmitButton>
                      </form>
                    </div>
                    {deployment.bootstrapBundleUri && (
                      <form action={adminTriggerBootstrapAction} style={{ display: "grid", gap: 6, marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="deploymentId" value={deployment.id} />
                        <input type="password" name="bootstrapToken" className="input" placeholder="Bootstrap token" required />
                        <input type="datetime-local" name="expiresAt" className="input" required />
                        <SubmitButton variant="secondary" className="btn-sm">Trigger bootstrap</SubmitButton>
                      </form>
                    )}
                    {deployment.railwayWebServiceId && deployment.railwayWorkerServiceId && (
                      <form action={adminUpgradeCustomerDeploymentAction} style={{ display: "grid", gap: 6, marginTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="deploymentId" value={deployment.id} />
                        <input type="text" name="releaseVersion" className="input" placeholder="Release version" />
                        <input type="text" name="releaseImageTag" className="input" placeholder="sha-..." required />
                        <input type="text" name="webImage" className="input" placeholder="Web image" />
                        <input type="text" name="workerImage" className="input" placeholder="Worker image" />
                        <input type="text" name="webRepo" className="input" defaultValue="Corgtexdotcom/corgtex" placeholder="Web repo" />
                        <input type="text" name="webBranch" className="input" defaultValue="main" placeholder="Web branch" />
                        <input type="text" name="webDockerfilePath" className="input" defaultValue="deploy/Dockerfile.web" placeholder="Web Dockerfile" />
                        <input type="text" name="webCommitSha" className="input" placeholder="Web commit SHA" />
                        <input type="text" name="workerRepo" className="input" defaultValue="Corgtexdotcom/corgtex" placeholder="Worker repo" />
                        <input type="text" name="workerBranch" className="input" defaultValue="main" placeholder="Worker branch" />
                        <input type="text" name="workerDockerfilePath" className="input" defaultValue="deploy/Dockerfile.worker" placeholder="Worker Dockerfile" />
                        <input type="text" name="workerCommitSha" className="input" placeholder="Worker commit SHA" />
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
          <div className="card admin-table-card">
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
                    <td data-label={t("colWorkspace")} style={{ padding: 12 }}>{job.workspace.name}</td>
                    <td data-label="Type" style={{ padding: 12 }}>{job.type}</td>
                    <td data-label="Error" style={{ padding: 12 }} className="muted text-sm">{job.error?.substring(0, 100)}</td>
                    <td data-label={t("colActions")} style={{ padding: 12 }}>
                      <div className="admin-table-actions" style={{ display: "flex", gap: 8 }}>
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
          <div className="card admin-table-card">
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
                    <td data-label={t("colWorkspace")} style={{ padding: 12 }}>{err.workspace.name}</td>
                    <td data-label="Provider" style={{ padding: 12 }}>{err.provider}</td>
                    <td data-label={t("colStatus")} style={{ padding: 12 }}>
                      <span style={{ color: "var(--red-11)", fontWeight: 500 }}>{err.status}</span>
                    </td>
                    <td data-label="Error" style={{ padding: 12 }} className="muted text-sm">{err.lastError?.substring(0, 100) || "—"}</td>
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
