import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { getControlPlaneCustomer, getControlPlaneIntegrationStatus, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  configureMeetingRecorderIntegrationAction,
  configureSupportConnectorAction,
  recordBreakGlassAction,
  refreshSupportSnapshotAction,
  runSupportOperationAction,
} from "../../actions";

export const dynamic = "force-dynamic";

const CUSTOMER_SECTIONS = [
  ["fleet", "Fleet"],
  ["context", "Context & Brain"],
  ["ai-governance", "AI Governance"],
  ["integrations", "Integrations"],
  ["releases", "Releases"],
  ["support", "Support"],
  ["audit", "Audit"],
  ["mcp", "MCP/CLI"],
] as const;

const SUPPORT_ACTIONS = [
  ["members.list", "List members", "{}"],
  ["members.invite", "Invite member", "{\n  \"email\": \"person@example.com\",\n  \"displayName\": \"Person Name\",\n  \"role\": \"CONTRIBUTOR\"\n}"],
  ["members.deactivate", "Deactivate member", "{\n  \"memberId\": \"member-id\"\n}"],
  ["integrations.list", "Inspect integrations", "{}"],
  ["data_feeds.list", "Inspect data feeds", "{}"],
  ["data_feeds.sync", "Sync data feed", "{\n  \"sourceId\": \"source-id\"\n}"],
  ["tool_links.list", "Inspect tool links", "{}"],
  ["tool_links.upsert", "Upsert tool link", "{\n  \"title\": \"Miro board\",\n  \"url\": \"https://miro.com/app/board/example\",\n  \"category\": \"WHITEBOARD\",\n  \"accessNotesMd\": \"Use the shared board password.\",\n  \"credentialLabel\": \"Board password\",\n  \"credentialSecret\": \"replace with access code\"\n}"],
  ["tool_links.archive", "Archive tool link", "{\n  \"toolLinkId\": \"tool-link-id\",\n  \"reason\": \"No longer used\"\n}"],
  ["agents.list_runs", "Inspect agent runs", "{\n  \"take\": 10\n}"],
  ["runtime.list_failed_jobs", "List failed jobs", "{\n  \"take\": 20\n}"],
  ["runtime.retry_failed_job", "Retry failed job", "{\n  \"workflowJobId\": \"job-id\"\n}"],
  ["runtime.discard_failed_job", "Discard failed job", "{\n  \"workflowJobId\": \"job-id\"\n}"],
  ["documents.upload_text", "Upload text document", "{\n  \"title\": \"Support upload\",\n  \"textContent\": \"Paste customer data here\"\n}"],
] as const;

type ControlPlaneCustomer = Awaited<ReturnType<typeof getControlPlaneCustomer>>;
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

function readinessChecks(customer: ControlPlaneCustomer) {
  return [
    {
      label: "Customer record",
      status: customer.customerSlug && customer.url ? "ready" : "attention",
      detail: customer.customerSlug || customer.url ? customer.customerSlug || customer.url : "Customer slug or URL is missing.",
    },
    {
      label: "Managed workspace",
      status: customer.managedWorkspace ? "ready" : "attention",
      detail: customer.managedWorkspace ? `${customer.managedWorkspace.name} / ${customer.managedWorkspace.slug}` : "No in-deployment workspace link is recorded.",
    },
    {
      label: "Deployment residency",
      status: customer.region && customer.dataResidency ? "ready" : "attention",
      detail: [customer.region, customer.dataResidency].filter(Boolean).join(" / ") || "Region and residency are not fully set.",
    },
    {
      label: "Runtime health",
      status: customer.lastHealthStatus === "ok" || customer.provisioningStatus === "active" ? "ready" : "attention",
      detail: customer.lastHealthStatus || customer.lastHealthError || customer.provisioningStatus || "No runtime health has been recorded.",
    },
    {
      label: "Support connector",
      status: customer.hasSupportCredential && customer.supportConnectorStatus !== "degraded" ? "ready" : "attention",
      detail: customer.hasSupportCredential ? customer.supportConnectorStatus : "Encrypted support credential is not configured.",
    },
    {
      label: "Release evidence",
      status: customer.releaseImageTag || customer.releaseVersion ? "ready" : "attention",
      detail: customer.releaseImageTag || customer.releaseVersion || "Current release is unknown.",
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

function MiniMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <strong style={{ color: tone(value) }}>{value}</strong>
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
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor, { instanceId });
  } catch {
    notFound();
  }
  const [customer, integrations, format] = await Promise.all([
    getControlPlaneCustomer(actor, instanceId),
    getControlPlaneIntegrationStatus(actor, instanceId),
    getFormatter(),
  ]);
  const meetingRecorder = integrations.integrations.find((integration) => integration.key === "meeting_recorders") as MeetingRecorderIntegration | undefined;
  const checks = readinessChecks(customer);
  const readinessStatus = checks.every((check) => check.status === "ready") ? "ready" : "attention";
  const failedOperations = customer.supportOperations.filter((operation) => operation.status === "FAILED").length;
  const mutatingOperations = customer.supportOperations.filter((operation) => operation.action !== "members.list" && operation.action !== "integrations.list").length;
  const mcpUrl = customer.supportMcpUrl || `${customer.url.replace(/\/$/, "")}/api/mcp`;

  return (
    <main className="control-plane-shell">
      <aside className="control-plane-rail stack">
        <Link href="/control-plane" className="muted">Back to fleet</Link>
        <strong>{customer.label}</strong>
        {CUSTOMER_SECTIONS.map(([id, label]) => (
          <a key={id} className="ws-nav-link" href={`#${id}`}>
            <span className="ws-nav-icon">◇</span>
            {label}
          </a>
        ))}
      </aside>

      <div className="control-plane-content stack">
        <header className="page-header">
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>Customer control plane</p>
            <h1 className="title-lg" style={{ margin: 0 }}>{customer.label}</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>{customer.url}</p>
          </div>
          <div className="actions-inline">
            <a className="button secondary small" href={customer.url} target="_blank" rel="noreferrer">Open customer</a>
            {customer.hasSupportCredential && (
              <form action={refreshSupportSnapshotAction}>
                <input type="hidden" name="instanceId" value={customer.id} />
                <button type="submit" className="button secondary small">Refresh support snapshot</button>
              </form>
            )}
          </div>
        </header>

        <section id="fleet" className="stack" style={{ gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
            <MiniMetric label="Readiness" value={readinessStatus} detail={`${checks.filter((check) => check.status === "attention").length} open gaps`} />
            <MiniMetric label="Runtime" value={customer.lastHealthStatus || customer.provisioningStatus || "unknown"} detail={customer.lastHealthError || undefined} />
            <MiniMetric label="Release" value={customer.releaseImageTag || customer.releaseVersion || "unknown"} detail={customer.lastReleaseCheck ? `Checked ${format.dateTime(customer.lastReleaseCheck, { dateStyle: "medium", timeStyle: "short" })}` : "No release check"} />
            <MiniMetric label="Support" value={customer.supportConnectorStatus} detail={customer.supportOwnerEmail || "No owner"} />
            <MiniMetric label="Residency" value={customer.region || "not set"} detail={customer.dataResidency || "No residency policy"} />
            <MiniMetric label="Managed workspace" value={customer.managedWorkspace ? "linked" : "remote only"} detail={customer.managedWorkspace?.slug || "Use support connector for live customer reads"} />
          </div>

          <section className="panel stack" style={{ padding: 20 }}>
            <h2 style={{ margin: 0 }}>Health and readiness</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {checks.map((check) => (
                <div className="item" key={check.label}>
                  <div className="row">
                    <strong>{check.label}</strong>
                    <span style={{ color: tone(check.status), fontWeight: 700 }}>{check.status}</span>
                  </div>
                  <div className="muted">{check.detail}</div>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section id="context" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>Context & Brain</h2>
          <p className="muted" style={{ margin: 0 }}>
            This customer view is prepared for source freshness, provenance, permissions coverage, retention, and ingestion errors.
            Live source and ingestion reads come from the managed workspace link when present, otherwise through the support connector.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label="Context access" value={customer.managedWorkspace || customer.hasSupportCredential ? "connected" : "pending"} detail={customer.managedWorkspace ? "Managed workspace data is available locally." : customer.hasSupportCredential ? "Snapshot can inspect data sources." : "Configure support connector first."} />
            <MiniMetric label="Brain articles" value={customer.managedWorkspace ? String(customer.managedWorkspace._count.brainArticles) : "remote"} detail={customer.managedWorkspace ? "Local managed workspace count" : "Requires support snapshot"} />
            <MiniMetric label="Data sources" value={customer.managedWorkspace ? String(customer.managedWorkspace._count.externalDataSources) : "remote"} detail={customer.managedWorkspace ? "Local managed workspace count" : "Requires support snapshot"} />
            <MiniMetric label="Last context pull" value={customer.supportLastSyncAt ? "recorded" : "unknown"} detail={customer.supportLastSyncAt ? format.dateTime(customer.supportLastSyncAt, { dateStyle: "medium", timeStyle: "short" }) : "No support snapshot yet"} />
            <MiniMetric label="Ingestion risk" value={customer.supportLastSyncError ? "degraded" : "unknown"} detail={customer.supportLastSyncError || "Detailed ingestion health lands in the context governance slice."} />
          </div>
        </section>

        <section id="ai-governance" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>AI Governance</h2>
          <p className="muted" style={{ margin: 0 }}>
            Agent runs, model spend, tool permissions, approval waits, risky action history, and failed jobs belong here.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label="Agent visibility" value={customer.managedWorkspace || customer.hasSupportCredential ? "connected" : "pending"} detail={customer.managedWorkspace ? `${customer.managedWorkspace._count.agentRuns} local agent runs recorded.` : "Support operations can inspect agent runs and failed jobs."} />
            <MiniMetric label="Workflow jobs" value={customer.managedWorkspace ? String(customer.managedWorkspace._count.workflowJobs) : "remote"} detail={customer.managedWorkspace ? "Local managed workspace count" : "Requires support snapshot"} />
            <MiniMetric label="Failed operations" value={failedOperations > 0 ? "attention" : "ready"} detail={`${failedOperations} failed support operations`} />
            <MiniMetric label="Human approvals" value="planned" detail="Approval waits are scheduled for the governance slice." />
          </div>
        </section>

        <section id="integrations" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>Enterprise Integrations</h2>
          <p className="muted" style={{ margin: 0 }}>
            Integrations are treated as entitlements with vendor readiness, caps, usage, failures, and audit. Meeting recorders are the first V1 entitlement.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label="Meeting recorder entitlement" value={meetingRecorder?.entitlementEnabled ? "active" : "disabled"} detail={meetingRecorder?.provider || "No provider selected"} />
            <MiniMetric label="Recorder status" value={meetingRecorder?.status || "unknown"} detail={meetingRecorder?.autoRecordEnabled ? "Auto-recording on" : "Auto-recording off"} />
            <MiniMetric label="Recorder usage" value={`${meetingRecorder?.usage?.usedMinutes ?? 0} min`} detail={`${meetingRecorder?.monthlyMinuteCap ?? 0} minute monthly cap`} />
            <MiniMetric label="Recorder failures" value={(meetingRecorder?.failures ?? 0) > 0 ? "attention" : "ready"} detail={`${meetingRecorder?.failures ?? 0} failed recordings`} />
            <MiniMetric label="Calendar and Slack" value={customer.managedWorkspace || customer.hasSupportCredential ? "inspectable" : "pending"} detail={customer.managedWorkspace ? `${customer.managedWorkspace._count.communicationInstallations} local communication installs.` : "Support connector can read customer-side integration state."} />
            <MiniMetric label="MCP connectors" value="planned" detail="Connector readiness joins the integration catalog slice." />
          </div>
          {customer.managedWorkspace && meetingRecorder ? (
            <form action={configureMeetingRecorderIntegrationAction} className="panel stack" style={{ padding: 16, marginTop: 4 }}>
              <input type="hidden" name="instanceId" value={customer.id} />
              <div className="row">
                <div>
                  <strong>Meeting recorder management</strong>
                  <p className="muted" style={{ margin: "4px 0 0" }}>
                    Provider, caps, auto-recording, usage, and failures are managed here for this customer.
                  </p>
                </div>
                <span className="tag">{meetingRecorder.vendorReadiness ? "Vendor ready" : "Needs readiness"}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <label>
                  Entitlement
                  <select name="entitlementEnabled" defaultValue={boolSelectDefault(meetingRecorder.entitlementEnabled)}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
                <label>
                  Recorder state
                  <select name="enabled" defaultValue={meetingRecorder.status === "enabled" ? "true" : "false"}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
                <label>
                  Auto-recording
                  <select name="autoRecordEnabled" defaultValue={boolSelectDefault(meetingRecorder.autoRecordEnabled)}>
                    <option value="true">On</option>
                    <option value="false">Off</option>
                  </select>
                </label>
                <label>
                  Primary provider
                  <select name="defaultProvider" defaultValue={meetingRecorder.provider || "RECALL_AI"}>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
                <label>
                  Fallback provider
                  <select name="fallbackProvider" defaultValue={meetingRecorder.fallbackProvider || ""}>
                    <option value="">None</option>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
                <label>
                  Monthly minute cap
                  <input name="monthlyMinuteCap" type="number" min="0" defaultValue={meetingRecorder.monthlyMinuteCap ?? 6000} />
                </label>
                <label>
                  Bot name
                  <input name="botName" defaultValue={meetingRecorder.botName || "Corgtex Recorder"} />
                </label>
                <label>
                  Mutation reason
                  <input name="reason" required placeholder="Enterprise recorder entitlement update" />
                </label>
              </div>
              <label>
                Entry message
                <textarea name="entryMessage" defaultValue={meetingRecorder.entryMessage || ""} rows={3} />
              </label>
              <button type="submit">Save recorder entitlement</button>
            </form>
          ) : (
            <div className="item">
              <strong>Meeting recorder management</strong>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Link a managed workspace to edit recorder entitlements from Control Plane. Remote instances can still be inspected through support operations.
              </p>
            </div>
          )}
        </section>

        <section id="releases" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>Release Operations</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <MiniMetric label="Current release" value={customer.releaseImageTag || customer.releaseVersion || "unknown"} detail={customer.releaseVersion || undefined} />
            <MiniMetric label="Provisioning" value={customer.provisioningStatus || "draft"} detail={customer.lastProvisioningError || undefined} />
            <MiniMetric label="Bootstrap" value={customer.bootstrapStatus || "not_started"} detail={customer.bootstrapBundleUri ? "Bootstrap bundle registered" : "No bootstrap bundle"} />
            <MiniMetric label="Rollback readiness" value="planned" detail="Reasoned upgrade and rollback audit trails land in the release slice." />
          </div>
        </section>

        <section id="support" className="stack" style={{ gap: 20 }}>
          <div className="control-plane-support-grid">
            <section className="panel stack" style={{ padding: 20 }}>
              <h2 style={{ margin: 0 }}>Support Connector</h2>
              <p className="muted" style={{ margin: 0 }}>Store an encrypted support credential for this customer. The token is never shown again.</p>
              <form action={configureSupportConnectorAction} className="stack">
                <input type="hidden" name="instanceId" value={customer.id} />
                <label>
                  Base URL
                  <input name="supportBaseUrl" defaultValue={customer.supportBaseUrl || customer.url} />
                </label>
                <label>
                  MCP URL
                  <input name="supportMcpUrl" defaultValue={mcpUrl} />
                </label>
                <label>
                  Credential label
                  <input name="supportCredentialLabel" defaultValue={customer.supportCredentialLabel || "Corgtex Support"} />
                </label>
                <label>
                  Support credential
                  <input name="supportCredential" type="password" placeholder={customer.hasSupportCredential ? "Configured; enter a new token to rotate" : "agentc-..."} required={!customer.hasSupportCredential} />
                </label>
                <label>
                  Notes
                  <textarea name="supportNotes" defaultValue={customer.supportNotes || ""} />
                </label>
                <button type="submit">Save connector</button>
              </form>
            </section>

            <section className="panel stack" style={{ padding: 20 }}>
              <h2 style={{ margin: 0 }}>Run Support Operation</h2>
              <p className="muted" style={{ margin: 0 }}>Mutating actions require a reason and write central and customer-side support audit records.</p>
              <form action={runSupportOperationAction} className="stack">
                <input type="hidden" name="instanceId" value={customer.id} />
                <label>
                  Action
                  <select name="action" defaultValue="members.list">
                    {SUPPORT_ACTIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Reason
                  <input name="reason" placeholder="Pilot support request, failed sync repair, onboarding help..." />
                </label>
                <label>
                  Remote workspace ID
                  <input name="remoteWorkspaceId" placeholder="Optional; stored with the operation audit" />
                </label>
                <label>
                  Arguments JSON
                  <textarea name="argumentsJson" defaultValue="{}" style={{ minHeight: 180, fontFamily: "var(--font-mono, monospace)" }} />
                </label>
                <details>
                  <summary className="muted">Common argument templates</summary>
                  <div className="stack" style={{ marginTop: 12 }}>
                    {SUPPORT_ACTIONS.slice(1).map(([value, label, template]) => (
                      <div key={value}>
                        <strong>{label}</strong>
                        <JsonPreview value={JSON.parse(template)} />
                      </div>
                    ))}
                  </div>
                </details>
                <button type="submit" disabled={!customer.hasSupportCredential}>Run operation</button>
              </form>
            </section>
          </div>

          <section className="panel stack" style={{ padding: 20 }}>
            <h2 style={{ margin: 0 }}>Break-glass Notes</h2>
            <form action={recordBreakGlassAction} className="stack">
              <input type="hidden" name="instanceId" value={customer.id} />
              <label>
                Reason
                <input name="reason" required placeholder="Why direct infrastructure or database access was needed" />
              </label>
              <label>
                Notes
                <textarea name="notes" required placeholder="What was inspected or changed. Do not paste secrets." />
              </label>
              <button type="submit" className="secondary">Record break-glass note</button>
            </form>
          </section>
        </section>

        <section id="audit" className="stack" style={{ gap: 20 }}>
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 20, borderBottom: "1px solid var(--border-color)" }}>
              <h2 style={{ margin: 0 }}>Support Operations</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>{mutatingOperations} mutating or repair operations recorded for this customer.</p>
            </div>
            <div className="list">
              {customer.supportOperations.map((operation) => (
                <div className="item" key={operation.id}>
                  <div className="row">
                    <div>
                      <strong>{operation.action}</strong>
                      <div className="muted">{operation.reason}</div>
                    </div>
                    <span style={{ color: tone(operation.status), fontWeight: 700 }}>{operation.status}</span>
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
                <p className="muted" style={{ padding: 20 }}>No support operations recorded yet.</p>
              )}
            </div>
          </section>

          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 20, borderBottom: "1px solid var(--border-color)" }}>
              <h2 style={{ margin: 0 }}>Hosted Instance Events</h2>
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
                <p className="muted" style={{ padding: 20 }}>No hosted instance events recorded yet.</p>
              )}
            </div>
          </section>
        </section>

        <section id="mcp" className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>MCP/CLI Access</h2>
          <p className="muted" style={{ margin: 0 }}>
            Codex and operator tooling use the Control Plane API and MCP endpoint. Outputs must remain redacted and mutations must stay reasoned.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <MiniMetric label="Customer MCP URL" value={customer.hasSupportCredential ? "configured" : "pending"} detail={mcpUrl} />
            <MiniMetric label="Current tools" value="available" detail="Customer status, snapshot, and support operations." />
            <MiniMetric label="Next tools" value="planned" detail="Integrations, context health, AI governance, release checks, and upgrades." />
          </div>
        </section>
      </div>
    </main>
  );
}
