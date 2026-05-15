import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import {
  ALL_SCOPES,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneDeployment,
  requireControlPlaneAccess,
  SCOPE_REGISTRY,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getControlPlaneHref } from "@/lib/control-plane-url";
import {
  revokeControlPlaneAgentCredentialAction,
  updateControlPlaneAgentCredentialScopesAction,
  updateControlPlaneAgentPolicyAction,
  updateControlPlaneModelBudgetAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

type GovernanceStatus = Awaited<ReturnType<typeof getControlPlaneAiGovernanceStatus>>;
type ScopeName = typeof ALL_SCOPES[number];

function statusTone(status?: string | null) {
  if (status === "ready" || status === "COMPLETED" || status === "ok" || status === "connected" || status === "active" || status === "enabled") return "var(--green-11)";
  if (status === "attention" || status === "RUNNING" || status === "configured" || status === "pending" || status === "medium" || status === "low") return "var(--orange-11)";
  if (status === "FAILED" || status === "degraded" || status === "down" || status === "failed" || status === "high") return "var(--red-11)";
  return "var(--gray-11)";
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="panel" style={{ padding: 14 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <strong style={{ color: statusTone(tone ?? value) }}>{value}</strong>
      {detail ? <div className="muted" style={{ fontSize: 12 }}>{detail}</div> : null}
    </div>
  );
}

function formatUsd(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(parsed >= 1 ? 2 : 4)}` : "$0.00";
}

function dateLabel(format: Awaited<ReturnType<typeof getFormatter>>, value: Date | string | null | undefined) {
  if (!value) return "Never";
  return format.dateTime(new Date(value), { dateStyle: "medium", timeStyle: "short" });
}

function scopeGroups() {
  return ALL_SCOPES.reduce<Record<string, ScopeName[]>>((groups, scope) => {
    const group = SCOPE_REGISTRY[scope].group;
    groups[group] = groups[group] ?? [];
    groups[group].push(scope);
    return groups;
  }, {});
}

function SummaryPanel({ status }: { status: GovernanceStatus }) {
  const summary = status.summary;
  const agentRunCount = summary ? Object.values(summary.agentRuns).reduce((sum, count) => sum + Number(count), 0) : 0;
  const activeCredentials = status.access.credentials.filter((credential) => credential.isActive).length;
  return (
    <section id="overview" className="panel stack" style={{ padding: 20 }}>
      <div className="row">
        <div>
          <h2 style={{ margin: 0 }}>Overview</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Production controls for Corgtex agents, MCP credentials, scopes, budgets, risk, and audit.
          </p>
        </div>
        <span className="tag">{status.featureFlag.enabled === false ? "Disabled" : "Enabled"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <Metric label="Access mode" value={status.accessMode} tone={status.hasManagedWorkspace ? "connected" : "remote"} detail={status.managedWorkspace?.name ?? status.remoteSupport.message} />
        <Metric label="Agent runs" value={String(agentRunCount)} tone={agentRunCount > 0 ? "ready" : "unknown"} detail={`${summary?.pendingApprovals ?? 0} waiting for approval`} />
        <Metric label="Active credentials" value={String(activeCredentials)} tone={activeCredentials > 0 ? "ready" : "unknown"} detail={`${status.access.credentials.length} total credentials`} />
        <Metric label="Model spend" value={formatUsd(summary?.modelUsage.estimatedCostUsd)} tone="ready" detail={`${(summary?.modelUsage.inputTokens ?? 0) + (summary?.modelUsage.outputTokens ?? 0)} tokens`} />
        <Metric label="Risk findings" value={String(status.riskFindings.length)} tone={status.riskFindings.some((risk) => risk.severity === "high") ? "high" : status.riskFindings.length ? "attention" : "ready"} detail="deterministic checks" />
      </div>
      {!status.hasManagedWorkspace ? (
        <div className="item">
          <strong>Remote fallback</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>{status.remoteSupport.message}</p>
        </div>
      ) : null}
    </section>
  );
}

function AgentsPanel({ status }: { status: GovernanceStatus }) {
  return (
    <section id="agents" className="panel stack" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Agents</h2>
      <div className="list">
        {status.agents.configs.map((agent) => (
          <div className="item" key={agent.agentKey}>
            <div className="row">
              <div>
                <strong>{agent.label}</strong>
                <div className="muted">{agent.agentKey} / {agent.category}</div>
              </div>
              <span className="tag">{agent.enabled ? "enabled" : "disabled"}</span>
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Model: {agent.modelOverride || `default ${agent.defaultModelTier}`} / Policy: {agent.hasGovernancePolicy ? "configured" : "not set"}
            </div>
            <form action={updateControlPlaneAgentPolicyAction} className="actions-inline" style={{ alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
              <input type="hidden" name="deploymentId" value={status.deploymentId} />
              <input type="hidden" name="agentKey" value={agent.agentKey} />
              <label style={{ minWidth: 220 }}>
                Model override
                <input name="modelOverride" defaultValue={agent.modelOverride ?? ""} placeholder="openrouter/model-id" />
              </label>
              <label style={{ minWidth: 280, flex: "1 1 280px" }}>
                Replacement governance policy
                <textarea name="governancePolicy" rows={2} placeholder={agent.hasGovernancePolicy ? "Leave blank to clear or replace current policy." : "Policy text for this agent."} />
              </label>
              <label style={{ minWidth: 220 }}>
                Reason
                <input name="reason" required placeholder="Customer-approved policy change." />
              </label>
              <button type="submit" className="button secondary small">Save policy</button>
            </form>
          </div>
        ))}
      </div>
    </section>
  );
}

function AccessPanel({ status }: { status: GovernanceStatus }) {
  const groups = scopeGroups();
  return (
    <section id="access" className="panel stack" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Access & MCP</h2>
      <div className="list">
        {status.access.credentials.map((credential) => (
          <div className="item" key={credential.id}>
            <div className="row">
              <div>
                <strong>{credential.label}</strong>
                <div className="muted">{credential.id} / last used {credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleDateString() : "never"}</div>
              </div>
              <span className="tag">{credential.isActive ? "active" : "revoked"}</span>
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              {credential.scopes.length} scopes / {credential.monthlyBudgetCents == null ? "no credential budget" : `$${(credential.monthlyBudgetCents / 100).toFixed(2)} credential budget`} / {credential.dailyCallLimit ?? "no"} daily call limit
            </div>
            {credential.risk.isOverbroad ? (
              <p style={{ color: statusTone("high"), margin: "8px 0 0" }}>
                Sensitive scope review: {(credential.risk.highRisk.length ? credential.risk.highRisk : credential.risk.writeScopes).join(", ")}
              </p>
            ) : null}
            {credential.isActive ? (
              <details style={{ marginTop: 10 }}>
                <summary className="muted">Edit scopes</summary>
                <form action={updateControlPlaneAgentCredentialScopesAction} className="stack" style={{ gap: 12, marginTop: 10 }}>
                  <input type="hidden" name="deploymentId" value={status.deploymentId} />
                  <input type="hidden" name="credentialId" value={credential.id} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    {Object.entries(groups).map(([group, scopes]) => (
                      <fieldset key={group} className="panel" style={{ padding: 12 }}>
                        <legend style={{ fontWeight: 700 }}>{group}</legend>
                        <div className="stack" style={{ gap: 6 }}>
                          {scopes.map((scope) => (
                            <label key={scope} className="actions-inline" style={{ gap: 8 }}>
                              <input type="checkbox" name="scopes" value={scope} defaultChecked={credential.scopes.includes(scope)} />
                              <span>{SCOPE_REGISTRY[scope].label}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                  <label>
                    Reason
                    <input name="reason" required placeholder="Least-privilege scope adjustment." />
                  </label>
                  <button type="submit" className="button secondary small">Update scopes</button>
                </form>
                <form action={revokeControlPlaneAgentCredentialAction} className="actions-inline" style={{ alignItems: "flex-end", marginTop: 12 }}>
                  <input type="hidden" name="deploymentId" value={status.deploymentId} />
                  <input type="hidden" name="credentialId" value={credential.id} />
                  <label style={{ flex: 1 }}>
                    Revocation reason
                    <input name="reason" required placeholder="Credential is no longer approved." />
                  </label>
                  <button type="submit" className="button secondary small">Revoke</button>
                </form>
              </details>
            ) : null}
          </div>
        ))}
        {status.access.credentials.length === 0 ? <p className="muted">No agent credentials are visible for this deployment.</p> : null}
      </div>
    </section>
  );
}

function SpendPanel({ status }: { status: GovernanceStatus }) {
  return (
    <section id="spend" className="panel stack" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Spend</h2>
      <form action={updateControlPlaneModelBudgetAction} className="actions-inline" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <input type="hidden" name="deploymentId" value={status.deploymentId} />
        <label>
          Monthly cap USD
          <input name="monthlyCostCapUsd" type="number" min="0" step="0.01" defaultValue={status.spend.budget?.monthlyCostCapUsd ?? ""} required />
        </label>
        <label>
          Alert threshold
          <input name="alertThresholdPct" type="number" min="1" max="100" defaultValue={status.spend.budget?.alertThresholdPct ?? 80} />
        </label>
        <label>
          Period start day
          <input name="periodStartDay" type="number" min="1" max="31" defaultValue={status.spend.budget?.periodStartDay ?? 1} />
        </label>
        <label style={{ minWidth: 240, flex: "1 1 240px" }}>
          Reason
          <input name="reason" required placeholder="Customer-approved model budget change." />
        </label>
        <button type="submit" className="button secondary small">Update budget</button>
      </form>
      <div className="list">
        {status.spend.recentModelUsage.map((usage) => (
          <div className="item" key={usage.id}>
            <div className="row">
              <strong>{usage.model}</strong>
              <span>{formatUsd(usage.estimatedCostUsd)}</span>
            </div>
            <div className="muted">{usage.provider} / {usage.taskType} / {(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens</div>
          </div>
        ))}
        {status.spend.recentModelUsage.length === 0 ? <p className="muted">No recent model usage is visible.</p> : null}
      </div>
    </section>
  );
}

function ActivityPanel({ status, format }: { status: GovernanceStatus; format: Awaited<ReturnType<typeof getFormatter>> }) {
  const summary = status.summary;
  return (
    <section id="activity" className="panel stack" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Activity & Risk</h2>
      <div className="list">
        {status.riskFindings.map((finding) => (
          <div className="item" key={finding.key}>
            <div className="row">
              <strong>{finding.title}</strong>
              <span style={{ color: statusTone(finding.severity), fontWeight: 700 }}>{finding.severity}</span>
            </div>
            <p className="muted" style={{ margin: "4px 0 0" }}>{finding.detail}</p>
            {finding.evidence ? <div className="muted">{finding.evidence}</div> : null}
          </div>
        ))}
        {status.riskFindings.length === 0 ? <p className="muted">No deterministic risk findings are currently open.</p> : null}
      </div>
      {summary ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <section className="item" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}><strong>Recent runs</strong></div>
            <div className="list">
              {summary.recentRuns.map((run) => (
                <div className="item" key={run.id}>
                  <div className="row"><strong>{run.agentKey}</strong><span style={{ color: statusTone(run.status), fontWeight: 700 }}>{run.status}</span></div>
                  <div className="muted">{run.goal || "No goal"} / {dateLabel(format, run.createdAt)}</div>
                </div>
              ))}
            </div>
          </section>
          <section className="item" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: 16, borderBottom: "1px solid var(--border-color)" }}><strong>Risky calls and failures</strong></div>
            <div className="list">
              {summary.riskyToolCalls.map((call) => (
                <div className="item" key={call.id}>
                  <div className="row"><strong>{call.name}</strong><span style={{ color: statusTone(call.status), fontWeight: 700 }}>{call.status}</span></div>
                  <div className="muted">{call.agentRun.agentKey} / {call.error || dateLabel(format, call.createdAt)}</div>
                </div>
              ))}
              {summary.recentFailedJobs.map((job) => (
                <div className="item" key={job.id}>
                  <div className="row"><strong>{job.type}</strong><span style={{ color: statusTone("FAILED"), fontWeight: 700 }}>FAILED</span></div>
                  <div className="muted">{job.error || `${job.attempts} attempts`}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function AuditPanel({ status, format }: { status: GovernanceStatus; format: Awaited<ReturnType<typeof getFormatter>> }) {
  return (
    <section id="audit" className="panel stack" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Audit</h2>
      <div className="list">
        {status.audit.recentSupportOperations.map((operation) => (
          <div className="item" key={operation.id}>
            <div className="row">
              <strong>{operation.action}</strong>
              <span style={{ color: statusTone(operation.status), fontWeight: 700 }}>{operation.status}</span>
            </div>
            <div className="muted">{operation.reason}</div>
            <div className="muted">{dateLabel(format, operation.createdAt)}{operation.error ? ` / ${operation.error}` : ""}</div>
          </div>
        ))}
        {status.audit.recentSupportOperations.length === 0 ? <p className="muted">No agent-governance support operations recorded yet.</p> : null}
      </div>
    </section>
  );
}

export default async function ControlPlaneAgentGovernancePage({
  params,
}: {
  params: Promise<{ locale: string; deploymentId: string }>;
}) {
  const { locale, deploymentId } = await params;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor, { deploymentId });
  } catch {
    notFound();
  }

  const [customer, status, format] = await Promise.all([
    getControlPlaneDeployment(actor, deploymentId),
    getControlPlaneAiGovernanceStatus(actor, deploymentId),
    getFormatter(),
  ]);

  const sections = [
    ["overview", "Overview"],
    ["agents", "Agents"],
    ["access", "Access & MCP"],
    ["spend", "Spend"],
    ["activity", "Activity & Risk"],
    ["audit", "Audit"],
  ] as const;

  return (
    <main className="control-plane-shell">
      <aside className="control-plane-rail stack">
        <a href={getControlPlaneHref(`/control-plane/deployments/${deploymentId}`, locale)} className="muted">Back to deployment</a>
        <strong>{customer.label}</strong>
        {sections.map(([id, label]) => (
          <a key={id} className="ws-nav-link" href={`#${id}`}>
            <span className="ws-nav-icon">◇</span>
            {label}
          </a>
        ))}
      </aside>

      <div className="control-plane-content stack">
        <header className="panel stack" style={{ padding: 24 }}>
          <span className="muted">Enterprise agent governance</span>
          <div className="row">
            <div>
              <h1 style={{ margin: 0 }}>{customer.label} Agent Governance</h1>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Scopes, credentials, policies, spend, traces, and support evidence for the Corgtex AI workforce.
              </p>
            </div>
            <a href={customer.url} className="link-button small">Open customer</a>
          </div>
        </header>

        <SummaryPanel status={status} />
        <AgentsPanel status={status} />
        <AccessPanel status={status} />
        <SpendPanel status={status} />
        <ActivityPanel status={status} format={format} />
        <AuditPanel status={status} format={format} />
      </div>
    </main>
  );
}
