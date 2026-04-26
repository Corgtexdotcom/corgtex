import { notFound } from "next/navigation";

import { prisma } from "@corgtex/shared";

import type { NavGroup, WorkspaceNavFeatureFlag } from "@/lib/nav-config";

export type WorkspaceFeatureFlag =
  | WorkspaceNavFeatureFlag
  | "MULTILINGUAL";

export type WorkspaceFeatureFlagMap = Record<WorkspaceFeatureFlag, boolean>;

export const DEFAULT_WORKSPACE_FEATURE_FLAGS: WorkspaceFeatureFlagMap = {
  RELATIONSHIPS: true,
  AGENT_GOVERNANCE: true,
  OS_METRICS: true,
  MULTILINGUAL: false,
};

const WORKSPACE_FEATURE_FLAG_VALUES: WorkspaceFeatureFlag[] = [
  "RELATIONSHIPS",
  "AGENT_GOVERNANCE",
  "OS_METRICS",
  "MULTILINGUAL",
];

function isKnownWorkspaceFeatureFlag(flag: string): flag is WorkspaceFeatureFlag {
  return WORKSPACE_FEATURE_FLAG_VALUES.includes(flag as WorkspaceFeatureFlag);
}

export async function getWorkspaceFeatureFlags(workspaceId: string): Promise<WorkspaceFeatureFlagMap> {
  const flags = { ...DEFAULT_WORKSPACE_FEATURE_FLAGS };
  const records = await prisma.workspaceFeatureFlag.findMany({
    where: {
      workspaceId,
      flag: { in: WORKSPACE_FEATURE_FLAG_VALUES },
    },
    select: {
      flag: true,
      enabled: true,
    },
  });

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
