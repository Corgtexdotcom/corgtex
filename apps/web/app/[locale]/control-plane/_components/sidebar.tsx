"use client";

import { usePathname } from "next/navigation";
import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  LayoutDashboard,
  Users,
  Bot,
  GitBranch,
  Activity,
  UserCheck,
  Cloud,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  onOpenChat: () => void;
  onOpenSearch: () => void;
  className?: string;
}

export function ControlPlaneSidebar({ onOpenChat, onOpenSearch, className }: SidebarProps) {
  const pathname = usePathname() || "";
  const t = useTranslations("controlPlane");
  const [isCollapsed, setIsCollapsed] = useState(false);

  const navItems = [
    {
      group: t("navGroups.fleet"),
      items: [
        {
          label: t("nav.dashboard"),
          href: "/control-plane",
          icon: LayoutDashboard,
          active: pathname.endsWith("/control-plane"),
        },
        {
          label: t("nav.customers"),
          href: "/control-plane#fleet",
          icon: Users,
          active: pathname.includes("/control-plane/deployments") || pathname.includes("/control-plane/customers"),
        },
        {
          label: t("nav.selfServe"),
          href: "/control-plane/self-serve",
          icon: Cloud,
          active: pathname.includes("/control-plane/self-serve"),
        },
      ],
    },
    {
      group: t("navGroups.observe"),
      items: [
        {
          label: t("nav.agents"),
          href: "/control-plane/agents",
          icon: Bot,
          active: pathname.includes("/control-plane/agents"),
        },
        {
          label: t("nav.releases"),
          href: "/control-plane/releases",
          icon: GitBranch,
          active: pathname.includes("/control-plane/releases"),
        },
      ],
    },
    {
      group: t("navGroups.operate"),
      items: [
        {
          label: t("nav.operations"),
          href: "/control-plane/operations",
          icon: Activity,
          active: pathname.includes("/control-plane/operations"),
        },
        {
          label: t("nav.users"),
          href: "/control-plane/users",
          icon: UserCheck,
          active: pathname.includes("/control-plane/users"),
        },
      ],
    },
  ];

  return (
    <aside
      className={cn(
        "flex flex-col h-screen sticky top-0 bg-bg-alt border-r border-line text-text transition-all duration-300 z-40 shrink-0",
        isCollapsed ? "w-16" : "w-64",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-line">
        {!isCollapsed && (
          <div className="flex items-center gap-2 font-bold text-lg tracking-wide text-white">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-500 shadow-md">
              C
            </span>
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
              Corgtex Ops
            </span>
          </div>
        )}
        {isCollapsed && (
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-500 shadow-md font-bold mx-auto">
            C
          </span>
        )}
        {!isCollapsed && (
          <button
            onClick={() => setIsCollapsed(true)}
            className="p-1.5 rounded-md hover:bg-surface-strong border border-transparent hover:border-line text-muted hover:text-white transition-all duration-150"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Expand trigger when collapsed */}
      {isCollapsed && (
        <div className="flex justify-center py-2 border-b border-line">
          <button
            onClick={() => setIsCollapsed(false)}
            className="p-1.5 rounded-md hover:bg-surface-strong border border-line text-muted hover:text-white transition-all duration-150"
            aria-label="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search Quick Launcher */}
      <div className="px-3 py-4">
        <button
          onClick={onOpenSearch}
          className={cn(
            "flex items-center gap-2 w-full text-muted hover:text-white bg-surface border border-line hover:border-line rounded-lg text-xs transition-all duration-150 py-2",
            isCollapsed ? "justify-center px-0 h-9" : "px-3"
          )}
          title={t("search.open")}
          aria-label={t("search.open")}
        >
          <Search className="w-4 h-4 shrink-0" />
          {!isCollapsed && (
            <div className="flex items-center justify-between w-full">
              <span>{t("search.placeholder")}</span>
              <kbd className="bg-surface-strong text-[10px] text-muted px-1.5 py-0.5 rounded border border-line">
                ⌘K
              </kbd>
            </div>
          )}
        </button>
      </div>

      {/* Navigation List */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-6 scrollbar-thin">
        {navItems.map((group) => (
          <div key={group.group} className="space-y-1">
            {!isCollapsed && (
              <h3 className="px-3 text-[10px] font-semibold text-muted tracking-wider uppercase mb-2">
                {group.group}
              </h3>
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm rounded-lg font-medium transition-all duration-150",
                    item.active
                      ? "bg-brand-600/10 text-brand-400 border border-brand-500/20 shadow-sm"
                      : "text-muted hover:text-text hover:bg-surface border border-transparent hover:border-line"
                  )}
                >
                  <Icon className={cn("w-4 h-4 shrink-0", item.active ? "text-brand-400" : "text-muted")} />
                  {!isCollapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer / Copilot Trigger */}
      <div className="p-3 border-t border-line">
        <button
          onClick={onOpenChat}
          className={cn(
            "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
            "bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white shadow-lg shadow-brand-950/20 hover:scale-[1.02]",
            isCollapsed && "justify-center p-2.5"
          )}
        >
          <Sparkles className="w-4 h-4 animate-pulse shrink-0" />
          {!isCollapsed && (
            <div className="flex flex-col items-start text-left min-w-0">
              <span className="font-semibold text-xs leading-none">Ops Copilot</span>
              <span className="text-[10px] text-brand-200 leading-none mt-1">Ready for queries</span>
            </div>
          )}
        </button>
      </div>
    </aside>
  );
}
