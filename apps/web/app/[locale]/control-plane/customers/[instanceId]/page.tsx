import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { getControlPlaneCustomer, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  configureSupportConnectorAction,
  recordBreakGlassAction,
  refreshSupportSnapshotAction,
  runSupportOperationAction,
} from "../../actions";

export const dynamic = "force-dynamic";

const SUPPORT_ACTIONS = [
  ["members.list", "List members", "{}"],
  ["members.invite", "Invite member", "{\n  \"email\": \"person@example.com\",\n  \"displayName\": \"Person Name\",\n  \"role\": \"CONTRIBUTOR\"\n}"],
  ["members.deactivate", "Deactivate member", "{\n  \"memberId\": \"member-id\"\n}"],
  ["integrations.list", "Inspect integrations", "{}"],
  ["data_feeds.list", "Inspect data feeds", "{}"],
  ["data_feeds.sync", "Sync data feed", "{\n  \"sourceId\": \"source-id\"\n}"],
  ["agents.list_runs", "Inspect agent runs", "{\n  \"take\": 10\n}"],
  ["runtime.list_failed_jobs", "List failed jobs", "{\n  \"take\": 20\n}"],
  ["runtime.retry_failed_job", "Retry failed job", "{\n  \"workflowJobId\": \"job-id\"\n}"],
  ["runtime.discard_failed_job", "Discard failed job", "{\n  \"workflowJobId\": \"job-id\"\n}"],
  ["documents.upload_text", "Upload text document", "{\n  \"title\": \"Support upload\",\n  \"textContent\": \"Paste customer data here\"\n}"],
] as const;

function tone(status?: string | null) {
  if (status === "COMPLETED" || status === "ok" || status === "connected" || status === "active") return "var(--green-11)";
  if (status === "RUNNING" || status === "configured" || status === "provisioning") return "var(--orange-11)";
  if (status === "FAILED" || status === "degraded" || status === "down" || status === "suspended") return "var(--red-11)";
  return "var(--gray-11)";
}

function JsonPreview({ value }: { value: unknown }) {
  if (!value) return null;
  return (
    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 180, overflow: "auto", background: "var(--gray-2)", padding: 12, borderRadius: 6 }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
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
  const [customer, format] = await Promise.all([
    getControlPlaneCustomer(actor, instanceId),
    getFormatter(),
  ]);

  return (
    <main className="stack" style={{ padding: 32, maxWidth: 1320, margin: "0 auto" }}>
      <div>
        <Link href="/control-plane" className="muted">Back to control plane</Link>
      </div>

      <header className="page-header">
        <div>
          <p className="muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Customer Support</p>
          <h1 className="title-lg" style={{ margin: 0 }}>{customer.label}</h1>
          <p className="muted">{customer.url}</p>
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

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 16 }}>
        {[
          ["Runtime", customer.lastHealthStatus || customer.provisioningStatus || "unknown"],
          ["Support", customer.supportConnectorStatus],
          ["Release", customer.releaseImageTag || customer.releaseVersion || "unknown"],
          ["Region", customer.region || "not set"],
          ["Owner", customer.supportOwnerEmail || "not set"],
        ].map(([label, value]) => (
          <div className="panel" key={label} style={{ padding: 16 }}>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
            <strong style={{ color: tone(value) }}>{value}</strong>
          </div>
        ))}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 0.9fr) minmax(0, 1.4fr)", gap: 24, alignItems: "start" }}>
        <section className="panel stack" style={{ padding: 20 }}>
          <h2 style={{ margin: 0 }}>Support Connector</h2>
          <p className="muted">Store a broad support credential for this pilot customer. The token is encrypted and never shown again.</p>
          <form action={configureSupportConnectorAction} className="stack">
            <input type="hidden" name="instanceId" value={customer.id} />
            <label>
              Base URL
              <input name="supportBaseUrl" defaultValue={customer.supportBaseUrl || customer.url} />
            </label>
            <label>
              MCP URL
              <input name="supportMcpUrl" defaultValue={customer.supportMcpUrl || `${customer.url.replace(/\/$/, "")}/api/mcp`} />
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
          <p className="muted">Mutating actions require a reason and write central and customer-side support audit records.</p>
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
        <h2 style={{ margin: 0 }}>Break-Glass Notes</h2>
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

      <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: 20, borderBottom: "1px solid var(--border-color)" }}>
          <h2 style={{ margin: 0 }}>Support Operations</h2>
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
                {operation.error ? ` · ${operation.error}` : ""}
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
    </main>
  );
}
