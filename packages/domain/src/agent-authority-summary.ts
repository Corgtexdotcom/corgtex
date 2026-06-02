type Dateish = Date | string | null;
type NamedRef = { id?: string | null; name?: string | null };

export type AgentAuthorityStatus = "ACTIVE" | "DISABLED" | "ARCHIVED" | "AVAILABLE";

export type AgentAuthorityCredentialInput = {
  id: string; label: string; scopes?: string[] | null; isActive?: boolean | null; lastUsedAt?: Dateish;
  monthlyBudgetCents?: number | null; dailyCallLimit?: number | null;
};

export type AgentAuthorityIdentityInput = {
  id?: string | null; agentKey: string; memberType?: string | null; displayName?: string | null;
  isActive?: boolean | null; archivedAt?: Dateish; linkedCredentialId?: string | null;
  linkedCredential?: AgentAuthorityCredentialInput | null; maxSpendPerRunCents?: number | null;
  maxRunsPerDay?: number | null; maxRunsPerHour?: number | null;
  circleAssignments?: Array<{ circle?: NamedRef | null; role?: NamedRef | null }> | null;
};

export type AgentAuthorityConfigInput = {
  agentKey: string; label?: string | null; category?: string | null; canDisable?: boolean | null;
  costTier?: string | null; defaultModelTier?: string | null; enabled?: boolean | null;
  modelOverride?: string | null; governancePolicy?: string | null; hasGovernancePolicy?: boolean | null;
};

export type AgentAuthorityRunInput = {
  id?: string | null; agentKey: string; status: string; goal?: string | null;
  approvalRequired?: boolean | null; createdAt?: Dateish; startedAt?: Dateish;
};

export type AgentAuthorityUsageInput = { agentKey: string; callCount?: number | null; totalCostUsd?: number | string | null };

export type AgentAuthoritySummary = {
  agentKey: string; identityId: string | null; displayName: string; status: AgentAuthorityStatus;
  memberType: string; canDisable: boolean; category: string | null; costTier: string | null;
  defaultModelTier: string | null; modelOverride: string | null;
  roleAssignments: Array<{ circleId: string | null; circleName: string; roleId: string | null; roleName: string | null }>;
  toolsAndDataAccess: {
    credentialId: string | null; credentialLabel: string | null; credentialActive: boolean | null;
    scopes: Array<{ name: string; label: string; group: string; isWrite: boolean; isSensitive: boolean }>;
    scopeCount: number; writeScopeCount: number; sensitiveScopeCount: number; lastUsedAt: Dateish;
  };
  limits: {
    maxSpendPerRunCents: number | null; maxRunsPerDay: number | null; maxRunsPerHour: number | null;
    credentialMonthlyBudgetCents: number | null; credentialDailyCallLimit: number | null;
    workspaceMonthlyCostCapUsd: number | string | null;
    workspaceBudgetConfigured: boolean;
  };
  approval: {
    hasGovernancePolicy: boolean; governancePolicy: string | null; pendingApprovalCount: number;
    latestApprovalRequiredRun: AgentAuthorityRunInput | null;
  };
  recentActivity: { latestRun: AgentAuthorityRunInput | null; runCount30d: number; modelCallCount30d: number; spend30dUsd: number };
};

export type BuildAgentAuthoritySummariesInput = {
  identities?: AgentAuthorityIdentityInput[] | null;
  configs?: AgentAuthorityConfigInput[] | null;
  credentials?: AgentAuthorityCredentialInput[] | null;
  recentRuns?: AgentAuthorityRunInput[] | null;
  pendingApprovalRuns?: AgentAuthorityRunInput[] | null;
  usageByAgent?: AgentAuthorityUsageInput[] | null;
  runCountsByAgent?: Array<{ agentKey: string; count: number }> | null;
  workspaceBudget?: { monthlyCostCapUsd?: number | string | null; alertThresholdPct?: number | null } | null;
};

const HIGH_RISK_SCOPES = new Set(["archive:write", "context-graph:approve", "support:write", "tools:credentials:read", "runtime:write", "workspace:write"]);

function agentNameFromKey(agentKey: string) {
  return agentKey
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function finiteNumber(value: unknown, fallback = 0) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timeValue(value: Dateish | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusFor(identity: AgentAuthorityIdentityInput | undefined, config: AgentAuthorityConfigInput | undefined): AgentAuthorityStatus {
  if (identity?.archivedAt) return "ARCHIVED";
  if (identity?.isActive === false || config?.enabled === false) return "DISABLED";
  return identity ? "ACTIVE" : "AVAILABLE";
}

function isWriteScope(scope: string) {
  return scope.includes(":write") || scope.includes(":approve") || scope.endsWith(":credentials:read");
}

function scopeSummary(scopes: string[] | null | undefined) {
  return [...new Set(scopes ?? [])].sort().map((scope) => {
    const [group] = scope.split(":");
    const isWrite = isWriteScope(scope);
    return { name: scope, label: scope, group: group || "custom", isWrite, isSensitive: isWrite || HIGH_RISK_SCOPES.has(scope) };
  });
}

export function buildAgentAuthoritySummaries(input: BuildAgentAuthoritySummariesInput): AgentAuthoritySummary[] {
  const identities = input.identities ?? [];
  const configs = input.configs ?? [];
  const credentialsById = new Map((input.credentials ?? []).map((credential) => [credential.id, credential]));
  const identitiesByKey = new Map(identities.map((identity) => [identity.agentKey, identity]));
  const configsByKey = new Map(configs.map((config) => [config.agentKey, config]));
  const usageByAgent = new Map((input.usageByAgent ?? []).map((usage) => [usage.agentKey, usage]));
  const runCountsByAgent = new Map((input.runCountsByAgent ?? []).map((row) => [row.agentKey, row.count]));
  const runsByAgent = new Map<string, AgentAuthorityRunInput[]>();
  const pendingRunsByAgent = new Map<string, AgentAuthorityRunInput[]>();

  for (const run of input.recentRuns ?? []) {
    runsByAgent.set(run.agentKey, [...(runsByAgent.get(run.agentKey) ?? []), run]);
  }
  for (const run of input.pendingApprovalRuns ?? []) {
    pendingRunsByAgent.set(run.agentKey, [...(pendingRunsByAgent.get(run.agentKey) ?? []), run]);
  }

  return Array.from(new Set([
    ...configs.map((config) => config.agentKey).filter(Boolean),
    ...identities.map((identity) => identity.agentKey).filter(Boolean),
    ...(input.recentRuns ?? []).map((run) => run.agentKey).filter(Boolean),
    ...(input.pendingApprovalRuns ?? []).map((run) => run.agentKey).filter(Boolean),
  ])).map((agentKey) => {
    const identity = identitiesByKey.get(agentKey);
    const config = configsByKey.get(agentKey);
    const credentialFromList = identity?.linkedCredentialId ? credentialsById.get(identity.linkedCredentialId) : undefined;
    const linkedCredential = identity?.linkedCredential ? { ...credentialFromList, ...identity.linkedCredential } : credentialFromList ?? null;
    const scopes = scopeSummary(linkedCredential?.scopes);
    const runsForAgent = [...(runsByAgent.get(agentKey) ?? [])].sort((a, b) => timeValue(b.startedAt ?? b.createdAt) - timeValue(a.startedAt ?? a.createdAt));
    const approvalRuns = [...(pendingRunsByAgent.get(agentKey) ?? runsForAgent.filter((run) => run.status === "WAITING_APPROVAL"))]
      .sort((a, b) => timeValue(b.startedAt ?? b.createdAt) - timeValue(a.startedAt ?? a.createdAt));
    const usage = usageByAgent.get(agentKey);
    const governancePolicy = config?.governancePolicy?.trim() || null;

    return {
      agentKey,
      identityId: identity?.id ?? null,
      displayName: identity?.displayName ?? config?.label ?? agentNameFromKey(agentKey),
      status: statusFor(identity, config),
      memberType: identity?.memberType ?? "INTERNAL",
      canDisable: config?.canDisable ?? true,
      category: config?.category ?? null,
      costTier: config?.costTier ?? null,
      defaultModelTier: config?.defaultModelTier ?? null,
      modelOverride: config?.modelOverride ?? null,
      roleAssignments: (identity?.circleAssignments ?? []).filter((assignment) => assignment.circle?.name).map((assignment) => ({
        circleId: assignment.circle?.id ?? null,
        circleName: assignment.circle?.name ?? "Not assigned",
        roleId: assignment.role?.id ?? null,
        roleName: assignment.role?.name ?? null,
      })),
      toolsAndDataAccess: {
        credentialId: linkedCredential?.id ?? null,
        credentialLabel: linkedCredential?.label ?? null,
        credentialActive: linkedCredential?.isActive ?? null,
        scopes,
        scopeCount: scopes.length,
        writeScopeCount: scopes.filter((scope) => scope.isWrite).length,
        sensitiveScopeCount: scopes.filter((scope) => scope.isSensitive).length,
        lastUsedAt: linkedCredential?.lastUsedAt ?? null,
      },
      limits: {
        maxSpendPerRunCents: identity?.maxSpendPerRunCents ?? null,
        maxRunsPerDay: identity?.maxRunsPerDay ?? null,
        maxRunsPerHour: identity?.maxRunsPerHour ?? null,
        credentialMonthlyBudgetCents: linkedCredential?.monthlyBudgetCents ?? null,
        credentialDailyCallLimit: linkedCredential?.dailyCallLimit ?? null,
        workspaceMonthlyCostCapUsd: input.workspaceBudget?.monthlyCostCapUsd ?? null,
        workspaceBudgetConfigured: input.workspaceBudget?.monthlyCostCapUsd != null,
      },
      approval: {
        hasGovernancePolicy: config?.hasGovernancePolicy ?? Boolean(governancePolicy),
        governancePolicy,
        pendingApprovalCount: approvalRuns.length,
        latestApprovalRequiredRun: approvalRuns[0] ?? null,
      },
      recentActivity: {
        latestRun: runsForAgent[0] ?? null,
        runCount30d: runCountsByAgent.get(agentKey) ?? runsForAgent.length,
        modelCallCount30d: Math.max(0, Math.floor(finiteNumber(usage?.callCount))),
        spend30dUsd: finiteNumber(usage?.totalCostUsd),
      },
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
