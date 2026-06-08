"use client";

import { usePathname } from "next/navigation";
import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { controlPlaneNavGroups, isControlPlaneNavItemActive } from "../control-plane-nav";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

export function ControlPlaneSidebar({ className, onNavigate }: SidebarProps) {
  const pathname = usePathname() || "";
  const t = useTranslations("controlPlane");

  return (
    <aside
      className={cn(
        "flex h-screen w-64 shrink-0 flex-col border-r border-line bg-bg-alt text-text",
        className
      )}
    >
      <div className="border-b border-line px-4 py-4">
        <div className="text-lg font-semibold tracking-tight text-white">Corgtex Ops</div>
        <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
          {t("title")}
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4 scrollbar-thin" aria-label="Control plane">
        {controlPlaneNavGroups.map((group) => (
          <div key={group.key} className="space-y-1">
            <h3 className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {t(group.labelKey)}
            </h3>
            {group.items.map((item) => {
              const active = isControlPlaneNavItemActive(pathname, item);
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "border-line bg-surface-strong text-white"
                      : "border-transparent text-muted hover:border-line hover:bg-surface hover:text-text"
                  )}
                >
                  <span className="truncate">{t(item.labelKey)}</span>
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-brand-400" aria-hidden />}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
