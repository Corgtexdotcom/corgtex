"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChatInterface } from "./chat/ChatInterface";
import type { NavGroup } from "@/lib/nav-config";
import { WorkspaceClaudeConnectorCta } from "./WorkspaceClaudeConnectorCta";
import { WorkspaceNavIcon } from "./WorkspaceNavIcon";

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
};

const MODE_STORAGE_KEY = "corgtex.mobileMode";
const PRIMARY_HREFS = ["", "/tensions", "/actions", "/proposals", "/tools"] as const;

function navHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

function isActivePath(pathname: string | null, workspaceId: string, href: string) {
  const currentPathname = pathname ?? "";
  const fullHref = navHref(workspaceId, href);
  if (href === "") return currentPathname.endsWith(`/workspaces/${workspaceId}`);
  return currentPathname.includes(fullHref);
}

export function MobileWorkspaceShell({
  workspaceId,
  workspaceName,
  workspaceLabel,
  navGroups,
  unreadCount,
  conversations,
}: MobileWorkspaceShellProps) {
  const pathname = usePathname() ?? "";
  const tNav = useTranslations("nav");
  const tMobile = useTranslations("mobile");
  const [mode, setModeState] = useState<MobileMode>("workspace");
  const [hasLoadedStoredMode, setHasLoadedStoredMode] = useState(false);
  const lastViewedKeyRef = useRef<string | null>(null);

  const primaryItems = useMemo(() => {
    const items = navGroups.flatMap((group) => group.items);
    return PRIMARY_HREFS
      .map((href) => items.find((item) => item.href === href))
      .filter((item): item is NonNullable<typeof item> => !!item);
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

        {mode === "workspace" && (
          <nav className="mobile-bottom-nav" aria-label={tMobile("bottomNavLabel")}>
            {primaryItems.map((item) => (
              <a
                key={item.href}
                href={navHref(workspaceId, item.href)}
                className={isActivePath(pathname, workspaceId, item.href) ? "active" : ""}
                onClick={() => setMode("workspace", "bottom_nav")}
              >
                <WorkspaceNavIcon name={item.icon} className="mobile-bottom-icon" />
                <span>{tNav(item.labelKey as any)}</span>
                {item.href === "" && unreadCount > 0 && (
                  <span className="mobile-bottom-badge">{unreadCount}</span>
                )}
              </a>
            ))}
          </nav>
        )}
      </div>

      {mode === "ai" && (
        <section className="mobile-ai-workbench" aria-label={tMobile("aiWorkbenchLabel")}>
          <WorkspaceClaudeConnectorCta />
          <ChatInterface
            workspaceId={workspaceId}
            conversations={conversations}
            activeSessionId={null}
            compact={true}
            mobileMode={true}
          />
        </section>
      )}
    </>
  );
}
