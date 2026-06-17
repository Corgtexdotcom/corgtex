import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AGENT_REGISTRY, type RegisteredAgentKey } from "./agent-registry";
import { AppError } from "./errors";
import type { NewspaperCadence, Prisma } from "@prisma/client";

export type AgentConfigSummary = {
  agentKey: RegisteredAgentKey;
  label: string;
  description: string;
  category: string;
  canDisable: boolean;
  costTier: "free" | "low" | "medium" | "high" | "very-high";
  defaultModelTier: "fast" | "standard" | "quality" | "excellent" | "none";
  inputs: readonly string[];
  outputs: readonly string[];
  enabled: boolean;
  modelOverride: string | null;
  governancePolicy: string | null;
  configJson: any;
};

export const DEFAULT_NEWSPAPER_CADENCE: NewspaperCadence = "DAILY";
const NEWSPAPER_CADENCES = new Set<NewspaperCadence>(["DAILY", "WEEKLY", "OFF"]);
export type CompanyUnderstandingGoalApplyMode = "AUTO" | "MANUAL";
export const DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE: CompanyUnderstandingGoalApplyMode = "AUTO";
const COMPANY_UNDERSTANDING_GOAL_APPLY_MODES = new Set<CompanyUnderstandingGoalApplyMode>(["AUTO", "MANUAL"]);
const DEFAULT_SLACK_AGENT_CONFIG = {
  publicIngestionEnabled: true,
  rawMessageRetentionDays: 3650,
  proactiveEnabled: true,
  proactiveConfidenceThreshold: 0.9,
  unansweredFollowupDelayMinutes: 1440,
  unansweredActionCreationDelayMinutes: 1440,
  staleActionFollowupDelayMinutes: 4320,
  mutedChannelIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeNewspaperCadence(value: unknown, fallback: NewspaperCadence = DEFAULT_NEWSPAPER_CADENCE): NewspaperCadence {
  return typeof value === "string" && NEWSPAPER_CADENCES.has(value as NewspaperCadence)
    ? value as NewspaperCadence
    : fallback;
}

export function normalizeCompanyUnderstandingGoalApplyMode(
  value: unknown,
  fallback: CompanyUnderstandingGoalApplyMode = DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE,
): CompanyUnderstandingGoalApplyMode {
  return typeof value === "string" && COMPANY_UNDERSTANDING_GOAL_APPLY_MODES.has(value as CompanyUnderstandingGoalApplyMode)
    ? value as CompanyUnderstandingGoalApplyMode
    : fallback;
}

function normalizeAgentConfigJson(agentKey: string, configJson: unknown): Prisma.InputJsonObject {
  const config = isRecord(configJson) ? { ...configJson } : {};

  if (agentKey === "daily-digest" && "newspaperCadence" in config) {
    config.newspaperCadence = normalizeNewspaperCadence(config.newspaperCadence);
  }
  if (agentKey === "company-understanding") {
    config.goalApplyMode = normalizeCompanyUnderstandingGoalApplyMode(config.goalApplyMode);
  }
  if (agentKey === "slack-agent") {
    const mutedChannelIds = Array.isArray(config.mutedChannelIds)
      ? config.mutedChannelIds.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean)
      : DEFAULT_SLACK_AGENT_CONFIG.mutedChannelIds;
    return toInputJson({
      ...DEFAULT_SLACK_AGENT_CONFIG,
      ...config,
      proactiveConfidenceThreshold: typeof config.proactiveConfidenceThreshold === "number"
        ? Math.max(0, Math.min(1, config.proactiveConfidenceThreshold))
        : DEFAULT_SLACK_AGENT_CONFIG.proactiveConfidenceThreshold,
      unansweredFollowupDelayMinutes: typeof config.unansweredFollowupDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.unansweredFollowupDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.unansweredFollowupDelayMinutes,
      unansweredActionCreationDelayMinutes: typeof config.unansweredActionCreationDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.unansweredActionCreationDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.unansweredActionCreationDelayMinutes,
      staleActionFollowupDelayMinutes: typeof config.staleActionFollowupDelayMinutes === "number"
        ? Math.max(15, Math.floor(config.staleActionFollowupDelayMinutes))
        : DEFAULT_SLACK_AGENT_CONFIG.staleActionFollowupDelayMinutes,
      mutedChannelIds,
    }) as Prisma.InputJsonObject;
  }

  return toInputJson(config) as Prisma.InputJsonObject;
}

function defaultConfigJson(agentKey: string) {
  if (agentKey === "slack-agent") return DEFAULT_SLACK_AGENT_CONFIG;
  if (agentKey === "company-understanding") {
    return { goalApplyMode: DEFAULT_COMPANY_UNDERSTANDING_GOAL_APPLY_MODE };
  }
  return {};
}

export async function listAgentConfigs(actor: AppActor, workspaceId: string): Promise<AgentConfigSummary[]> {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  const overrides = await prisma.workspaceAgentConfig.findMany({
    where: { workspaceId },
  });

  const overrideMap = new Map(overrides.map((o) => [o.agentKey, o]));

  const summaries: AgentConfigSummary[] = [];

  for (const [key, meta] of Object.entries(AGENT_REGISTRY)) {
    const override = overrideMap.get(key);
    const configJson = override
      ? normalizeAgentConfigJson(key, override.configJson)
      : defaultConfigJson(key);
    summaries.push({
      agentKey: key as RegisteredAgentKey,
      label: meta.label,
      description: meta.description,
      category: meta.category,
      canDisable: meta.canDisable,
      costTier: meta.costTier,
      defaultModelTier: meta.defaultModelTier,
      inputs: meta.inputs,
      outputs: meta.outputs,
      enabled: override ? override.enabled : true,
      modelOverride: override?.modelOverride ?? null,
      governancePolicy: override?.governancePolicy ?? null,
      configJson,
    });
  }

  return summaries;
}

export async function updateAgentConfig(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentKey: string;
    enabled?: boolean;
    modelOverride?: string | null;
    governancePolicy?: string | null;
    configJson?: any;
  }
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const meta = AGENT_REGISTRY[params.agentKey as RegisteredAgentKey];
  if (!meta) {
    throw new AppError(400, "INVALID_INPUT", `Unknown agent: ${params.agentKey}`);
  }

  if (params.enabled === false && !meta.canDisable) {
    throw new AppError(400, "INVALID_INPUT", `Agent ${params.agentKey} cannot be disabled.`);
  }

  const configJson = params.configJson === undefined
    ? undefined
    : normalizeAgentConfigJson(params.agentKey, params.configJson);

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: params.agentKey,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: params.agentKey,
      enabled: params.enabled ?? true,
      modelOverride: params.modelOverride ?? null,
      governancePolicy: params.governancePolicy ?? null,
      configJson: configJson ?? {},
    },
    update: {
      ...(params.enabled !== undefined && { enabled: params.enabled }),
      ...(params.modelOverride !== undefined && { modelOverride: params.modelOverride }),
      ...(params.governancePolicy !== undefined && { governancePolicy: params.governancePolicy }),
      ...(configJson !== undefined && { configJson }),
    },
  });
}

export async function getWorkspaceNewspaperCadence(workspaceId: string): Promise<NewspaperCadence> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey: "daily-digest" },
    },
    select: { configJson: true },
  });

  return normalizeNewspaperCadence(isRecord(config?.configJson) ? config.configJson.newspaperCadence : undefined);
}

export async function getCompanyUnderstandingGoalApplyMode(
  workspaceId: string,
): Promise<CompanyUnderstandingGoalApplyMode> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey: "company-understanding" },
    },
    select: { configJson: true },
  });

  return normalizeCompanyUnderstandingGoalApplyMode(
    isRecord(config?.configJson) ? config.configJson.goalApplyMode : undefined,
  );
}

export type WorkspaceDigestSetting = {
  enabled: boolean;
  cadence: NewspaperCadence;
};

/**
 * Batched equivalent of calling `isAgentEnabled(id, "daily-digest")` and
 * `getWorkspaceNewspaperCadence(id)` for many workspaces at once. Issues a
 * single `workspaceAgentConfig.findMany` rather than two `findUnique`
 * round-trips per workspace, while preserving identical semantics: the
 * registry `canDisable` handling from `isAgentEnabled` and the
 * `normalizeNewspaperCadence` fallback from `getWorkspaceNewspaperCadence`.
 * Workspaces with no config row default to enabled + DEFAULT_NEWSPAPER_CADENCE.
 */
export async function getWorkspaceDigestSettings(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceDigestSetting>> {
  const settings = new Map<string, WorkspaceDigestSetting>();
  if (workspaceIds.length === 0) {
    return settings;
  }

  const meta = AGENT_REGISTRY["daily-digest" as RegisteredAgentKey];
  const canDisable = meta?.canDisable ?? true;

  const configs = await prisma.workspaceAgentConfig.findMany({
    where: { agentKey: "daily-digest", workspaceId: { in: workspaceIds } },
    select: { workspaceId: true, enabled: true, configJson: true },
  });
  const configByWorkspace = new Map(configs.map((config) => [config.workspaceId, config]));

  for (const workspaceId of workspaceIds) {
    const config = configByWorkspace.get(workspaceId);
    settings.set(workspaceId, {
      enabled: canDisable ? (config?.enabled ?? true) : true,
      cadence: normalizeNewspaperCadence(isRecord(config?.configJson) ? config.configJson.newspaperCadence : undefined),
    });
  }

  return settings;
}

export async function updateWorkspaceNewspaperCadence(
  actor: AppActor,
  params: {
    workspaceId: string;
    cadence: NewspaperCadence;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const cadence = normalizeNewspaperCadence(params.cadence);
  const existing = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId: params.workspaceId, agentKey: "daily-digest" },
    },
    select: { configJson: true },
  });
  const currentConfig = isRecord(existing?.configJson)
    ? existing.configJson as Prisma.InputJsonObject
    : {};
  const configJson = toInputJson({
    ...currentConfig,
    newspaperCadence: cadence,
  }) as Prisma.InputJsonObject;

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: "daily-digest",
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: "daily-digest",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      configJson,
    },
    update: {
      configJson,
    },
  });
}

export async function updateCompanyUnderstandingGoalApplyMode(
  actor: AppActor,
  params: {
    workspaceId: string;
    mode: CompanyUnderstandingGoalApplyMode;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const mode = normalizeCompanyUnderstandingGoalApplyMode(params.mode);
  const existing = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId: params.workspaceId, agentKey: "company-understanding" },
    },
    select: { configJson: true },
  });
  const currentConfig = isRecord(existing?.configJson)
    ? existing.configJson as Prisma.InputJsonObject
    : {};
  const configJson = toInputJson({
    ...currentConfig,
    goalApplyMode: mode,
  }) as Prisma.InputJsonObject;

  return prisma.workspaceAgentConfig.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: "company-understanding",
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: "company-understanding",
      enabled: true,
      modelOverride: null,
      governancePolicy: null,
      configJson,
    },
    update: {
      configJson,
    },
  });
}

export async function isAgentEnabled(workspaceId: string, agentKey: string): Promise<boolean> {
  const meta = AGENT_REGISTRY[agentKey as RegisteredAgentKey];
  if (meta && !meta.canDisable) {
    return true;
  }

  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { enabled: true },
  });

  return config?.enabled ?? true;
}

export async function getAgentModelOverride(workspaceId: string, agentKey: string): Promise<string | null> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { modelOverride: true },
  });

  return config?.modelOverride ?? null;
}

export async function getAgentGovernancePolicy(workspaceId: string, agentKey: string): Promise<string | null> {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey },
    },
    select: { governancePolicy: true },
  });

  return config?.governancePolicy ?? null;
}
