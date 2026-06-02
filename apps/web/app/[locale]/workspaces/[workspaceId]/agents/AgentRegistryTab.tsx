import {
  buildAgentAuthoritySummaries,
  getModelUsageBudget,
  getModelUsageSummary,
  listAgentConfigs,
  listAgentCredentials,
  listAgentIdentities,
  type AgentAuthoritySummary,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AgentRegistryToggle } from "./AgentRegistryToggle";
import { updateAgentGovernancePolicyAction } from "./actions";
import { getFormatter, getTranslations } from "next-intl/server";

function formatUsd(value: number | string | null | undefined, digits = 2) {
  const numeric = Number(value ?? 0);
  return `$${Number.isFinite(numeric) ? numeric.toFixed(digits) : "0.00"}`;
}

function formatCents(value: number | null | undefined) {
  return value == null ? "No cap" : formatUsd(value / 100);
}

function formatCount(value: number | null | undefined, suffix: string) {
  return value == null ? "No cap" : `${value} ${suffix}`;
}

function statusColor(status: string) {
  if (status === "ACTIVE") return "var(--accent)";
  if (status === "DISABLED" || status === "ARCHIVED") return "var(--danger)";
  return "var(--muted)";
}

function assignmentLabel(agent: AgentAuthoritySummary) {
  if (agent.roleAssignments.length === 0) return "Not assigned";
  return agent.roleAssignments
    .map((assignment) => assignment.roleName ? `${assignment.circleName} / ${assignment.roleName}` : assignment.circleName)
    .join(", ");
}

function accessLabel(agent: AgentAuthoritySummary) {
  const access = agent.toolsAndDataAccess;
  if (!access.credentialLabel) return "No linked credential";
  return `${access.credentialLabel}${access.credentialActive === false ? " (revoked)" : ""}`;
}

function policyLabel(agent: AgentAuthoritySummary) {
  return agent.approval.hasGovernancePolicy ? "Policy configured" : "Policy not configured";
}

function latestRunLabel(agent: AgentAuthoritySummary, format: Awaited<ReturnType<typeof getFormatter>>) {
  const run = agent.recentActivity.latestRun;
  if (!run) return "No recent actions";
  const date = run.createdAt ? format.dateTime(new Date(run.createdAt), { dateStyle: "medium", timeStyle: "short" }) : "date unknown";
  return `${run.status} / ${date}`;
}

function AgentAuthorityRow({
  agent,
  workspaceId,
  format,
}: {
  agent: AgentAuthoritySummary;
  workspaceId: string;
  format: Awaited<ReturnType<typeof getFormatter>>;
}) {
  const access = agent.toolsAndDataAccess;
  const latestRun = agent.recentActivity.latestRun;
  const enabled = agent.status !== "DISABLED" && agent.status !== "ARCHIVED";

  return (
    <div className="nr-item" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 16,
          alignItems: "start",
          padding: 16,
        }}
      >
        <div className="stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>{agent.displayName}</h3>
            <span className="nr-tag" style={{ color: statusColor(agent.status), borderColor: statusColor(agent.status) }}>
              {agent.status}
            </span>
            <span className="nr-tag">{agent.memberType}</span>
          </div>
          <div className="nr-item-meta" style={{ fontSize: "0.78rem" }}>
            {agent.agentKey}{agent.category ? ` / ${agent.category}` : ""}
          </div>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: "0.72rem", textTransform: "uppercase", color: "var(--muted)" }}>Authority</strong>
          <span style={{ fontSize: "0.85rem" }}>{assignmentLabel(agent)}</span>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: "0.72rem", textTransform: "uppercase", color: "var(--muted)" }}>Tools & data</strong>
          <span style={{ fontSize: "0.85rem" }}>{accessLabel(agent)}</span>
          <span className="nr-item-meta" style={{ fontSize: "0.76rem" }}>
            {access.scopeCount} scopes / {access.writeScopeCount} write / {access.sensitiveScopeCount} sensitive
          </span>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: "0.72rem", textTransform: "uppercase", color: "var(--muted)" }}>Limits</strong>
          <span style={{ fontSize: "0.85rem" }}>{formatCents(agent.limits.maxSpendPerRunCents)} per run</span>
          <span className="nr-item-meta" style={{ fontSize: "0.76rem" }}>
            {formatCount(agent.limits.maxRunsPerDay, "runs/day")} / workspace {agent.limits.workspaceBudgetConfigured ? formatUsd(agent.limits.workspaceMonthlyCostCapUsd) : "No cap"}
          </span>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <strong style={{ fontSize: "0.72rem", textTransform: "uppercase", color: "var(--muted)" }}>Approval & activity</strong>
          <span style={{ fontSize: "0.85rem" }}>{policyLabel(agent)}</span>
          <span className="nr-item-meta" style={{ fontSize: "0.76rem" }}>
            {agent.approval.pendingApprovalCount} pending / {agent.recentActivity.runCount30d} runs / {formatUsd(agent.recentActivity.spend30dUsd, 4)}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {agent.canDisable ? (
            <AgentRegistryToggle workspaceId={workspaceId} agentKey={agent.agentKey} enabled={enabled} />
          ) : <span className="nr-tag">Always on</span>}
        </div>
      </div>

      <details style={{ borderTop: "1px dashed var(--line)", padding: "10px 16px 16px" }}>
        <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--accent)" }}>
          Policy, scopes, and recent actions
        </summary>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 16, marginTop: 12 }}>
          <section className="stack" style={{ gap: 12 }}>
            <form action={updateAgentGovernancePolicyAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="agentKey" value={agent.agentKey} />
              <p className="nr-item-meta" style={{ fontSize: "0.8rem", marginBottom: 8 }}>
                Plain-text boundaries, escalation rules, and thresholds for this agent.
              </p>
              <textarea
                name="governancePolicy"
                defaultValue={agent.approval.governancePolicy ?? ""}
                placeholder="Policy text for this agent. Leave blank to clear the current policy."
                style={{ width: "100%", minHeight: 86, padding: 12, borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 10 }}
              />
              <button type="submit" className="secondary small">Save policy</button>
            </form>
          </section>

          <section className="stack" style={{ gap: 10 }}>
            <div>
              <strong style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>Scope detail</strong>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {access.scopes.length > 0 ? access.scopes.map((scope) => (
                  <span
                    key={scope.name}
                    className="nr-tag"
                    title={`${scope.label} / ${scope.group}`}
                    style={scope.isSensitive ? { borderColor: "var(--warning)", color: "var(--warning)" } : undefined}
                  >
                    {scope.name}
                  </span>
                )) : <span className="nr-item-meta">No linked scopes.</span>}
              </div>
            </div>

            <div>
              <strong style={{ display: "block", fontSize: "0.78rem", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>Recent action</strong>
              <p className="nr-item-meta" style={{ margin: 0 }}>{latestRunLabel(agent, format)}</p>
              {latestRun?.goal ? <p className="nr-excerpt" style={{ marginTop: 4 }}>{latestRun.goal}</p> : null}
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}

export async function AgentRegistryTab({
  workspaceId,
  actor,
}: {
  workspaceId: string;
  actor: AppActor;
}) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    identities,
    usageSummary,
    configs,
    credentials,
    budget,
    recentRuns,
    pendingApprovalRuns,
    runCounts,
    t,
    format,
  ] = await Promise.all([
    listAgentIdentities(actor, workspaceId),
    getModelUsageSummary(actor, workspaceId, { periodDays: 30 }),
    listAgentConfigs(actor, workspaceId),
    listAgentCredentials(actor, workspaceId),
    getModelUsageBudget(actor, workspaceId),
    prisma.agentRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        agentKey: true,
        status: true,
        goal: true,
        approvalRequired: true,
        createdAt: true,
        startedAt: true,
      },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId, status: "WAITING_APPROVAL" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        agentKey: true,
        status: true,
        goal: true,
        approvalRequired: true,
        createdAt: true,
        startedAt: true,
      },
    }),
    prisma.agentRun.groupBy({
      by: ["agentKey"],
      where: { workspaceId, createdAt: { gte: thirtyDaysAgo } },
      _count: { _all: true },
    }),
    getTranslations("agents"),
    getFormatter(),
  ]);

  const authoritySummaries = buildAgentAuthoritySummaries({
    identities,
    configs,
    credentials,
    recentRuns,
    pendingApprovalRuns,
    usageByAgent: usageSummary.byAgent,
    runCountsByAgent: (runCounts as Array<{ agentKey: string; _count: { _all: number } }>)
      .map((row) => ({ agentKey: row.agentKey, count: row._count._all })),
    workspaceBudget: budget
      ? {
        monthlyCostCapUsd: String(budget.monthlyCostCapUsd),
        alertThresholdPct: budget.alertThresholdPct,
      }
      : null,
  });

  return (
    <section className="stack" style={{ gap: 24 }}>
      <div>
        <h2 className="nr-section-header">{t("authorityDashboardTitle")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          {t("authorityDashboardDesc")}
        </p>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        {authoritySummaries.map((agent) => (
          <AgentAuthorityRow
            key={agent.agentKey}
            agent={agent}
            workspaceId={workspaceId}
            format={format}
          />
        ))}
        {authoritySummaries.length === 0 && (
          <div className="nr-item-meta" style={{ padding: "40px 0", textAlign: "center" }}>
            {t("noAgents")}
          </div>
        )}
      </div>
    </section>
  );
}
