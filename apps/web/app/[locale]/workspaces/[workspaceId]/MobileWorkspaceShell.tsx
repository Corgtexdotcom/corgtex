"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChatInterface } from "./chat/ChatInterface";
import { CommandMenuButton } from "./CommandMenuButton";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "../../../ThemeToggle";
import type { NavGroup } from "@/lib/nav-config";

type MobileMode = "workspace" | "ai";

type ConversationSummary = {
  id: string;
  topic: string | null;
  agentKey: string;
  status: string;
  updatedAt: string;
  lastMessage: string | null;
};

type MobileWorkspaceShellProps = {
  workspaceId: string;
  workspaceName: string;
  workspaceLabel: string;
  navGroups: NavGroup[];
  unreadCount: number;
  conversations: ConversationSummary[];
  showLanguageSwitcher: boolean;
  showPlatformAdmin: boolean;
};

const MODE_STORAGE_KEY = "corgtex.mobileMode";
const PRIMARY_HREFS = new Set(["", "/brain", "/actions"]);

function navHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

function isActivePath(pathname: string, workspaceId: string, href: string) {
  const fullHref = navHref(workspaceId, href);
  if (href === "") return pathname.endsWith(`/workspaces/${workspaceId}`);
  return pathname.includes(fullHref);
}

export function MobileWorkspaceShell({
  workspaceId,
  workspaceName,
  workspaceLabel,
  navGroups,
  unreadCount,
  conversations,
  showLanguageSwitcher,
  showPlatformAdmin,
}: MobileWorkspaceShellProps) {
  const pathname = usePathname();
  const tNav = useTranslations("nav");
  const tMobile = useTranslations("mobile");
  const tCommon = useTranslations("common");
  const [mode, setModeState] = useState<MobileMode>("workspace");
  const [hasLoadedStoredMode, setHasLoadedStoredMode] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const lastViewedKeyRef = useRef<string | null>(null);

  const primaryItems = useMemo(() => {
    const items = navGroups.flatMap((group) => group.items);
    const picked = ["", "/brain", "/actions"]
      .map((href) => items.find((item) => item.href === href))
      .filter((item): item is NonNullable<typeof item> => !!item);

    return picked.length > 0 ? picked : items.filter((item) => PRIMARY_HREFS.has(item.href)).slice(0, 3);
  }, [navGroups]);

  const trackMobileMode = useCallback((eventName: "mode_viewed" | "mode_changed", nextMode: MobileMode, options: {
    previousMode?: MobileMode;
    source?: string;
  } = {}) => {
    const payload = JSON.stringify({
      eventName,
      mode: nextMode,
      previousMode: options.previousMode,
      source: options.source,
      route: window.location.pathname,
      viewportWidth: window.innerWidth,
      coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    });
    const url = `/api/workspaces/${workspaceId}/mobile-analytics`;

    if (navigator.sendBeacon) {
      const body = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, body)) {
        return;
      }
    }

    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => null);
  }, [workspaceId]);

  function setMode(nextMode: MobileMode, source = "unknown") {
    setModeState((previousMode) => {
      if (previousMode !== nextMode) {
        trackMobileMode("mode_changed", nextMode, { previousMode, source });
      }
      return nextMode;
    });
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, nextMode);
    } catch {
      // Storage can be unavailable in private or restricted browsing contexts.
    }
  }

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
      if (stored === "workspace" || stored === "ai") {
        setModeState(stored);
      }
    } catch {
      // Keep the default workspace mode when storage is unavailable.
    } finally {
      setHasLoadedStoredMode(true);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.mobileMode = mode;
  }, [mode]);

  useEffect(() => {
    if (!hasLoadedStoredMode) return;
    const viewedKey = `${pathname}:${mode}`;
    if (lastViewedKeyRef.current === viewedKey) return;
    lastViewedKeyRef.current = viewedKey;
    trackMobileMode("mode_viewed", mode, { source: "route_view" });
  }, [hasLoadedStoredMode, mode, pathname, trackMobileMode]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMoreOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/login";
  }

  return (
    <>
      <div className="mobile-shell" aria-label={tMobile("shellLabel")}>
        <header className="mobile-topbar">
          <a
            href={navHref(workspaceId, "")}
            className="mobile-brand"
            onClick={() => setMode("workspace", "brand")}
          >
            <span className="mobile-brand-name">{workspaceName}</span>
            <span className="mobile-brand-label">{workspaceLabel}</span>
          </a>

          <div className="mobile-mode-switch" role="group" aria-label={tMobile("modeSwitchLabel")}>
            <button
              type="button"
              className={mode === "workspace" ? "active" : ""}
              aria-pressed={mode === "workspace"}
              onClick={() => setMode("workspace", "topbar_switch")}
            >
              {tMobile("workspaceMode")}
            </button>
            <button
              type="button"
              className={mode === "ai" ? "active" : ""}
              aria-pressed={mode === "ai"}
              onClick={() => setMode("ai", "topbar_switch")}
            >
              {tMobile("aiMode")}
            </button>
          </div>
        </header>

        <nav className="mobile-bottom-nav" aria-label={tMobile("bottomNavLabel")}>
          {primaryItems.map((item) => (
            <a
              key={item.href}
              href={navHref(workspaceId, item.href)}
              className={mode === "workspace" && isActivePath(pathname, workspaceId, item.href) ? "active" : ""}
              onClick={() => setMode("workspace", "bottom_nav")}
            >
              <span className="mobile-bottom-icon">{item.icon}</span>
              <span>{tNav(item.labelKey as any)}</span>
              {item.href === "" && unreadCount > 0 && (
                <span className="mobile-bottom-badge">{unreadCount}</span>
              )}
            </a>
          ))}
          <button
            type="button"
            className={mode === "ai" ? "active" : ""}
            onClick={() => setMode("ai", "bottom_nav")}
          >
            <span className="mobile-bottom-icon">◇</span>
            <span>{tMobile("aiMode")}</span>
          </button>
          <button
            type="button"
            className={isMoreOpen ? "active" : ""}
            aria-expanded={isMoreOpen}
            onClick={() => setIsMoreOpen(true)}
          >
            <span className="mobile-bottom-icon">☰</span>
            <span>{tMobile("more")}</span>
          </button>
        </nav>
      </div>

      {mode === "ai" && (
        <section className="mobile-ai-workbench" aria-label={tMobile("aiWorkbenchLabel")}>
          <ChatInterface
            workspaceId={workspaceId}
            conversations={conversations}
            activeSessionId={null}
            compact={true}
            mobileMode={true}
          />
        </section>
      )}

      {isMoreOpen && (
        <div className="mobile-sheet-backdrop" role="presentation" onClick={() => setIsMoreOpen(false)}>
          <section
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={tMobile("more")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-sheet-handle" />
            <div className="mobile-sheet-header">
              <div>
                <div className="mobile-sheet-title">{tMobile("more")}</div>
                <div className="mobile-sheet-subtitle">{workspaceName}</div>
              </div>
              <button type="button" className="mobile-icon-button" onClick={() => setIsMoreOpen(false)}>
                {tMobile("close")}
              </button>
            </div>

            <div className="mobile-sheet-actions">
              <button
                type="button"
                className="mobile-sheet-action"
                onClick={() => {
                  setMode("ai", "more_sheet");
                  setIsMoreOpen(false);
                }}
              >
                <span>◇</span>
                <span>{tMobile("openAi")}</span>
              </button>
              <button
                type="button"
                className="mobile-sheet-action"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("corgtex:open-command-palette"));
                  setIsMoreOpen(false);
                }}
              >
                <span>⌘</span>
                <span>{tCommon("commandMenu")}</span>
              </button>
            </div>

            <div className="mobile-more-list">
              {navGroups.map((group) => (
                <div key={group.labelKey} className="mobile-more-group">
                  <div className="mobile-more-group-label">{tNav(group.labelKey as any)}</div>
                  {group.items.map((item) => (
                    <a
                      key={item.href}
                      href={navHref(workspaceId, item.href)}
                      className="mobile-more-link"
                      onClick={() => {
                        setMode("workspace", "more_sheet_link");
                        setIsMoreOpen(false);
                      }}
                    >
                      <span className="ws-nav-icon">{item.icon}</span>
                      <span>{tNav(item.labelKey as any)}</span>
                      {item.href === "" && unreadCount > 0 && (
                        <span className="ws-notif-badge">{unreadCount}</span>
                      )}
                    </a>
                  ))}
                </div>
              ))}

              {showPlatformAdmin && (
                <div className="mobile-more-group">
                  <div className="mobile-more-group-label">{tNav("globalAdmin")}</div>
                  <a
                    href={navHref(workspaceId, "/admin")}
                    className="mobile-more-link"
                    onClick={() => {
                      setMode("workspace", "more_sheet_admin_link");
                      setIsMoreOpen(false);
                    }}
                  >
                    <span className="ws-nav-icon">✧</span>
                    <span>{tNav("platformAdmin")}</span>
                  </a>
                </div>
              )}
            </div>

            <div className="mobile-sheet-footer">
              {showLanguageSwitcher && <LanguageSwitcher />}
              <CommandMenuButton />
              <ThemeToggle />
              <a
                href={navHref(workspaceId, "/settings?tab=user")}
                className="mobile-more-link"
                onClick={() => {
                  setMode("workspace", "more_sheet_user_settings");
                  setIsMoreOpen(false);
                }}
              >
                <span className="ws-nav-icon">⎈</span>
                <span>{tMobile("userSettings")}</span>
              </a>
              <button type="button" className="mobile-more-link mobile-logout" onClick={() => void handleLogout()}>
                <span className="ws-nav-icon">↥</span>
                <span>{tCommon("logout")}</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
