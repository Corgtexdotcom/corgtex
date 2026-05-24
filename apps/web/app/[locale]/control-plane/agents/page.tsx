import { notFound } from "next/navigation";
import {
  getControlPlaneAiGovernanceStatus,
  getControlPlaneIntegrationStatus,
  listControlPlaneFleetPage,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { AgentObservatoryClient } from "./_components/observatory-client";

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

export default async function ControlPlaneAgentsPage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const fleet = await listControlPlaneFleetPage(actor, {
    page: 1,
    pageSize: 100,
    sort: "customer",
    direction: "asc",
  });

  const customerDetails = await Promise.all(fleet.items.map(async (customer: any) => {
    const [governanceResult, integrationsResult] = await Promise.allSettled([
      getControlPlaneAiGovernanceStatus(actor, customer.id),
      getControlPlaneIntegrationStatus(actor, customer.id),
    ]);
    const governance = governanceResult.status === "fulfilled" ? governanceResult.value : null;
    const integrations = integrationsResult.status === "fulfilled" ? integrationsResult.value : null;
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

  const customers = customerDetails.map(({ customer, governance, recentRuns, credentials, integrationRows, errors }) => {
    const identityCount = Array.isArray(governance?.agents?.identities) ? governance.agents.identities.length : 0;
    const configCount = Array.isArray(governance?.agents?.configs) ? governance.agents.configs.length : 0;
    return {
      id: customer.id,
      name: customer.label,
      slug: customer.customerSlug ?? customer.managedWorkspace?.slug ?? customer.remoteWorkspaceSlug ?? customer.id,
      healthStatus: customer.lastHealthStatus ?? customer.provisioningStatus ?? "unknown",
      supportConnectorStatus: customer.supportConnectorStatus ?? "not_configured",
      supportMcpUrl: customer.supportMcpUrl ?? null,
      accessMode: governance?.accessMode ?? customer.deploymentKind ?? "unknown",
      hasManagedWorkspace: Boolean(governance?.hasManagedWorkspace),
      agentCount: Math.max(identityCount, configCount, new Set(recentRuns.map((run: any) => run.agentKey).filter(Boolean)).size),
      runCount: countAgentRuns(governance?.summary) || recentRuns.length,
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

  const formattedAgents = customerDetails.flatMap(({ customer, governance, recentRuns }) => {
    const identities = Array.isArray(governance?.agents?.identities) ? governance.agents.identities : [];
    const configs = Array.isArray(governance?.agents?.configs) ? governance.agents.configs : [];
    const usageByRunId = new Map((governance?.spend?.recentModelUsage ?? [])
      .filter((usage: any) => usage.agentRun?.id)
      .map((usage: any) => [usage.agentRun.id, usage]));
    const identitiesByKey = new Map(identities.map((identity: any) => [identity.agentKey, identity]));
    const configsByKey = new Map(configs.map((config: any) => [config.agentKey, config]));
    const agentKeys = new Set<string>([
      ...configs.map((config: any) => config.agentKey).filter(Boolean),
      ...identities.map((identity: any) => identity.agentKey).filter(Boolean),
      ...recentRuns.map((run: any) => run.agentKey).filter(Boolean),
    ]);

    return Array.from(agentKeys).map((agentKey) => {
      const identity: any = identitiesByKey.get(agentKey);
      const config: any = configsByKey.get(agentKey);
      const runsForAgent = recentRuns.filter((run: any) => run.agentKey === agentKey);
      const lastRun = runsForAgent[0];
      const loadedSpend = runsForAgent.reduce((total: number, run: any) => {
        const usage: any = usageByRunId.get(run.id);
        return total + Number(usage?.billableCostUsd ?? usage?.estimatedCostUsd ?? 0);
      }, 0);
      return {
        id: `${customer.id}:${identity?.id ?? config?.id ?? agentKey}`,
        customerId: customer.id,
        customerName: customer.label,
        customerSlug: customer.customerSlug ?? customer.managedWorkspace?.slug ?? customer.remoteWorkspaceSlug ?? customer.id,
        name: identity?.displayName ?? config?.label ?? agentNameFromKey(agentKey),
        status: identity ? (identity.archivedAt ? "ARCHIVED" : identity.isActive ? "ACTIVE" : "DISABLED") : config?.enabled === false ? "DISABLED" : "AVAILABLE",
        modelTier: config?.defaultModelTier ?? "Default",
        modelOverride: config?.modelOverride ?? identity?.linkedCredential?.label ?? "Default",
        runsCount: runsForAgent.length,
        costMtd: costLabel(loadedSpend),
        lastRun: lastRun ? dateLabel(lastRun.createdAt) : "No runs recorded",
      };
    });
  });

  const formattedRuns = customerDetails.flatMap(({ customer, recentRuns, governance }) => {
    const usageByRunId = new Map((governance?.spend?.recentModelUsage ?? [])
      .filter((usage: any) => usage.agentRun?.id)
      .map((usage: any) => [usage.agentRun.id, usage]));

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
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header */}
      <div>
        <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
          Observe & Govern
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
          Agent Observatory
        </h1>
        <p className="text-xs text-slate-400 mt-1 max-w-2xl">
          Global operations center to monitor, filter, and audit all autonomous AI agents running across customer workspaces. Check model tiers, execution costs, and trace run steps.
        </p>
      </div>

      {/* Render Client Observatory list & charts */}
      <AgentObservatoryClient
        agents={formattedAgents}
        runs={formattedRuns}
        customers={customers}
      />

    </div>
  );
}
