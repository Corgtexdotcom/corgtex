import type { NavGroup, NavItem } from "@/lib/nav-config";

const MOBILE_PRIMARY_SLOTS = 5;
const MOBILE_PRIMARY_SLOTS_WITH_MORE = 4;

function navHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

function workspacePathname(pathname: string, workspaceId: string) {
  const marker = `/workspaces/${workspaceId}`;
  const markerIndex = pathname.indexOf(marker);
  return markerIndex >= 0 ? pathname.slice(markerIndex) : pathname;
}

export function isActiveWorkspacePath(pathname: string | null, workspaceId: string, href: string) {
  const currentPath = workspacePathname(pathname ?? "", workspaceId);
  const fullHref = navHref(workspaceId, href);

  if (href === "") {
    return currentPath === fullHref || currentPath === `${fullHref}/`;
  }

  return currentPath === fullHref || currentPath.startsWith(`${fullHref}/`);
}

export function shouldHideMobileBottomNavForWorkspacePath(
  pathname: string | null,
  workspaceId: string,
  addKind?: string | null,
) {
  const currentPath = workspacePathname(pathname ?? "", workspaceId);
  const addPath = navHref(workspaceId, "/add");
  if (currentPath === addPath || currentPath === `${addPath}/`) {
    return addKind === "action";
  }

  const actionsPath = navHref(workspaceId, "/actions");
  const nestedActionPath = currentPath.startsWith(`${actionsPath}/`) ? currentPath.slice(actionsPath.length + 1) : "";
  if (!nestedActionPath) return false;

  const segments = nestedActionPath.split("/").filter(Boolean);
  return segments.length === 1 || (segments.length === 2 && segments[1] === "edit");
}

export function buildMobileNavModel(
  navGroups: NavGroup[],
  options: { reserveMoreSlot?: boolean } = {},
) {
  const flatItems = navGroups.flatMap((group) => group.items);
  const prioritizedItems = [...flatItems]
    .filter((item) => typeof item.mobilePrimaryOrder === "number")
    .sort((left, right) => {
      const orderDelta = (left.mobilePrimaryOrder ?? 0) - (right.mobilePrimaryOrder ?? 0);
      if (orderDelta !== 0) return orderDelta;
      return flatItems.indexOf(left) - flatItems.indexOf(right);
    });
  const prioritizedHrefs = new Set(prioritizedItems.map((item) => item.href));
  const fallbackItems = flatItems.filter((item) => !prioritizedHrefs.has(item.href));
  const orderedItems = [...prioritizedItems, ...fallbackItems];
  const primarySlotCount = options.reserveMoreSlot || orderedItems.length > MOBILE_PRIMARY_SLOTS
    ? MOBILE_PRIMARY_SLOTS_WITH_MORE
    : MOBILE_PRIMARY_SLOTS;
  const primaryItems = orderedItems.slice(0, primarySlotCount);
  const primaryHrefs = new Set(primaryItems.map((item) => item.href));
  const overflowGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !primaryHrefs.has(item.href)),
    }))
    .filter((group) => group.items.length > 0);

  return {
    primaryItems,
    overflowGroups,
  };
}

export function containsActiveNavItem(
  groups: Array<{ items: NavItem[] }>,
  pathname: string | null,
  workspaceId: string,
) {
  return groups.some((group) => group.items.some((item) => isActiveWorkspacePath(pathname, workspaceId, item.href)));
}
