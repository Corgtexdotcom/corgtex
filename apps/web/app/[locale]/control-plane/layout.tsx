"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu } from "lucide-react";
import { ControlPlaneSidebar } from "./_components/sidebar";
import { ControlPlaneLanguageSwitcher } from "./ControlPlaneLanguageSwitcher";
import { Link } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import { getControlPlaneBreadcrumbs } from "./control-plane-nav";

export default function ControlPlaneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "";
  const t = useTranslations("controlPlane");
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const breadcrumbs = getControlPlaneBreadcrumbs(pathname);

  return (
    <div className="dark flex h-screen w-full bg-bg text-text-strong overflow-hidden font-sans">
      
      {/* Sidebar Navigation */}
      <ControlPlaneSidebar
        onNavigate={() => setIsSidebarOpen(false)}
        className={cn(
          "fixed inset-y-0 left-0 z-40 transform md:relative md:translate-x-0",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      />

      {/* Backdrop overlay for mobile sidebar */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Main Container Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden h-full">
        
        {/* Header Bar */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-bg-alt px-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="rounded-md border border-line bg-surface p-1.5 text-muted hover:text-white md:hidden"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <nav className="flex items-center gap-1.5 text-xs text-muted font-medium">
              {breadcrumbs.map((crumb, idx, arr) => (
                <div key={crumb.href} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-muted">/</span>}
                  {idx === arr.length - 1 ? (
                    <span className="text-text-strong font-semibold tracking-wide">{t(crumb.labelKey)}</span>
                  ) : (
                    <Link href={crumb.href} className="hover:text-text transition-colors">
                      {t(crumb.labelKey)}
                    </Link>
                  )}
                </div>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <ControlPlaneLanguageSwitcher />
            <div className="flex items-center gap-2 border-l border-line pl-3">
              <div className="flex h-8 w-8 select-none items-center justify-center rounded-md border border-line bg-surface text-xs font-semibold text-white">
                OP
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-xs font-semibold leading-none text-text">Operator</p>
                <p className="text-[10px] text-muted leading-none mt-1">Super Admin</p>
              </div>
            </div>
          </div>
        </header>

        {/* Scrollable Main Content Frame */}
        <div className="relative flex-1 overflow-y-auto bg-bg p-6">
          <div className="mx-auto w-full max-w-7xl">
            {children}
          </div>
        </div>

      </div>
    </div>
  );
}
