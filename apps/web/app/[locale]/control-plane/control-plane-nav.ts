type ControlPlaneNavKey =
  | "dashboard"
  | "customers"
  | "selfServe"
  | "agents"
  | "releases"
  | "recorders"
  | "operations"
  | "users";

type ControlPlaneNavGroupKey = "fleet" | "observe" | "operate";

export interface ControlPlaneNavItem {
  key: ControlPlaneNavKey;
  labelKey: `nav.${ControlPlaneNavKey}`;
  href: string;
  match: string[];
}

export interface ControlPlaneNavGroup {
  key: ControlPlaneNavGroupKey;
  labelKey: `navGroups.${ControlPlaneNavGroupKey}`;
  items: ControlPlaneNavItem[];
}

export const controlPlaneNavGroups: ControlPlaneNavGroup[] = [
  {
    key: "fleet",
    labelKey: "navGroups.fleet",
    items: [
      { key: "dashboard", labelKey: "nav.dashboard", href: "/control-plane", match: ["/control-plane"] },
      {
        key: "customers",
        labelKey: "nav.customers",
        href: "/control-plane#fleet",
        match: ["/control-plane/deployments", "/control-plane/customers"],
      },
      {
        key: "selfServe",
        labelKey: "nav.selfServe",
        href: "/control-plane/self-serve",
        match: ["/control-plane/self-serve"],
      },
    ],
  },
  {
    key: "observe",
    labelKey: "navGroups.observe",
    items: [
      { key: "agents", labelKey: "nav.agents", href: "/control-plane/agents", match: ["/control-plane/agents"] },
      { key: "releases", labelKey: "nav.releases", href: "/control-plane/releases", match: ["/control-plane/releases"] },
      { key: "recorders", labelKey: "nav.recorders", href: "/control-plane/recorders", match: ["/control-plane/recorders"] },
    ],
  },
  {
    key: "operate",
    labelKey: "navGroups.operate",
    items: [
      {
        key: "operations",
        labelKey: "nav.operations",
        href: "/control-plane/operations",
        match: ["/control-plane/operations"],
      },
      { key: "users", labelKey: "nav.users", href: "/control-plane/users", match: ["/control-plane/users"] },
    ],
  },
];

function normalizeControlPlanePathname(pathname: string) {
  const normalized = pathname || "";
  return normalized.replace(/^\/(en|es)(?=\/)/, "") || "/control-plane";
}

export function isControlPlaneNavItemActive(pathname: string, item: ControlPlaneNavItem) {
  const normalized = normalizeControlPlanePathname(pathname);
  if (item.key === "dashboard") return normalized === "/control-plane";
  return item.match.some((prefix) => normalized.startsWith(prefix));
}

export function getControlPlaneBreadcrumbs(pathname: string) {
  const normalized = normalizeControlPlanePathname(pathname);
  const segments = normalized.split("/").filter(Boolean);
  const crumbs: Array<{ labelKey: string; href: string }> = [
    { labelKey: "navGroups.fleet", href: "/control-plane" },
  ];

  const section = segments[1];
  if (!section) return crumbs;

  const navItem = controlPlaneNavGroups.flatMap((group) => group.items).find((item) => {
    if (item.key === "dashboard") return false;
    return item.match.some((prefix) => normalized.startsWith(prefix));
  });

  if (navItem) {
    crumbs.push({ labelKey: navItem.labelKey, href: navItem.href });
  }
  if (section === "deployments" && segments[2]) {
    crumbs.push({ labelKey: "nav.details", href: `/control-plane/deployments/${segments[2]}` });
  }

  return crumbs;
}
