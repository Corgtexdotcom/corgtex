export type NavItem = {
  href: string;
  labelKey: string;
  icon: string;
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
  | "BUILD_ARTIFACTS"
  | "FINANCE"
  | "RELATIONSHIPS"
  | "CYCLES"
  | "AGENT_GOVERNANCE"
  | "OS_METRICS";

export type WorkspaceNavCapability =
  | "canManageAgentGovernance"
  | "canReviewAgentRuns"
  | "canUseOperatorConsole";

export const WORKSPACE_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "workspace",
    items: [
      { href: "", labelKey: "home", icon: "◉" },
      { href: "/goals", labelKey: "goals", icon: "⌾", featureFlag: "GOALS" },
      { href: "/brain", labelKey: "brain", icon: "◈" },
      { href: "/tools", labelKey: "tools", icon: "⌘", featureFlag: "TOOL_LINKS" },
      { href: "/built", labelKey: "built", icon: "▣", featureFlag: "BUILD_ARTIFACTS" },
      { href: "/members", labelKey: "members", icon: "⌂" },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { href: "/tensions", labelKey: "tensions", icon: "▵" },
      { href: "/actions", labelKey: "actions", icon: "✓" },
      { href: "/meetings", labelKey: "meetings", icon: "▫" },
      { href: "/leads", labelKey: "relationships", icon: "⊕", featureFlag: "RELATIONSHIPS" },
    ],
  },
  {
    labelKey: "governance",
    items: [
      { href: "/proposals", labelKey: "proposals", icon: "▤" },
      { href: "/circles", labelKey: "circles", icon: "◎" },
      { href: "/cycles", labelKey: "cycles", icon: "↻", featureFlag: "CYCLES" },
    ],
  },
  {
    labelKey: "finance",
    items: [
      { href: "/finance", labelKey: "finance", icon: "¤", featureFlag: "FINANCE" },
    ],
  },
  {
    labelKey: "aiGovernance",
    items: [
      {
        href: "/agents",
        labelKey: "agentGovernance",
        icon: "⬡",
        featureFlag: "AGENT_GOVERNANCE",
        requiredCapability: "canManageAgentGovernance",
      },
    ],
  },
  {
    labelKey: "system",
    items: [
      { href: "/governance", labelKey: "osMetrics", icon: "◒", featureFlag: "OS_METRICS" },
      { href: "/audit", labelKey: "auditTrail", icon: "⚲" },
      { href: "/settings", labelKey: "settings", icon: "⎈" },
    ],
  },
];
