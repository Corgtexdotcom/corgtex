import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  AppError,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneContextHealth,
  getControlPlaneDeployment,
  getControlPlaneIntegrationStatus,
  getControlPlaneReleaseStatus,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import {
  configureMeetingRecorderIntegrationAction,
  configureSupportConnectorAction,
  recordBreakGlassAction,
  refreshSupportSnapshotAction,
  runContextOperationAction,
  runReleaseOperationAction,
  runSupportOperationAction,
} from "../../actions";
import { ControlPlaneLanguageSwitcher } from "../../ControlPlaneLanguageSwitcher";

export const dynamic = "force-dynamic";

const CUSTOMER_SECTION_IDS = [
  "fleet",
  "context",
  "ai-governance",
  "integrations",
  "releases",
  "support",
  "audit",
  "mcp",
] as const;

const SUPPORT_ACTIONS = [
  ["members.list", "membersList", "membersList"],
  ["members.invite", "membersInvite", "membersInvite"],
  ["members.deactivate", "membersDeactivate", "membersDeactivate"],
  ["integrations.list", "integrationsList", "integrationsList"],
  ["data_feeds.list", "dataFeedsList", "dataFeedsList"],
  ["data_feeds.sync", "dataFeedsSync", "dataFeedsSync"],
  ["tool_links.list", "toolLinksList", "toolLinksList"],
  ["tool_links.upsert", "toolLinksUpsert", "toolLinksUpsert"],
  ["tool_links.archive", "toolLinksArchive", "toolLinksArchive"],
  ["agents.list_runs", "agentsListRuns", "agentsListRuns"],
  ["runtime.list_failed_jobs", "runtimeListFailedJobs", "runtimeListFailedJobs"],
  ["runtime.retry_failed_job", "runtimeRetryFailedJob", "runtimeRetryFailedJob"],
  ["runtime.discard_failed_job", "runtimeDiscardFailedJob", "runtimeDiscardFailedJob"],
  ["documents.upload_text", "documentsUploadText", "documentsUploadText"],
] as const;

type ControlPlaneT = Awaited<ReturnType<typeof getTranslations>>;

type ControlPlaneCustomer = Awaited<ReturnType<typeof getControlPlaneDeployment>>;
type MeetingRecorderIntegration = {
  key: string;
  entitlementEnabled: boolean;
  configured: boolean;
  status: string | null;
  provider: string | null;
  fallbackProvider: string | null;
  autoRecordEnabled: boolean | null;
  botName: string | null;
  entryMessage: string | null;
  monthlyMinuteCap: number | null;
  usage?: { usedMinutes: number };
  failures: number;
  vendorReadiness?: boolean;
};

function tone(status?: string | null) {
  if (status === "ready" || status === "COMPLETED" || status === "ok" || status === "connected" || status === "active") return "var(--green-11)";
  if (status === "attention" || status === "RUNNING" || status === "configured" || status === "provisioning" || status === "pending") return "var(--orange-11)";
  if (status === "FAILED" || status === "degraded" || status === "down" || status === "suspended" || status === "failed") return "var(--red-11)";
  return "var(--gray-11)";
}

function statusLabel(t: ControlPlaneT, status?: string | null) {
  const normalized = status?.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const known = normalized && [
    "active",
    "attention",
    "available",
    "completed",
    "configured",
    "connected",
    "degraded",
    "disabled",
    "down",
    "draft",
    "failed",
    "inspectable",
    "linked",
    "none",
    "not_configured",
    "ok",
    "pending",
    "provisioning",
    "ready",
    "recorded",
    "remote",
    "running",
    "suspended",
    "unknown",
  ].includes(normalized)
    ? normalized
    : null;

  return known ? t(`status.${known}` as any) : (status ? status.replace(/_/g, " ") : t("status.unknown"));
}

function readinessChecks(customer: ControlPlaneCustomer, t: ControlPlaneT) {
  return [
    {
      label: t("customerDetail.readiness.customerRecord"),
      status: customer.customerSlug && customer.url ? "ready" : "attention",
      detail: customer.customerSlug || customer.url ? customer.customerSlug || customer.url : t("customerDetail.readiness.customerRecordMissing"),
    },
    {
      label: t("customerDetail.readiness.managedWorkspace"),
      status: customer.managedWorkspace ? "ready" : "attention",
      detail: customer.managedWorkspace ? `${customer.managedWorkspace.name} / ${customer.managedWorkspace.slug}` : t("customerDetail.readiness.managedWorkspaceMissing"),
    },
    {
      label: t("customerDetail.readiness.deploymentResidency"),
      status: customer.region && customer.dataResidency ? "ready" : "attention",
      detail: [customer.region, customer.dataResidency].filter(Boolean).join(" / ") || t("customerDetail.readiness.deploymentResidencyMissing"),
    },
    {
      label: t("customerDetail.readiness.runtimeHealth"),
      status: customer.lastHealthStatus === "ok" || customer.provisioningStatus === "active" ? "ready" : "attention",
      detail: customer.lastHealthStatus ? statusLabel(t, customer.lastHealthStatus) : customer.lastHealthError || customer.provisioningStatus || t("customerDetail.readiness.runtimeHealthMissing"),
    },
    {
      label: t("customerDetail.readiness.supportConnector"),
      status: customer.hasSupportCredential && customer.supportConnectorStatus !== "degraded" ? "ready" : "attention",
      detail: customer.hasSupportCredential ? statusLabel(t, customer.supportConnectorStatus) : t("customerDetail.readiness.supportConnectorMissing"),
    },
    {
      label: t("customerDetail.readiness.releaseEvidence"),
      status: customer.releaseImageTag || customer.releaseVersion ? "ready" : "attention",
      detail: customer.releaseImageTag || customer.releaseVersion || t("customerDetail.readiness.releaseEvidenceMissing"),
    },
  ] as const;
}

function JsonPreview({ value }: { value: unknown }) {
  if (!value) return null;
  return (
    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 180, overflow: "auto", background: "var(--gray-2)", padding: 12, borderRadius: 6 }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function MiniMetric({ label, value, detail, toneValue }: { label: string; value: string; detail?: string; toneValue?: string }) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <strong style={{ color: tone(toneValue ?? value) }}>{value}</strong>
      {detail && <div className="muted" style={{ fontSize: 12 }}>{detail}</div>}
    </div>
  );
}

function boolSelectDefault(value: boolean | null | undefined) {
  return value ? "true" : "false";
}

export default async function ControlPlaneCustomerPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = await params;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor, { deploymentId });
  } catch {
    notFound();
  }
  const [customer, integrations, context, aiGovernance, releases, format, t] = await Promise.all([
    getControlPlaneDeployment(actor, deploymentId),
    getControlPlaneIntegrationStatus(actor, deploymentId),
    getControlPlaneContextHealth(actor, deploymentId),
    getControlPlaneAiGovernanceStatus(actor, deploymentId),
    getControlPlaneReleaseStatus(actor, deploymentId),
    getFormatter(),
    getTranslations("controlPlane"),
  ]).catch((error: unknown) => {
    if (error instanceof AppError && error.status === 404) {
      notFound();
    }
    throw error;
  });
  const contextBrainSources = Array.isArray(context.sources) ? [] : context.sources.brain;
  const contextExternalSources = Array.isArray(context.sources) ? [] : context.sources.external;
  const meetingRecorder = integrations.integrations.find((integration) => integration.key === "meeting_recorders") as MeetingRecorderIntegration | undefined;
  const checks = readinessChecks(customer, t);
  const readinessStatus = checks.every((check) => check.status === "ready") ? "ready" : "attention";
  const failedOperations = customer.supportOperations.filter((operation) => operation.status === "FAILED").length;
  const mutatingOperations = customer.supportOperations.filter((operation) => operation.action !== "members.list" && operation.action !== "integrations.list").length;
  const aiSummary = aiGovernance.summary;
  const releasePrep = releases.recentPreparations[0];
  const mcpUrl = customer.supportMcpUrl || `${customer.url.replace(/\/$/, "")}/api/mcp`;

  return (
    <main className="control-plane-shell">
      <aside className="control-plane-rail stack">
        <Link href="/control-plane" className="muted">{t("customerDetail.backToFleet")}</Link>
        <strong>{customer.label}</strong>
        {CUSTOMER_SECTION_IDS.map((id) => (
          <a key={id} className="ws-nav-link" href={`#${id}`}>
            <span className="ws-nav-icon">◇</span>
            {t(`sections.${id}.label` as any)}
          </a>
        ))}
        <ControlPlaneLanguageSwitcher />
      </aside>

      <div className="control-plane-content stack">
        <header className="page-header">
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>{t("customerDetail.eyebrow")}</p>
            <h1 className="title-lg" style={{ margin: 0 }}>{customer.label}</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>{customer.url}</p>
          </div>
          <div className="actions-inline">
            <a className="link-button small" href={customer.url} target="_blank" rel="noreferrer">{t("customerDetail.openCustomer")}</a>
            {customer.hasSupportCredential && (
              <form action={refreshSupportSnapshotAction}>
                <input type="hidden" name="deploymentId" value={customer.id} />
                <button type="submit" className="button secondary small">{t("customerDetail.refreshSnapshot")}</button>
              </form>
            )}
          </div>
        </header>

        <section id="fleet" className="stack" style={{ gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
            <MiniMetric label={t("customerDetail.metrics.readiness")} value={statusLabel(t, readinessStatus)} toneValue={readinessStatus} detail={t("customerDetail.metrics.openGaps", { count: checks.filter((check) => check.status === "attention").length })} />
            <MiniMetric label={t("customerDetail.metrics.runtime")} value={statusLabel(t, customer.lastHealthStatus || customer.provisioningStatus || "unknown")} toneValue={customer.lastHealthStatus || customer.provisioningStatus || "unknown"} detail={customer.lastHealthError || undefined} />
            <MiniMetric label={t("customerDetail.metrics.release")} value={customer.releaseImageTag || customer.releaseVersion || t("status.unknown")} toneValue={customer.releaseImageTag || customer.releaseVersion ? "ready" : "unknown"} detail={customer.lastReleaseCheck ? t("customerDetail.metrics.checkedAt", { date: format.dateTime(customer.lastReleaseCheck, { dateStyle: "medium", timeStyle: "short" }) }) : t("customerDetail.metrics.noReleaseCheck")} />
            <MiniMetric label={t("customerDetail.metrics.support")} value={statusLabel(t, customer.supportConnectorStatus)} toneValue={customer.supportConnectorStatus} detail={customer.supportOwnerEmail || t("customers.noOwner")} />
            <MiniMetric label={t("customerDetail.metrics.residency")} value={customer.region || t("status.notSet")} toneValue={customer.region ? "ready" : "unknown"} detail={customer.dataResidency || t("customerDetail.metrics.noResidencyPolicy")} />
            <MiniMetric label={t("customerDetail.metrics.managedWorkspace")} value={customer.managedWorkspace ? statusLabel(t, "linked") : t("status.remoteOnly")} toneValue={customer.managedWorkspace ? "linked" : "remote"} detail={customer.managedWorkspace?.slug || t("customerDetail.metrics.useSupportConnector")} />
          </div>

          <section className="panel stack" style={{ padding: 20 }}>
            <h2 style={{ margin: 0 }}>{t("customerDetail.healthReadiness.title")}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {checks.map((check) => (
                <div className="item" key={check.label}>
                  <div className="row">
                    <strong>{check.label}</strong>
                    <span style={{ color: tone(check.status), fontWeight: 700 }}>{statusLabel(t, check.status)}</span>
                  </div>
                  <div className="muted">{check.detail}</div>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section id="context" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>{t("sections.context.label")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("customerDetail.context.description")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label={t("customerDetail.context.contextAccess")} value={statusLabel(t, context.accessMode === "managed_workspace" || customer.hasSupportCredential ? "connected" : "pending")} toneValue={context.accessMode === "managed_workspace" || customer.hasSupportCredential ? "connected" : "pending"} detail={context.accessMode === "managed_workspace" ? t("customerDetail.context.managedDataAvailable") : customer.hasSupportCredential ? t("customerDetail.context.useSupportForReads") : t("customerDetail.context.configureSupportFirst")} />
            <MiniMetric label={t("customerDetail.context.brainSources")} value={context.summary ? String(context.summary.brainSources) : statusLabel(t, "remote")} toneValue={context.summary ? "ready" : "remote"} detail={context.summary ? t("customerDetail.context.knowledgeChunks", { count: context.summary.knowledgeChunks }) : t("customerDetail.context.requiresSupportSnapshot")} />
            <MiniMetric label={t("customerDetail.context.externalSources")} value={context.summary ? String(context.summary.externalSources) : statusLabel(t, "remote")} toneValue={context.summary ? "ready" : "remote"} detail={context.summary ? t("customerDetail.context.externalSourceDetail", { stale: context.summary.staleExternalSources, failed: context.summary.failedExternalSources }) : t("customerDetail.context.requiresSupportSnapshot")} />
            <MiniMetric label={t("customerDetail.context.failedSyncJobs")} value={statusLabel(t, context.summary && context.summary.failedSyncJobs > 0 ? "attention" : context.summary ? "ready" : "remote")} toneValue={context.summary && context.summary.failedSyncJobs > 0 ? "attention" : context.summary ? "ready" : "remote"} detail={context.summary ? t("customerDetail.context.failedSyncJobsDetail", { count: context.summary.failedSyncJobs }) : t("customerDetail.context.inspectThroughSupport")} />
            <MiniMetric label={t("customerDetail.context.lastContextPull")} value={statusLabel(t, customer.supportLastSyncAt ? "recorded" : "unknown")} toneValue={customer.supportLastSyncAt ? "recorded" : "unknown"} detail={customer.supportLastSyncAt ? format.dateTime(customer.supportLastSyncAt, { dateStyle: "medium", timeStyle: "short" }) : t("customerDetail.context.noSupportSnapshot")} />
            <MiniMetric label={t("customerDetail.context.ingestionRisk")} value={statusLabel(t, context.summary && (context.summary.failedExternalSources > 0 || context.summary.failedSyncJobs > 0) ? "degraded" : context.summary ? "ready" : customer.supportLastSyncError ? "degraded" : "unknown")} toneValue={context.summary && (context.summary.failedExternalSources > 0 || context.summary.failedSyncJobs > 0) ? "degraded" : context.summary ? "ready" : customer.supportLastSyncError ? "degraded" : "unknown"} detail={customer.supportLastSyncError || t("customerDetail.context.noSupportConnectorError")} />
          </div>
          {context.accessMode === "managed_workspace" ? (
            <div className="stack" style={{ gap: 16 }}>
              <div className="row">
                <div>
                  <strong>{t("customerDetail.context.operationsTitle")}</strong>
                  <p className="muted" style={{ margin: "4px 0 0" }}>
                    {t("customerDetail.context.operationsDescription")}
                  </p>
                </div>
                {context.managedWorkspace && (
                  <Link className="link-button small" href={`/workspaces/${context.managedWorkspace.id}/brain`}>
                    {t("customerDetail.context.openBrain")}
                  </Link>
                )}
              </div>
              <form action={runContextOperationAction} className="item stack">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  <label>
                    {t("customerDetail.context.operationLabel")}
                    <select name="operation" defaultValue="sync_all">
                      <option value="sync_all">{t("customerDetail.context.syncAllSources")}</option>
                      <option value="sync_source">{t("customerDetail.context.syncSelectedSource")}</option>
                      <option value="disable_source">{t("customerDetail.context.disableSelectedSource")}</option>
                    </select>
                  </label>
                  <label>
                    {t("customerDetail.context.sourceLabel")}
                    <select name="sourceId" defaultValue="">
                      <option value="">{t("customerDetail.context.allActiveSources")}</option>
                      {contextExternalSources.map((source) => (
                        <option key={source.id} value={source.id}>{source.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("customerDetail.forms.reason")}
                    <input name="reason" required placeholder={t("customerDetail.context.reasonPlaceholder")} />
                  </label>
                </div>
                <button type="submit" disabled={contextExternalSources.length === 0}>{t("customerDetail.context.runOperation")}</button>
              </form>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
                <section className="item" style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                    <strong>{t("customerDetail.context.externalContextSources")}</strong>
                  </div>
                  <div className="list">
                    {contextExternalSources.map((source) => (
                      <div className="item" key={source.id}>
                        <div className="row">
                          <div>
                            <strong>{source.label}</strong>
                            <div className="muted">{t("customerDetail.context.sourceCadence", { driver: source.driverType, minutes: source.pullCadenceMinutes })}</div>
                          </div>
                          <span style={{ color: tone(source.lastSyncError ? "degraded" : source.isActive ? "active" : "disabled"), fontWeight: 700 }}>
                            {statusLabel(t, source.lastSyncError ? "degraded" : source.isActive ? "active" : "disabled")}
                          </span>
                        </div>
                        <div className="muted">
                          {t("customerDetail.context.lastSync", { date: source.lastSyncAt ? format.dateTime(source.lastSyncAt, { dateStyle: "medium", timeStyle: "short" }) : t("status.never") })}
                          {source.lastSyncError ? ` - ${source.lastSyncError}` : ""}
                        </div>
                        {source.syncLogs.length > 0 && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {source.syncLogs[0]?.error
                              ? t("customerDetail.context.latestLogError", { error: source.syncLogs[0]?.error })
                              : t("customerDetail.context.latestLogRows", { rows: source.syncLogs[0]?.rowsProcessed ?? 0, chunks: source.syncLogs[0]?.chunksCreated ?? 0 })}
                          </div>
                        )}
                      </div>
                    ))}
                    {contextExternalSources.length === 0 && (
                      <p className="muted" style={{ padding: 16 }}>{t("customerDetail.context.noExternalSources")}</p>
                    )}
                  </div>
                </section>

                <section className="item" style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                    <strong>{t("customerDetail.context.recentBrainSources")}</strong>
                  </div>
                  <div className="list">
                    {contextBrainSources.map((source) => (
                      <div className="item" key={source.id}>
                        <div className="row">
                          <strong>{source.title || source.sourceType}</strong>
                          <span className="muted">{source.sourceType}</span>
                        </div>
                        <div className="muted">
                          {source.absorbedAt
                            ? t("customerDetail.context.absorbedAt", { date: format.dateTime(source.absorbedAt, { dateStyle: "medium", timeStyle: "short" }) })
                            : t("customerDetail.context.createdAt", { date: format.dateTime(source.createdAt, { dateStyle: "medium", timeStyle: "short" }) })}
                        </div>
                      </div>
                    ))}
                    {contextBrainSources.length === 0 && (
                      <p className="muted" style={{ padding: 16 }}>{t("customerDetail.context.noBrainSources")}</p>
                    )}
                  </div>
                </section>
              </div>

              {context.summary?.recentFailedSyncJobs.length ? (
                <section className="item" style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                    <strong>{t("customerDetail.context.recentFailedSyncJobs")}</strong>
                  </div>
                  <div className="list">
                    {context.summary.recentFailedSyncJobs.map((job) => (
                      <div className="item" key={job.id}>
                        <div className="row">
                          <strong>{job.type}</strong>
                          <span className="muted">{t("customerDetail.context.attempts", { count: job.attempts })}</span>
                        </div>
                        <div className="muted">{job.error || t("customerDetail.context.noErrorRecorded")}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="item">
              <strong>{t("customerDetail.context.remoteOperationsTitle")}</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {t("customerDetail.context.remoteOperationsDescription")}
              </p>
            </div>
          )}
        </section>

        <section id="ai-governance" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>{t("sections.ai-governance.label")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("customerDetail.aiGovernance.description")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label={t("customerDetail.aiGovernance.agentVisibility")} value={statusLabel(t, aiGovernance.accessMode === "managed_workspace" ? "connected" : "remote")} toneValue={aiGovernance.accessMode === "managed_workspace" ? "connected" : "remote"} detail={aiGovernance.accessMode === "managed_workspace" ? t("customerDetail.aiGovernance.localRuns", { count: customer.managedWorkspace?._count.agentRuns ?? 0 }) : t("customerDetail.aiGovernance.remoteRuns")} />
            <MiniMetric label={t("customerDetail.aiGovernance.pendingApprovals")} value={aiSummary ? String(aiSummary.pendingApprovals) : statusLabel(t, "remote")} toneValue={aiSummary ? "ready" : "remote"} detail={aiSummary ? t("customerDetail.aiGovernance.humanApprovalWaits") : t("customerDetail.context.requiresSupportSnapshot")} />
            <MiniMetric label={t("customerDetail.aiGovernance.failedJobs")} value={statusLabel(t, aiSummary && aiSummary.failedJobs > 0 ? "attention" : aiSummary ? "ready" : "remote")} toneValue={aiSummary && aiSummary.failedJobs > 0 ? "attention" : aiSummary ? "ready" : "remote"} detail={aiSummary ? t("customerDetail.aiGovernance.failedJobsDetail", { count: aiSummary.failedJobs }) : t("customerDetail.context.inspectThroughSupport")} />
            <MiniMetric label={t("customerDetail.aiGovernance.modelSpend")} value={aiSummary ? `$${aiSummary.modelUsage.estimatedCostUsd ?? "0"}` : statusLabel(t, "remote")} toneValue={aiSummary ? "ready" : "remote"} detail={aiSummary ? t("customerDetail.aiGovernance.totalTokens", { count: aiSummary.modelUsage.inputTokens + aiSummary.modelUsage.outputTokens }) : t("customerDetail.context.requiresSupportSnapshot")} />
            <MiniMetric label={t("customerDetail.aiGovernance.riskyToolCalls")} value={statusLabel(t, aiSummary && aiSummary.riskyToolCalls.length > 0 ? "attention" : aiSummary ? "ready" : "remote")} toneValue={aiSummary && aiSummary.riskyToolCalls.length > 0 ? "attention" : aiSummary ? "ready" : "remote"} detail={aiSummary ? t("customerDetail.aiGovernance.recentCallsFlagged", { count: aiSummary.riskyToolCalls.length }) : t("customerDetail.aiGovernance.supportConnectorPath")} />
            <MiniMetric label={t("customerDetail.aiGovernance.failedOperations")} value={statusLabel(t, failedOperations > 0 ? "attention" : "ready")} toneValue={failedOperations > 0 ? "attention" : "ready"} detail={t("customerDetail.aiGovernance.failedSupportOperations", { count: failedOperations })} />
          </div>
          {aiSummary ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
              <section className="item" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                  <strong>{t("customerDetail.aiGovernance.recentAgentRuns")}</strong>
                </div>
                <div className="list">
                  {aiSummary.recentRuns.map((run) => (
                    <div className="item" key={run.id}>
                      <div className="row">
                        <div>
                          <strong>{run.agentKey}</strong>
                          <div className="muted">{run.goal}</div>
                        </div>
                        <span style={{ color: tone(run.status), fontWeight: 700 }}>{statusLabel(t, run.status)}</span>
                      </div>
                      <div className="muted">
                        {run.triggerType} - {format.dateTime(run.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                        {run.approvalRequired ? ` - ${t("customerDetail.aiGovernance.approvalRequired")}` : ""}
                      </div>
                    </div>
                  ))}
                  {aiSummary.recentRuns.length === 0 && (
                    <p className="muted" style={{ padding: 16 }}>{t("customerDetail.aiGovernance.noAgentRuns")}</p>
                  )}
                </div>
              </section>

              <section className="item" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                  <strong>{t("customerDetail.aiGovernance.riskAndFailures")}</strong>
                </div>
                <div className="list">
                  {aiSummary.riskyToolCalls.map((call) => (
                    <div className="item" key={call.id}>
                      <div className="row">
                        <div>
                          <strong>{call.name}</strong>
                          <div className="muted">{call.agentRun.agentKey}</div>
                        </div>
                        <span style={{ color: tone(call.status), fontWeight: 700 }}>{statusLabel(t, call.status)}</span>
                      </div>
                      <div className="muted">{call.error || format.dateTime(call.createdAt, { dateStyle: "medium", timeStyle: "short" })}</div>
                    </div>
                  ))}
                  {aiSummary.recentFailedJobs.map((job) => (
                    <div className="item" key={job.id}>
                      <div className="row">
                        <strong>{job.type}</strong>
                        <span style={{ color: tone("FAILED"), fontWeight: 700 }}>{statusLabel(t, "FAILED")}</span>
                      </div>
                      <div className="muted">{job.error || t("customerDetail.context.attempts", { count: job.attempts })}</div>
                    </div>
                  ))}
                  {aiSummary.riskyToolCalls.length === 0 && aiSummary.recentFailedJobs.length === 0 && (
                    <p className="muted" style={{ padding: 16 }}>{t("customerDetail.aiGovernance.noRiskOrFailures")}</p>
                  )}
                </div>
              </section>
            </div>
          ) : (
            <div className="item">
              <strong>{t("customerDetail.aiGovernance.remoteTitle")}</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {t("customerDetail.aiGovernance.remoteDescription")}
              </p>
            </div>
          )}
        </section>

        <section id="integrations" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>{t("customerDetail.integrations.title")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("customerDetail.integrations.description")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label={t("customerDetail.integrations.meetingRecorderEntitlement")} value={statusLabel(t, meetingRecorder?.entitlementEnabled ? "active" : "disabled")} toneValue={meetingRecorder?.entitlementEnabled ? "active" : "disabled"} detail={meetingRecorder?.provider || t("customerDetail.integrations.noProviderSelected")} />
            <MiniMetric label={t("customerDetail.integrations.recorderStatus")} value={statusLabel(t, meetingRecorder?.status || "unknown")} toneValue={meetingRecorder?.status || "unknown"} detail={meetingRecorder?.autoRecordEnabled ? t("customerDetail.integrations.autoRecordingOn") : t("customerDetail.integrations.autoRecordingOff")} />
            <MiniMetric label={t("customerDetail.integrations.recorderUsage")} value={t("customerDetail.integrations.minutes", { count: meetingRecorder?.usage?.usedMinutes ?? 0 })} toneValue="ready" detail={t("customerDetail.integrations.monthlyCap", { count: meetingRecorder?.monthlyMinuteCap ?? 0 })} />
            <MiniMetric label={t("customerDetail.integrations.recorderFailures")} value={statusLabel(t, (meetingRecorder?.failures ?? 0) > 0 ? "attention" : "ready")} toneValue={(meetingRecorder?.failures ?? 0) > 0 ? "attention" : "ready"} detail={t("customerDetail.integrations.failedRecordings", { count: meetingRecorder?.failures ?? 0 })} />
            <MiniMetric label={t("customerDetail.integrations.calendarAndSlack")} value={statusLabel(t, customer.managedWorkspace || customer.hasSupportCredential ? "inspectable" : "pending")} toneValue={customer.managedWorkspace || customer.hasSupportCredential ? "inspectable" : "pending"} detail={customer.managedWorkspace ? t("customerDetail.integrations.localCommunicationInstalls", { count: customer.managedWorkspace._count.communicationInstallations }) : t("customerDetail.integrations.supportCanReadState")} />
            <MiniMetric label={t("customerDetail.integrations.supportConnector")} value={statusLabel(t, customer.hasSupportCredential ? customer.supportConnectorStatus : "pending")} toneValue={customer.hasSupportCredential ? customer.supportConnectorStatus : "pending"} detail={customer.supportLastSyncAt ? t("customerDetail.integrations.lastSnapshot", { date: format.dateTime(customer.supportLastSyncAt, { dateStyle: "medium", timeStyle: "short" }) }) : t("customerDetail.integrations.noSnapshot")} />
          </div>
          {customer.managedWorkspace && meetingRecorder ? (
            <form action={configureMeetingRecorderIntegrationAction} className="panel stack" style={{ padding: 16, marginTop: 4 }}>
              <input type="hidden" name="deploymentId" value={customer.id} />
              <div className="row">
                <div>
                  <strong>{t("customerDetail.integrations.meetingRecorderManagement")}</strong>
                  <p className="muted" style={{ margin: "4px 0 0" }}>
                    {t("customerDetail.integrations.meetingRecorderManagementDescription")}
                  </p>
                </div>
                <span className="tag">{meetingRecorder.vendorReadiness ? t("customerDetail.integrations.vendorReady") : t("customerDetail.integrations.needsReadiness")}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <label>
                  {t("customerDetail.integrations.entitlement")}
                  <select name="entitlementEnabled" defaultValue={boolSelectDefault(meetingRecorder.entitlementEnabled)}>
                    <option value="true">{t("status.enabled")}</option>
                    <option value="false">{t("status.disabled")}</option>
                  </select>
                </label>
                <label>
                  {t("customerDetail.integrations.recorderState")}
                  <select name="enabled" defaultValue={meetingRecorder.status === "enabled" ? "true" : "false"}>
                    <option value="true">{t("status.enabled")}</option>
                    <option value="false">{t("status.disabled")}</option>
                  </select>
                </label>
                <label>
                  {t("customerDetail.integrations.autoRecording")}
                  <select name="autoRecordEnabled" defaultValue={boolSelectDefault(meetingRecorder.autoRecordEnabled)}>
                    <option value="true">{t("status.on")}</option>
                    <option value="false">{t("status.off")}</option>
                  </select>
                </label>
                <label>
                  {t("customerDetail.integrations.primaryProvider")}
                  <select name="defaultProvider" defaultValue={meetingRecorder.provider || "RECALL_AI"}>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
                <label>
                  {t("customerDetail.integrations.fallbackProvider")}
                  <select name="fallbackProvider" defaultValue={meetingRecorder.fallbackProvider || ""}>
                    <option value="">{t("status.none")}</option>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
                <label>
                  {t("customerDetail.integrations.monthlyMinuteCap")}
                  <input name="monthlyMinuteCap" type="number" min="0" defaultValue={meetingRecorder.monthlyMinuteCap ?? 6000} />
                </label>
                <label>
                  {t("customerDetail.integrations.botName")}
                  <input name="botName" defaultValue={meetingRecorder.botName || "Corgtex Recorder"} />
                </label>
                <label>
                  {t("customerDetail.forms.mutationReason")}
                  <input name="reason" required placeholder={t("customerDetail.integrations.reasonPlaceholder")} />
                </label>
              </div>
              <label>
                {t("customerDetail.integrations.entryMessage")}
                <textarea name="entryMessage" defaultValue={meetingRecorder.entryMessage || ""} rows={3} />
              </label>
              <button type="submit">{t("customerDetail.integrations.saveRecorderEntitlement")}</button>
            </form>
          ) : (
            <div className="item">
              <strong>{t("customerDetail.integrations.meetingRecorderManagement")}</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {t("customerDetail.integrations.linkManagedWorkspace")}
              </p>
            </div>
          )}
        </section>

        <section id="releases" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>{t("customerDetail.releases.title")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label={t("customerDetail.releases.currentRelease")} value={releases.current.releaseImageTag || releases.current.releaseVersion || t("status.unknown")} toneValue={releases.current.releaseImageTag || releases.current.releaseVersion ? "ready" : "unknown"} detail={releases.current.releaseVersion || undefined} />
            <MiniMetric label={t("customerDetail.releases.provisioning")} value={statusLabel(t, releases.provisioning.status || "draft")} toneValue={releases.provisioning.status || "draft"} detail={releases.provisioning.lastProvisioningError || undefined} />
            <MiniMetric label={t("customerDetail.releases.health")} value={statusLabel(t, releases.health.lastHealthStatus || "unknown")} toneValue={releases.health.lastHealthStatus || "unknown"} detail={releases.health.lastHealthError || t("customerDetail.releases.noRuntimeError")} />
            <MiniMetric label={t("customerDetail.releases.drift")} value={statusLabel(t, releases.current.releaseDrift ? "attention" : "ready")} toneValue={releases.current.releaseDrift ? "attention" : "ready"} detail={releases.current.releaseDrift || t("customerDetail.releases.noDrift")} />
            <MiniMetric label={t("customerDetail.releases.rollbackReadiness")} value={statusLabel(t, releases.rollbackReady ? "ready" : "attention")} toneValue={releases.rollbackReady ? "ready" : "attention"} detail={releases.rollbackReady ? t("customerDetail.releases.rollbackReady") : t("customerDetail.releases.rollbackNeedsEvidence")} />
            <MiniMetric label={t("customerDetail.releases.lastPreparation")} value={statusLabel(t, releasePrep ? "recorded" : "none")} toneValue={releasePrep ? "recorded" : "none"} detail={releasePrep ? format.dateTime(releasePrep.createdAt, { dateStyle: "medium", timeStyle: "short" }) : t("customerDetail.releases.noPreparation")} />
          </div>
          <form action={runReleaseOperationAction} className="item stack">
            <input type="hidden" name="deploymentId" value={customer.id} />
            <input type="hidden" name="operation" value="prepare_upgrade" />
            <div className="row">
              <div>
                <strong>{t("customerDetail.releases.prepareUpgrade")}</strong>
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  {t("customerDetail.releases.prepareUpgradeDescription")}
                </p>
              </div>
              <span className="tag">{releases.accessMode === "managed_workspace" ? t("customerDetail.releases.managedWorkspaceLinked") : t("customerDetail.releases.centralDeploymentRecord")}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label>
                {t("customerDetail.releases.targetImageTag")}
                <input name="targetReleaseImageTag" required placeholder={releases.current.releaseImageTag || t("customerDetail.releases.targetImageTagPlaceholder")} />
              </label>
              <label>
                {t("customerDetail.releases.targetVersion")}
                <input name="targetReleaseVersion" placeholder={releases.current.releaseVersion || t("customerDetail.releases.targetVersionPlaceholder")} />
              </label>
              <label>
                {t("customerDetail.forms.mutationReason")}
                <input name="reason" required placeholder={t("customerDetail.releases.reasonPlaceholder")} />
              </label>
            </div>
            <button type="submit">{t("customerDetail.releases.recordUpgradePreparation")}</button>
          </form>
          {releases.recentPreparations.length > 0 && (
            <section className="item" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}>
                <strong>{t("customerDetail.releases.recentPreparationAudit")}</strong>
              </div>
              <div className="list">
                {releases.recentPreparations.map((event) => (
                  <div className="item" key={event.id}>
                    <div className="row">
                      <strong>{event.action}</strong>
                      <span className="muted">{format.dateTime(event.createdAt, { dateStyle: "medium", timeStyle: "short" })}</span>
                    </div>
                    <JsonPreview value={event.meta} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>

        <section id="support" className="stack" style={{ gap: 20 }}>
          <div className="control-plane-support-grid">
            <section className="panel stack" style={{ padding: 20 }}>
              <h2 style={{ margin: 0 }}>{t("customerDetail.support.connectorTitle")}</h2>
              <p className="muted" style={{ margin: 0 }}>{t("customerDetail.support.connectorDescription")}</p>
              <form action={configureSupportConnectorAction} className="stack">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <label>
                  {t("customerDetail.support.baseUrl")}
                  <input name="supportBaseUrl" defaultValue={customer.supportBaseUrl || customer.url} />
                </label>
                <label>
                  {t("customerDetail.support.mcpUrl")}
                  <input name="supportMcpUrl" defaultValue={mcpUrl} />
                </label>
                <label>
                  {t("customerDetail.support.credentialLabel")}
                  <input name="supportCredentialLabel" defaultValue={customer.supportCredentialLabel || "Corgtex Support"} />
                </label>
                <label>
                  {t("customerDetail.support.supportCredential")}
                  <input name="supportCredential" type="password" placeholder={customer.hasSupportCredential ? t("customerDetail.support.credentialConfiguredPlaceholder") : t("customerDetail.support.credentialNewPlaceholder")} required={!customer.hasSupportCredential} />
                </label>
                <label>
                  {t("customerDetail.support.notes")}
                  <textarea name="supportNotes" defaultValue={customer.supportNotes || ""} />
                </label>
                <button type="submit">{t("customerDetail.support.saveConnector")}</button>
              </form>
            </section>

            <section className="panel stack" style={{ padding: 20 }}>
              <h2 style={{ margin: 0 }}>{t("customerDetail.support.runOperationTitle")}</h2>
              <p className="muted" style={{ margin: 0 }}>{t("customerDetail.support.runOperationDescription")}</p>
              <form action={runSupportOperationAction} className="stack">
                <input type="hidden" name="deploymentId" value={customer.id} />
                <label>
                  {t("customerDetail.support.action")}
                  <select name="action" defaultValue="members.list">
                    {SUPPORT_ACTIONS.map(([value, labelKey]) => (
                      <option key={value} value={value}>{t(`customerDetail.support.actions.${labelKey}` as any)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("customerDetail.forms.reason")}
                  <input name="reason" placeholder={t("customerDetail.support.reasonPlaceholder")} />
                </label>
                <label>
                  {t("customerDetail.support.remoteWorkspaceId")}
                  <input name="remoteWorkspaceId" placeholder={t("customerDetail.support.remoteWorkspacePlaceholder")} />
                </label>
                <label>
                  {t("customerDetail.support.argumentsJson")}
                  <textarea name="argumentsJson" defaultValue="{}" style={{ minHeight: 180, fontFamily: "var(--font-mono, monospace)" }} />
                </label>
                <details>
                  <summary className="muted">{t("customerDetail.support.commonArgumentTemplates")}</summary>
                  <div className="stack" style={{ marginTop: 12 }}>
                    {SUPPORT_ACTIONS.map(([value, labelKey, hintKey]) => (
                      <div key={value}>
                        <strong>{t(`customerDetail.support.actions.${labelKey}` as any)}</strong>
                        <p className="muted" style={{ margin: "4px 0 0" }}>
                          {t(`customerDetail.support.argumentHints.${hintKey}` as any)}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
                <button type="submit" disabled={!customer.hasSupportCredential}>{t("customerDetail.support.runOperation")}</button>
              </form>
            </section>
          </div>

          <section className="panel stack" style={{ padding: 20 }}>
            <h2 style={{ margin: 0 }}>{t("customerDetail.support.breakGlassTitle")}</h2>
            <form action={recordBreakGlassAction} className="stack">
              <input type="hidden" name="deploymentId" value={customer.id} />
              <label>
                {t("customerDetail.forms.reason")}
                <input name="reason" required placeholder={t("customerDetail.support.breakGlassReasonPlaceholder")} />
              </label>
              <label>
                {t("customerDetail.support.notes")}
                <textarea name="notes" required placeholder={t("customerDetail.support.breakGlassNotesPlaceholder")} />
              </label>
              <button type="submit" className="secondary">{t("customerDetail.support.recordBreakGlassNote")}</button>
            </form>
          </section>
        </section>

        <section id="audit" className="stack" style={{ gap: 20 }}>
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 20, borderBottom: "1px solid var(--border-color)" }}>
              <h2 style={{ margin: 0 }}>{t("customerDetail.audit.supportOperations")}</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>{t("customerDetail.audit.mutatingOperations", { count: mutatingOperations })}</p>
            </div>
            <div className="list">
              {customer.supportOperations.map((operation) => (
                <div className="item" key={operation.id}>
                  <div className="row">
                    <div>
                      <strong>{operation.action}</strong>
                      <div className="muted">{operation.reason}</div>
                    </div>
                    <span style={{ color: tone(operation.status), fontWeight: 700 }}>{statusLabel(t, operation.status)}</span>
                  </div>
                  <div className="muted">
                    {format.dateTime(operation.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                    {operation.error ? ` - ${operation.error}` : ""}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
                    <JsonPreview value={operation.inputSummary} />
                    <JsonPreview value={operation.resultSummary} />
                  </div>
                </div>
              ))}
              {customer.supportOperations.length === 0 && (
                <p className="muted" style={{ padding: 20 }}>{t("operationHistory.empty")}</p>
              )}
            </div>
          </section>

          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 20, borderBottom: "1px solid var(--border-color)" }}>
              <h2 style={{ margin: 0 }}>{t("customerDetail.audit.customerDeploymentEvents")}</h2>
            </div>
            <div className="list">
              {customer.events.map((event) => (
                <div className="item" key={event.id}>
                  <div className="row">
                    <strong>{event.action}</strong>
                    <span className="muted">{format.dateTime(event.createdAt, { dateStyle: "medium", timeStyle: "short" })}</span>
                  </div>
                  <JsonPreview value={event.meta} />
                </div>
              ))}
              {customer.events.length === 0 && (
                <p className="muted" style={{ padding: 20 }}>{t("customerDetail.audit.noCustomerDeploymentEvents")}</p>
              )}
            </div>
          </section>
        </section>

        <section id="mcp" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>{t("customerDetail.mcp.title")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("customerDetail.mcp.description")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <MiniMetric label={t("customerDetail.mcp.customerMcpUrl")} value={statusLabel(t, customer.hasSupportCredential ? "configured" : "pending")} toneValue={customer.hasSupportCredential ? "configured" : "pending"} detail={mcpUrl} />
            <MiniMetric label={t("customerDetail.mcp.supportOperations")} value={String(customer.supportOperations.length)} toneValue={customer.supportOperations.length > 0 ? "ready" : "unknown"} detail={t("customerDetail.mcp.supportOperationsDetail", { failed: failedOperations })} />
            <MiniMetric label={t("customerDetail.mcp.centralEndpoint")} value={statusLabel(t, "available")} toneValue="available" detail="/api/control-plane/mcp" />
          </div>
        </section>
      </div>
    </main>
  );
}
