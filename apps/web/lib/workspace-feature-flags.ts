import { notFound } from "next/navigation";

import { prisma } from "@corgtex/shared";

import type { NavGroup, WorkspaceNavFeatureFlag } from "@/lib/nav-config";

export type WorkspaceFeatureFlag =
  | WorkspaceNavFeatureFlag
  | "SETTINGS_GENERAL"
  | "MULTILINGUAL";

export type WorkspaceFeatureFlagMap = Record<WorkspaceFeatureFlag, boolean>;

export const DEFAULT_WORKSPACE_FEATURE_FLAGS: WorkspaceFeatureFlagMap = {
  GOALS: true,
  RELATIONSHIPS: true,
  CYCLES: true,
  AGENT_GOVERNANCE: true,
  OS_METRICS: true,
  SETTINGS_GENERAL: true,
  MULTILINGUAL: false,
};

const WORKSPACE_FEATURE_FLAG_VALUES: WorkspaceFeatureFlag[] = [
  "GOALS",
  "RELATIONSHIPS",
  "CYCLES",
  "AGENT_GOVERNANCE",
  "OS_METRICS",
  "SETTINGS_GENERAL",
  "MULTILINGUAL",
];

const CRINA_STABLE_WORKSPACE_SLUGS = new Set(["crina"]);

const CRINA_STABLE_FEATURE_FLAGS: Partial<WorkspaceFeatureFlagMap> = {
  GOALS: false,
  RELATIONSHIPS: false,
  CYCLES: false,
  AGENT_GOVERNANCE: false,
  OS_METRICS: false,
  SETTINGS_GENERAL: false,
};

function isKnownWorkspaceFeatureFlag(flag: string): flag is WorkspaceFeatureFlag {
  return WORKSPACE_FEATURE_FLAG_VALUES.includes(flag as WorkspaceFeatureFlag);
}

export async function getWorkspaceFeatureFlags(workspaceId: string): Promise<WorkspaceFeatureFlagMap> {
  const [workspace, records] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    }),
    prisma.workspaceFeatureFlag.findMany({
      where: {
        workspaceId,
        flag: { in: WORKSPACE_FEATURE_FLAG_VALUES },
      },
      select: {
        flag: true,
        enabled: true,
      },
    }),
  ]);
  const flags = {
    ...DEFAULT_WORKSPACE_FEATURE_FLAGS,
    ...(workspace && CRINA_STABLE_WORKSPACE_SLUGS.has(workspace.slug) ? CRINA_STABLE_FEATURE_FLAGS : {}),
  };

  for (const record of records) {
    if (isKnownWorkspaceFeatureFlag(record.flag)) {
      flags[record.flag] = record.enabled;
    }
  }

  return flags;
}

export async function requireWorkspaceFeature(workspaceId: string, flag: WorkspaceFeatureFlag) {
  const flags = await getWorkspaceFeatureFlags(workspaceId);
  if (!flags[flag]) {
    notFound();
  }
}

export function filterNavGroupsByFeatureFlags(
  navGroups: NavGroup[],
  flags: WorkspaceFeatureFlagMap,
): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.featureFlag || flags[item.featureFlag]),
    }))
    .filter((group) => group.items.length > 0);
}
