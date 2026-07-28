import { notFound } from "next/navigation";

import { prisma } from "@corgtex/shared";
import {
  defaultWorkspaceFeatureFlags,
  financeCapabilityEnabled,
  type FinanceCapabilityKey,
  listWorkspaceFeatureFlagKeys,
  type ModuleAccessLevel,
  type WorkspaceFeatureFlagKey,
} from "@corgtex/domain/modules";

import type { NavGroup, WorkspaceNavCapability } from "@/lib/nav-config";

/** Effective module access by module key, used to hide `none`-access nav items. */
export type WorkspaceModuleAccessMap = Record<string, ModuleAccessLevel>;

// Derived from the Module Manifest registry (single source of truth).
export type WorkspaceFeatureFlag = WorkspaceFeatureFlagKey;

export type WorkspaceFeatureFlagMap = Record<WorkspaceFeatureFlag, boolean>;

export const DEFAULT_WORKSPACE_FEATURE_FLAGS: WorkspaceFeatureFlagMap =
  defaultWorkspaceFeatureFlags();

const WORKSPACE_FEATURE_FLAG_VALUES: WorkspaceFeatureFlag[] = listWorkspaceFeatureFlagKeys();

function isKnownWorkspaceFeatureFlag(flag: string): flag is WorkspaceFeatureFlag {
  return WORKSPACE_FEATURE_FLAG_VALUES.includes(flag as WorkspaceFeatureFlag);
}

export async function getWorkspaceFeatureFlags(workspaceId: string): Promise<WorkspaceFeatureFlagMap> {
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

  const flags = {
    ...DEFAULT_WORKSPACE_FEATURE_FLAGS,
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

export async function requireWorkspaceFinanceCapability(workspaceId: string, capability: FinanceCapabilityKey) {
  const flags = await getWorkspaceFeatureFlags(workspaceId);
  if (!financeCapabilityEnabled(flags, capability)) {
    notFound();
  }
}

export async function isWorkspaceFeatureEnabled(workspaceId: string, flag: WorkspaceFeatureFlag) {
  const flags = await getWorkspaceFeatureFlags(workspaceId);
  return flags[flag];
}

export async function isWorkspaceFinanceCapabilityEnabled(workspaceId: string, capability: FinanceCapabilityKey) {
  const flags = await getWorkspaceFeatureFlags(workspaceId);
  return financeCapabilityEnabled(flags, capability);
}

export type WorkspaceNavCapabilityMap = Partial<Record<WorkspaceNavCapability, boolean>>;

export function filterNavGroupsByWorkspaceAccess(
  navGroups: NavGroup[],
  flags: WorkspaceFeatureFlagMap,
  capabilities: WorkspaceNavCapabilityMap = {},
  moduleAccess?: WorkspaceModuleAccessMap,
): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (
        (!item.featureFlag || flags[item.featureFlag])
        && (!item.requiredCapability || Boolean(capabilities[item.requiredCapability]))
        // Hide modules whose resolved access is `none`. When no access map is
        // provided (callers that only know flags), this check is skipped.
        && (!moduleAccess || moduleAccess[item.moduleKey] !== "none")
      )),
    }))
    .filter((group) => group.items.length > 0);
}

export function filterNavGroupsByFeatureFlags(
  navGroups: NavGroup[],
  flags: WorkspaceFeatureFlagMap,
): NavGroup[] {
  return filterNavGroupsByWorkspaceAccess(navGroups, flags);
}
