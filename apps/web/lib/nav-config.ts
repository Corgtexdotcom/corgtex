export type NavItem = {
  href: string;
  labelKey: string;
  icon: string;
};

export type NavGroup = {
  labelKey: string;
  items: NavItem[];
};

export const WORKSPACE_NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "workspace",
    items: [
      { href: "", labelKey: "home", icon: "◉" },
      { href: "/goals", labelKey: "goals", icon: "⌾" },
      { href: "/brain", labelKey: "brain", icon: "◈" },
      { href: "/members", labelKey: "members", icon: "⌂" },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { href: "/tensions", labelKey: "tensions", icon: "▵" },
      { href: "/actions", labelKey: "actions", icon: "✓" },
      { href: "/meetings", labelKey: "meetings", icon: "▫" },
      { href: "/leads", labelKey: "relationships", icon: "⊕" }, // Unified to "Relationships"
    ],
  },
  {
    labelKey: "governance",
    items: [
      { href: "/proposals", labelKey: "proposals", icon: "▤" },
      { href: "/circles", labelKey: "circles", icon: "◎" },
      { href: "/cycles", labelKey: "cycles", icon: "↻" },
    ],
  },
  {
    labelKey: "finance",
    items: [
      { href: "/finance", labelKey: "finance", icon: "¤" },
    ],
  },
  {
    labelKey: "system",
    items: [
      { href: "/governance", labelKey: "osMetrics", icon: "◒" },
      { href: "/audit", labelKey: "auditTrail", icon: "⚲" },
      { href: "/settings", labelKey: "settingsAgents", icon: "⎈" },
    ],
  },
];
