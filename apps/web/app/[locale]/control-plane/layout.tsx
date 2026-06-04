"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu, Bell, User, Search, Sparkles } from "lucide-react";
import { ControlPlaneSidebar } from "./_components/sidebar";
import { CommandPalette } from "./_components/command-palette";
import { OpsAgentChat } from "./_components/ops-agent-chat";
import { ControlPlaneLanguageSwitcher } from "./ControlPlaneLanguageSwitcher";
import { Link } from "@/i18n/routing";
import { cn } from "@/lib/utils";

export default function ControlPlaneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "";
  const t = useTranslations("controlPlane");
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile sidebar toggle
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Bind keyboard listener for Cmd+K command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Compute breadcrumbs dynamically based on path segments
  const getBreadcrumbs = () => {
    const segments = pathname.split("/").filter((s) => s && s !== "en" && s !== "es");
    // e.g. ["control-plane", "deployments", "atlas"]
    const crumbs = [];

    // Dashboard root
    crumbs.push({ label: t("navGroups.fleet"), href: "/control-plane" });

    if (segments.length > 1) {
      if (segments[1] === "agents") {
        crumbs.push({ label: t("nav.agents"), href: "/control-plane/agents" });
      } else if (segments[1] === "self-serve") {
        crumbs.push({ label: t("nav.selfServe"), href: "/control-plane/self-serve" });
      } else if (segments[1] === "releases") {
        crumbs.push({ label: t("nav.releases"), href: "/control-plane/releases" });
      } else if (segments[1] === "operations") {
        crumbs.push({ label: t("nav.operations"), href: "/control-plane/operations" });
      } else if (segments[1] === "users") {
        crumbs.push({ label: t("nav.users"), href: "/control-plane/users" });
      } else if (segments[1] === "deployments" && segments[2]) {
        crumbs.push({ label: t("nav.customers"), href: "/control-plane#fleet" });
        crumbs.push({ label: t("nav.details"), href: `/control-plane/deployments/${segments[2]}` });
      }
    }

    return crumbs;
  };

  // Detect active page title for the chat copilot context
  const getPageTitle = () => {
    const crumbs = getBreadcrumbs();
    return crumbs[crumbs.length - 1]?.label || "Ops Dashboard";
  };

  return (
    <div className="dark flex h-screen w-full bg-bg text-text-strong overflow-hidden font-sans">
      
      {/* Sidebar Navigation */}
      <ControlPlaneSidebar
        onOpenChat={() => setIsChatOpen((prev) => !prev)}
        onOpenSearch={() => setIsSearchOpen(true)}
        className={cn(
          "fixed inset-y-0 left-0 transform -translate-x-full md:translate-x-0 md:relative",
          isSidebarOpen && "translate-x-0"
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
        <header className="flex items-center justify-between h-16 px-6 bg-bg-alt border-b border-line shrink-0 z-10">
          <div className="flex items-center gap-4">
            {/* Mobile Hamburger Trigger */}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-1.5 rounded-lg bg-surface border border-line text-muted hover:text-white md:hidden"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Dynamic Breadcrumbs */}
            <nav className="flex items-center gap-1.5 text-xs text-muted font-medium">
              {getBreadcrumbs().map((crumb, idx, arr) => (
                <div key={crumb.href} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-muted">/</span>}
                  {idx === arr.length - 1 ? (
                    <span className="text-text-strong font-semibold tracking-wide capitalize">{crumb.label}</span>
                  ) : (
                    <Link href={crumb.href} className="hover:text-text transition-colors">
                      {crumb.label}
                    </Link>
                  )}
                </div>
              ))}
            </nav>
          </div>

          {/* Quick Header Actions */}
          <div className="flex items-center gap-3">
            <ControlPlaneLanguageSwitcher />

            {/* Quick search button */}
            <button
              onClick={() => setIsSearchOpen(true)}
              className="p-2 rounded-lg bg-surface border border-line text-muted hover:text-white hover:bg-surface-strong transition-all duration-150"
              title={t("search.open")}
              aria-label={t("search.open")}
            >
              <Search className="w-4 h-4" />
            </button>

            {/* Notification alert bells */}
            <button className="p-2 rounded-lg bg-surface border border-line text-muted hover:text-white hover:bg-surface-strong transition-all duration-150 relative">
              <Bell className="w-4 h-4" />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-brand-500 ring-2 ring-bg-alt" />
            </button>

            {/* User identity avatar */}
            <div className="flex items-center gap-2 pl-2 border-l border-line">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-indigo-600 border border-indigo-500 text-white font-bold text-xs select-none">
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
        <div className="flex-1 overflow-y-auto bg-bg p-6 relative">
          <div className="max-w-6xl mx-auto w-full">
            {children}
          </div>
        </div>

      </div>

      {/* Persistent Command Palette search overlay */}
      <CommandPalette isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />

      {/* Slide-out persistent Ops Agent Chat drawer */}
      <OpsAgentChat
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        pageContext={{
          path: pathname,
          title: getPageTitle(),
        }}
      />
    </div>
  );
}
