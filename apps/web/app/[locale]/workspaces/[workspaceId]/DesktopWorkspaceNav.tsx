"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { NavGroup } from "@/lib/nav-config";
import { WorkspaceNavIcon, WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

function navHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

function workspacePathname(pathname: string, workspaceId: string) {
  const marker = `/workspaces/${workspaceId}`;
  const markerIndex = pathname.indexOf(marker);
  return markerIndex >= 0 ? pathname.slice(markerIndex) : pathname;
}

function isActiveWorkspacePath(pathname: string, workspaceId: string, href: string) {
  const currentPath = workspacePathname(pathname, workspaceId);
  const fullHref = navHref(workspaceId, href);

  if (href === "") {
    return currentPath === fullHref || currentPath === `${fullHref}/`;
  }

  return currentPath === fullHref || currentPath.startsWith(`${fullHref}/`);
}

export function DesktopWorkspaceNav({
  workspaceId,
  navGroups,
  unreadCount,
  showPlatformAdmin,
  controlPlaneHref,
}: {
  workspaceId: string;
  navGroups: NavGroup[];
  unreadCount: number;
  showPlatformAdmin: boolean;
  controlPlaneHref: string;
}) {
  const pathname = usePathname() ?? "";
  const tNav = useTranslations("nav");

  return (
    <nav className="ws-nav">
      {navGroups.map((group) => (
        <div key={group.labelKey} className="ws-nav-group">
          <div className="ws-nav-group-title muted">
            {tNav(group.labelKey as any)}
          </div>
          {group.items.map((item) => {
            const isActive = isActiveWorkspacePath(pathname, workspaceId, item.href);

            return (
              <a
                key={item.href}
                href={navHref(workspaceId, item.href)}
                className={`ws-nav-link ${isActive ? "ws-nav-link-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <WorkspaceNavIcon name={item.icon} />
                {tNav(item.labelKey as any)}
                {item.href === "/notifications" && unreadCount > 0 && (
                  <span className="ws-notif-badge">{unreadCount}</span>
                )}
              </a>
            );
          })}
        </div>
      ))}

      {showPlatformAdmin && (
        <div className="ws-nav-group">
          <div className="ws-nav-group-title muted">
            {tNav("globalAdmin")}
          </div>
          <a href={controlPlaneHref} className="ws-nav-link">
            <WorkspaceUtilityIcon name="platformAdmin" />
            {tNav("platformAdmin")}
          </a>
        </div>
      )}
    </nav>
  );
}
