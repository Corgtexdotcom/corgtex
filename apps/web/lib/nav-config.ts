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

export type WorkspaceNavFeatureFlag =
  | "GOALS"
  | "TOOL_LINKS"
  | "FINANCE"
  | "BUILD_ARTIFACTS"
  | "RELATIONSHIPS"
  | "CYCLES"
  | "AGENT_GOVERNANCE"
  | "OS_METRICS";

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
  | "proposals"
  | "circles"
  | "cycles"
  | "finance"
  | "agents"
  | "governance"
  | "audit"
  | "settings";

export const WORKSPACE_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "workspace",
    items: [
      { href: "", labelKey: "home", icon: "home" },
      { href: "/goals", labelKey: "goals", icon: "goals", featureFlag: "GOALS" },
      { href: "/brain", labelKey: "brain", icon: "brain" },
      { href: "/tools", labelKey: "tools", icon: "tools", featureFlag: "TOOL_LINKS" },
      { href: "/built", labelKey: "built", icon: "built", featureFlag: "BUILD_ARTIFACTS" },
      { href: "/members", labelKey: "members", icon: "members" },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { href: "/tensions", labelKey: "tensions", icon: "tensions" },
      { href: "/actions", labelKey: "actions", icon: "actions" },
      { href: "/meetings", labelKey: "meetings", icon: "meetings" },
      { href: "/leads", labelKey: "relationships", icon: "relationships", featureFlag: "RELATIONSHIPS" },
    ],
  },
  {
    labelKey: "governance",
    items: [
      { href: "/proposals", labelKey: "proposals", icon: "proposals" },
      { href: "/circles", labelKey: "circles", icon: "circles" },
      { href: "/cycles", labelKey: "cycles", icon: "cycles", featureFlag: "CYCLES" },
    ],
  },
  {
    labelKey: "finance",
    items: [
      { href: "/finance", labelKey: "finance", icon: "finance", featureFlag: "FINANCE" },
    ],
  },
  {
    labelKey: "aiGovernance",
    items: [
      {
        href: "/agents",
        labelKey: "agentGovernance",
        icon: "agents",
        featureFlag: "AGENT_GOVERNANCE",
        requiredCapability: "canManageAgentGovernance",
      },
    ],
  },
  {
    labelKey: "system",
    items: [
      { href: "/governance", labelKey: "osMetrics", icon: "governance", featureFlag: "OS_METRICS" },
      { href: "/audit", labelKey: "auditTrail", icon: "audit" },
      { href: "/settings", labelKey: "settings", icon: "settings" },
    ],
  },
];
