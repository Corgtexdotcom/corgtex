import {
  listNavModules,
  NAV_GROUP_ORDER,
  type WorkspaceFeatureFlagKey,
} from "@corgtex/domain/modules";

export type NavItem = {
  href: string;
  labelKey: string;
  icon: WorkspaceNavIconName;
  featureFlag?: WorkspaceNavFeatureFlag;
  requiredCapability?: WorkspaceNavCapability;
};

export type NavGroup = {
  labelKey: string;
  items: NavItem[];
};

// Any workspace feature flag may gate a nav item. Aliased to the registry's
// single-source-of-truth union so the nav vocabulary cannot drift.
export type WorkspaceNavFeatureFlag = WorkspaceFeatureFlagKey;

export type WorkspaceNavCapability =
  | "canManageAgentGovernance"
  | "canReviewAgentRuns"
  | "canUseOperatorConsole";

export type WorkspaceNavIconName =
  | "home"
  | "goals"
  | "brain"
  | "tools"
  | "built"
  | "members"
  | "tensions"
  | "actions"
  | "meetings"
  | "relationships"
  | "contextMaps"
  | "proposals"
  | "circles"
  | "cycles"
  | "finance"
  | "agents"
  | "governance"
  | "audit"
  | "notifications"
  | "settings";

// Derived from the Module Manifest registry. A parity test
// (nav-config.test.ts) asserts this equals the prior hand-written groups.
export const WORKSPACE_NAV_GROUPS: NavGroup[] = NAV_GROUP_ORDER
  .map((group) => ({
    labelKey: group,
    items: listNavModules()
      .filter((mod) => mod.nav?.group === group)
      .map((mod) => {
        const nav = mod.nav!;
        const item: NavItem = {
          href: nav.href,
          labelKey: nav.labelKey,
          icon: nav.icon as WorkspaceNavIconName,
        };
        if (mod.featureFlag) {
          item.featureFlag = mod.featureFlag.flag as WorkspaceNavFeatureFlag;
        }
        if (nav.requiredCapability) {
          item.requiredCapability = nav.requiredCapability as WorkspaceNavCapability;
        }
        return item;
      }),
  }))
  .filter((group) => group.items.length > 0);
