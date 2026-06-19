import { notFound } from "next/navigation";
import {
  buildAgentAuthoritySummaries,
  getControlPlaneAiGovernanceStatus,
  getControlPlaneIntegrationStatus,
  listControlPlaneDeployments,
  requireControlPlaneAccess,
  type AgentAuthoritySummary,
  type AgentAuthorityUsageInput,
} from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { firstSelectedValue, normalizeSelectedValues, queryStringFromParams, searchParamValues } from "@/lib/filter-query";
import { AgentObservatoryClient } from "./_components/observatory-client";
import { aggregateModelUsageByRunId, sortAgentFleetRows } from "./view-model";
import { ControlPlaneCacheMeta, ControlPlanePageHeader, controlPlaneButtonClass } from "../_components/control-plane-ui";
import { controlPlaneActorCacheKey, readControlPlaneCached, shouldRefreshControlPlaneCache } from "../cache";

export const dynamic = "force-dynamic";

function dateLabel(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function durationLabel(run: any) {
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const completedAt = run.completedAt ? new Date(run.completedAt).getTime() : null;
  const failedAt = run.failedAt ? new Date(run.failedAt).getTime() : null;
  const end = completedAt ?? failedAt;
  return startedAt && end ? `${((end - startedAt) / 1000).toFixed(1)}s` : "n/a";
}

function costLabel(value: unknown) {
  const numeric = Number(value ?? 0);
  return `$${Number.isFinite(numeric) ? numeric.toFixed(4) : "0.0000"}`;
}

function tokenLabel(value: unknown) {
  const numeric = Number(value ?? 0);
  return `${Number.isFinite(numeric) ? numeric.toLocaleString() : "0"} t`;
}

function agentNameFromKey(agentKey: string) {
  return agentKey
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function countAgentRuns(summary: any) {
  const agentRuns = summary?.agentRuns;
  if (!agentRuns || typeof agentRuns !== "object") return 0;
  return Object.values(agentRuns).reduce<number>((total, count) => total + Number(count ?? 0), 0);
}

function modelSpendValue(summary: any) {
  const modelUsage = summary?.modelUsage as {
    billableCostUsd?: unknown;
    estimatedCostUsd?: unknown;
  } | null | undefined;

  return String(modelUsage?.billableCostUsd ?? modelUsage?.estimatedCostUsd ?? "0");
}

function agentUsageByAgent(usages: any[] | null | undefined): AgentAuthorityUsageInput[] {
  const totals = new Map<string, { callCount: number; totalCostUsd: number }>();
  for (const usage of usages ?? []) {
    const agentKey = usage.agentRun?.agentKey;
    if (!agentKey) continue;
    const current = totals.get(agentKey) ?? { callCount: 0, totalCostUsd: 0 };
    totals.set(agentKey, {
      callCount: current.callCount + 1,
      totalCostUsd: current.totalCostUsd + Number(usage.billableCostUsd ?? usage.estimatedCostUsd ?? 0),
    });
  }
  return Array.from(totals.entries()).map(([agentKey, usage]) => ({ agentKey, ...usage }));
}

function agentRunCountsByAgent(runs: any[]) {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!run.agentKey) continue;
    counts.set(run.agentKey, (counts.get(run.agentKey) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([agentKey, count]) => ({ agentKey, count }));
}

function pendingApprovalRunsForGovernance(governance: any) {
  const summaryRuns = "pendingApprovalRuns" in (governance?.summary ?? {})
    ? governance.summary.pendingApprovalRuns
    : null;
  if (Array.isArray(summaryRuns)) return summaryRuns;
  return Array.isArray(governance?.activity?.pendingApprovalRuns) ? governance.activity.pendingApprovalRuns : undefined;
}

function authorityLabel(summary: AgentAuthoritySummary) {
  if (summary.roleAssignments.length === 0) return "Not assigned";
  return summary.roleAssignments
    .map((assignment) => assignment.roleName ? `${assignment.circleName} / ${assignment.roleName}` : assignment.circleName)
    .join(", ");
}

function accessLabel(summary: AgentAuthoritySummary) {
  const access = summary.toolsAndDataAccess;
  if (!access.credentialLabel) return "No linked credential";
  return `${access.credentialLabel}${access.credentialActive === false ? " (revoked)" : ""}`;
}

function limitLabel(summary: AgentAuthoritySummary) {
  const spendCap = summary.limits.maxSpendPerRunCents == null
    ? "No run cap"
    : `${costLabel(summary.limits.maxSpendPerRunCents / 100)} / run`;
  const runCap = summary.limits.maxRunsPerDay == null ? "No daily cap" : `${summary.limits.maxRunsPerDay} / day`;
  return `${spendCap}; ${runCap}`;
}

function approvalLabel(summary: AgentAuthoritySummary) {
  const policy = summary.approval.hasGovernancePolicy ? "policy configured" : "policy missing";
  return `${policy}; ${summary.approval.pendingApprovalCount} pending`;
}

export default async function ControlPlaneAgentsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const selectedCustomerIds = normalizeSelectedValues(raw?.client);
  const refresh = shouldRefreshControlPlaneCache(firstSelectedValue(searchParamValues(raw?.refresh)));
  const actorCacheKey = controlPlaneActorCacheKey(actor);
  const fleetRowsRead = await readControlPlaneCached(["control-plane", "agents", "fleet", actorCacheKey], refresh, () => (
    listControlPlaneDeployments(actor)
  ));
  const fleetRows = sortAgentFleetRows(fleetRowsRead.data);
  const detailedRows = selectedCustomerIds.length > 0
    ? fleetRows.filter((customer: any) => selectedCustomerIds.includes(customer.id))
    : [];

  const customerDetails = await Promise.all(detailedRows.map(async (customer: any) => {
    const [governanceResult, integrationsResult] = await Promise.allSettled([
      readControlPlaneCached(["control-plane", "agents", "governance", actorCacheKey, customer.id], refresh, () => (
        getControlPlaneAiGovernanceStatus(actor, customer.id)
      )),
      readControlPlaneCached(["control-plane", "agents", "integrations", actorCacheKey, customer.id], refresh, () => (
        getControlPlaneIntegrationStatus(actor, customer.id)
      )),
    ]);
    const governance = governanceResult.status === "fulfilled" ? governanceResult.value.data : null;
    const integrations = integrationsResult.status === "fulfilled" ? integrationsResult.value.data : null;
    const recentRuns = Array.isArray(governance?.activity?.recentRuns) ? governance.activity.recentRuns : [];
    const credentials = Array.isArray(governance?.access?.credentials) ? governance.access.credentials : [];
    const integrationRows = Array.isArray(integrations?.integrations) ? integrations.integrations : [];

    return {
      customer,
      governance,
      integrations,
      recentRuns,
      credentials,
      integrationRows,
      errors: [
        governanceResult.status === "rejected" ? "Agent governance unavailable" : null,
        integrationsResult.status === "rejected" ? "Integrations unavailable" : null,
      ].filter((error): error is string => Boolean(error)),
    };
  }));
  const detailsByCustomerId = new Map(customerDetails.map((detail) => [detail.customer.id, detail]));

  const customers = fleetRows.map((customer: any) => {
    const details = detailsByCustomerId.get(customer.id);
    const governance = details?.governance ?? null;
    const recentRuns = details?.recentRuns ?? [];
    const credentials = details?.credentials ?? [];
    const integrationRows = details?.integrationRows ?? [];
    const errors = details?.errors ?? [];
    const identityCount = Array.isArray(governance?.agents?.identities) ? governance.agents.identities.length : 0;
    const configCount = Array.isArray(governance?.agents?.configs) ? governance.agents.configs.length : 0;
    const localRunCount = customer.managedWorkspace?._count?.agentRuns ?? 0;
    return {
      id: customer.id,
      name: customer.label,
      slug: customer.customerSlug ?? customer.managedWorkspace?.slug ?? customer.remoteWorkspaceSlug ?? customer.id,
      healthStatus: customer.lastHealthStatus ?? customer.provisioningStatus ?? "unknown",
      supportConnectorStatus: customer.supportConnectorStatus ?? "not_configured",
      supportConnectorLabel: customer.supportConnectorLabel ?? "Support connector",
      supportConnectorDetail: customer.supportConnectorDetail ?? null,
      supportAccessMode: customer.supportAccessMode ?? "enterprise_connector",
      supportMcpUrl: customer.supportMcpUrl ?? null,
      accessMode: governance?.accessMode ?? customer.deploymentKind ?? "unknown",
      hasManagedWorkspace: Boolean(governance?.hasManagedWorkspace ?? customer.managedWorkspaceId),
      agentCount: Math.max(identityCount, configCount, new Set(recentRuns.map((run: any) => run.agentKey).filter(Boolean)).size),
      runCount: countAgentRuns(governance?.summary) || recentRuns.length || localRunCount,
      credentialCount: credentials.length,
      integrationCount: integrationRows.length,
      modelSpend: modelSpendValue(governance?.summary),
      errors,
      credentials: credentials.map((credential: any) => ({
        id: credential.id,
        label: credential.label,
        isActive: Boolean(credential.isActive),
        scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
      })),
      integrations: integrationRows.map((integration: any) => ({
        key: integration.key,
        label: integration.label,
        status: integration.status ?? (integration.configured ? "configured" : "disabled"),
        configured: Boolean(integration.configured),
        lastError: integration.lastError ?? null,
      })),
    };
  });

  const formattedAgents = customerDetails.flatMap(({ customer, governance, recentRuns, credentials }) => {
    const identities = Array.isArray(governance?.agents?.identities) ? governance.agents.identities : [];
    const configs = Array.isArray(governance?.agents?.configs) ? governance.agents.configs : [];
    const authoritySummaries = buildAgentAuthoritySummaries({
      identities,
      configs,
      credentials,
      recentRuns,
      pendingApprovalRuns: pendingApprovalRunsForGovernance(governance),
      usageByAgent: agentUsageByAgent(governance?.spend?.recentModelUsage),
      runCountsByAgent: agentRunCountsByAgent(recentRuns),
      workspaceBudget: governance?.spend?.budget,
    });

    return authoritySummaries.map((summary) => {
      return {
        id: `${customer.id}:${summary.identityId ?? summary.agentKey}`,
        customerId: customer.id,
        customerName: customer.label,
        customerSlug: customer.customerSlug ?? customer.managedWorkspace?.slug ?? customer.remoteWorkspaceSlug ?? customer.id,
        name: summary.displayName,
        status: summary.status,
        modelTier: summary.defaultModelTier ?? "Default",
        modelOverride: summary.modelOverride ?? "Default",
        authority: authorityLabel(summary),
        access: accessLabel(summary),
        dataScope: `${summary.toolsAndDataAccess.scopeCount} scopes / ${summary.toolsAndDataAccess.writeScopeCount} write / ${summary.toolsAndDataAccess.sensitiveScopeCount} sensitive`,
        limits: limitLabel(summary),
        approval: approvalLabel(summary),
        pendingApprovals: summary.approval.pendingApprovalCount,
        runsCount: summary.recentActivity.runCount30d,
        costMtd: costLabel(summary.recentActivity.spend30dUsd),
        lastRun: summary.recentActivity.latestRun ? dateLabel(summary.recentActivity.latestRun.createdAt) : "No runs recorded",
        latestRunStatus: summary.recentActivity.latestRun?.status ?? "NO_RUNS",
      };
    });
  });

  const formattedRuns = customerDetails.flatMap(({ customer, recentRuns, governance }) => {
    const usageByRunId = aggregateModelUsageByRunId(governance?.spend?.recentModelUsage);

    return recentRuns.map((run: any) => {
      const usage: any = usageByRunId.get(run.id);
      const tokens = Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0);
      return {
        id: `${customer.id}:${run.id}`,
        customerId: customer.id,
        customerName: customer.label,
        agentName: agentNameFromKey(run.agentKey ?? "agent"),
        status: run.status,
        duration: durationLabel(run),
        cost: costLabel(usage?.billableCostUsd ?? usage?.estimatedCostUsd),
        tokens: tokenLabel(tokens),
        timestamp: dateLabel(run.createdAt),
        steps: [],
        toolCalls: [],
        error: run.status === "FAILED" ? "Run execution failed" : undefined,
      };
    });
  });

  return (
    <div className="space-y-5">
      <ControlPlanePageHeader
        eyebrow="Observe and govern"
        title="Agent Observatory"
        description="Operations center for autonomous agent health, authority, model cost, approvals, credentials, and recent runs across customer workspaces."
      />

      <ControlPlaneCacheMeta
        cachedAt={fleetRowsRead.cachedAt}
        cacheStatus={fleetRowsRead.cacheStatus}
        refreshAction={<Link href={queryStringFromParams({ client: selectedCustomerIds, refresh: 1 })} className={controlPlaneButtonClass}>Refresh live data</Link>}
      />

      <AgentObservatoryClient
        agents={formattedAgents}
        runs={formattedRuns}
        customers={customers}
        initialCustomerIds={selectedCustomerIds}
      />

    </div>
  );
}
