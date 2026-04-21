export type NavItem = {
  href: string;
  label: string;
  icon: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const WORKSPACE_NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "", label: "Home", icon: "◉" },
      { href: "/brain", label: "Brain", icon: "◈" },
      { href: "/members", label: "Members", icon: "⌂" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/tensions", label: "Tensions", icon: "▵" },
      { href: "/actions", label: "Actions", icon: "✓" },
      { href: "/meetings", label: "Meetings", icon: "▫" },
      { href: "/leads", label: "Relationships", icon: "⊕" }, // Unified to "Relationships"
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/proposals", label: "Proposals", icon: "▤" },
      { href: "/circles", label: "Circles", icon: "◎" },
      { href: "/cycles", label: "Cycles", icon: "↻" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/finance", label: "Finance", icon: "¤" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/governance", label: "OS Metrics", icon: "◒" },
      { href: "/audit", label: "Audit Trail", icon: "⚲" },
      { href: "/settings", label: "Settings & Agents", icon: "⎈" },
    ],
  },
];
