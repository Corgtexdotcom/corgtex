import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AGENT_REGISTRY, type RegisteredAgentKey } from "./agent-registry";
import { AppError } from "./errors";

export type AgentConfigSummary = {
  agentKey: RegisteredAgentKey;
  label: string;
  description: string;
  category: string;
  canDisable: boolean;
  costTier: "free" | "low" | "medium" | "high" | "very-high";
  defaultModelTier: "fast" | "standard" | "quality" | "none";
  inputs: readonly string[];
  outputs: readonly string[];
  enabled: boolean;
  modelOverride: string | null;
  configJson: any;
};

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
      configJson: override?.configJson ?? {},
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
      configJson: params.configJson ?? {},
    },
    update: {
      ...(params.enabled !== undefined && { enabled: params.enabled }),
      ...(params.modelOverride !== undefined && { modelOverride: params.modelOverride }),
      ...(params.configJson !== undefined && { configJson: params.configJson }),
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
