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
const DEFAULT_SLACK_AGENT_CONFIG = {
  publicIngestionEnabled: true,
  rawMessageRetentionDays: 3650,
  proactiveEnabled: true,
  proactiveConfidenceThreshold: 0.9,
  unansweredFollowupDelayMinutes: 240,
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

function normalizeAgentConfigJson(agentKey: string, configJson: unknown): Prisma.InputJsonObject {
  const config = isRecord(configJson) ? { ...configJson } : {};

  if (agentKey === "daily-digest" && "newspaperCadence" in config) {
    config.newspaperCadence = normalizeNewspaperCadence(config.newspaperCadence);
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
      mutedChannelIds,
    }) as Prisma.InputJsonObject;
  }

  return toInputJson(config) as Prisma.InputJsonObject;
}

function defaultConfigJson(agentKey: string) {
  if (agentKey === "slack-agent") return DEFAULT_SLACK_AGENT_CONFIG;
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
      configJson: override?.configJson ?? defaultConfigJson(key),
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
