"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChatInterface } from "./chat/ChatInterface";
import { AiWorkspaceLaunchPanel } from "./AiWorkspaceLaunchPanel";
import type { NavGroup } from "@/lib/nav-config";
import type { AiWorkspaceLaunchState } from "@/lib/ai-workspace-launch";
import type { MobileCaptureAction } from "@/lib/workspace-add-actions";
import { WorkspaceNavIcon, WorkspaceUtilityIcon } from "./WorkspaceNavIcon";
import { buildMobileNavModel, containsActiveNavItem, isActiveWorkspacePath } from "./mobile-nav-model";

type MobileMode = "workspace" | "ai";
type MobileAiTab = "work" | "ask" | "capture";

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
  aiWorkspaceState: AiWorkspaceLaunchState;
  captureActions: MobileCaptureAction[];
  utilityActions: ReactNode;
};

const MODE_STORAGE_KEY = "corgtex.mobileMode";

function navHref(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href}`;
}

export function MobileWorkspaceShell({
  workspaceId,
  workspaceName,
  workspaceLabel,
  navGroups,
  unreadCount,
  conversations,
  aiWorkspaceState,
  captureActions,
  utilityActions,
}: MobileWorkspaceShellProps) {
  const pathname = usePathname() ?? "";
  const tNav = useTranslations("nav");
  const tMobile = useTranslations("mobile");
  const [mode, setModeState] = useState<MobileMode>("workspace");
  const [aiTab, setAiTab] = useState<MobileAiTab>("work");
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [hasLoadedStoredMode, setHasLoadedStoredMode] = useState(false);
  const lastViewedKeyRef = useRef<string | null>(null);

  const mobileNav = useMemo(() => buildMobileNavModel(navGroups, { reserveMoreSlot: true }), [navGroups]);
  const isMoreActive = containsActiveNavItem(mobileNav.overflowGroups, pathname, workspaceId);

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
    if (nextMode === "ai") {
      setIsMoreOpen(false);
    }
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
    setIsMoreOpen(false);
  }, [pathname]);

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
            {mobileNav.primaryItems.map((item) => {
              const isActive = isActiveWorkspacePath(pathname, workspaceId, item.href);

              return (
                <a
                  key={item.href}
                  href={navHref(workspaceId, item.href)}
                  className={isActive ? "active" : ""}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setMode("workspace", "bottom_nav")}
                >
                  <WorkspaceNavIcon name={item.icon} className="mobile-bottom-icon" />
                  <span>{tNav(item.labelKey as any)}</span>
                  {item.href === "/notifications" && unreadCount > 0 && (
                    <span className="mobile-bottom-badge">{unreadCount}</span>
                  )}
                </a>
              );
            })}
            <button
              type="button"
              className={isMoreOpen || isMoreActive ? "active" : ""}
              aria-expanded={isMoreOpen}
              aria-controls="mobile-more-menu"
              onClick={() => {
                setIsMoreOpen((open) => !open);
                setMode("workspace", "more_nav");
              }}
            >
              <WorkspaceUtilityIcon name="more" className="mobile-bottom-icon" />
              <span>{tMobile("moreTab")}</span>
            </button>
          </nav>
        )}
      </div>

      {mode === "workspace" && isMoreOpen && (
        <section id="mobile-more-menu" className="mobile-more-panel" role="dialog" aria-modal="true" aria-label={tMobile("morePanelLabel")}>
          <div className="mobile-more-header">
            <div>
              <h2>{tMobile("moreTitle")}</h2>
              <p>{tMobile("moreDescription")}</p>
            </div>
            <button type="button" className="mobile-icon-button" onClick={() => setIsMoreOpen(false)}>
              {tMobile("closeMore")}
            </button>
          </div>
          <div className="mobile-more-scroll">
            {mobileNav.overflowGroups.map((group) => (
              <div key={group.labelKey} className="mobile-more-group">
                <div className="mobile-more-group-title">{tNav(group.labelKey as any)}</div>
                <div className="mobile-more-links">
                  {group.items.map((item) => {
                    const isActive = isActiveWorkspacePath(pathname, workspaceId, item.href);

                    return (
                      <a
                        key={item.href}
                        href={navHref(workspaceId, item.href)}
                        className={isActive ? "mobile-more-link active" : "mobile-more-link"}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => {
                          setMode("workspace", "more_nav_link");
                          setIsMoreOpen(false);
                        }}
                      >
                        <WorkspaceNavIcon name={item.icon} className="mobile-more-icon" />
                        <span>{tNav(item.labelKey as any)}</span>
                        {item.href === "/notifications" && unreadCount > 0 && (
                          <span className="mobile-more-badge">{unreadCount}</span>
                        )}
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mobile-more-group mobile-more-utility-group">
              <div className="mobile-more-group-title">{tMobile("utilitiesTitle")}</div>
              <div className="mobile-utility-actions">
                {utilityActions}
              </div>
            </div>
          </div>
        </section>
      )}

      {mode === "ai" && (
        <section className="mobile-ai-workbench" aria-label={tMobile("aiWorkbenchLabel")}>
          <div className="mobile-ai-tabs" role="tablist" aria-label={tMobile("aiTabsLabel")}>
            <button
              type="button"
              role="tab"
              aria-selected={aiTab === "work"}
              className={aiTab === "work" ? "active" : ""}
              onClick={() => setAiTab("work")}
            >
              <WorkspaceUtilityIcon name="work" className="mobile-ai-tab-icon" />
              {tMobile("workTab")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={aiTab === "ask"}
              className={aiTab === "ask" ? "active" : ""}
              onClick={() => setAiTab("ask")}
            >
              <WorkspaceUtilityIcon name="ai" className="mobile-ai-tab-icon" />
              {tMobile("askTab")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={aiTab === "capture"}
              className={aiTab === "capture" ? "active" : ""}
              onClick={() => setAiTab("capture")}
            >
              <WorkspaceUtilityIcon name="capture" className="mobile-ai-tab-icon" />
              {tMobile("captureTab")}
            </button>
          </div>

          {aiTab === "work" && (
            <div className="mobile-ai-pane mobile-ai-pane-work" role="tabpanel">
              <AiWorkspaceLaunchPanel
                workspaceId={workspaceId}
                initialState={aiWorkspaceState}
                variant="mobile"
              />
            </div>
          )}

          {aiTab === "ask" && (
            <div className="mobile-ai-pane mobile-ai-pane-ask" role="tabpanel">
              <ChatInterface
                workspaceId={workspaceId}
                conversations={conversations}
                activeSessionId={null}
                compact={true}
                mobileMode={true}
              />
            </div>
          )}

          {aiTab === "capture" && (
            <div className="mobile-ai-pane mobile-ai-pane-capture" role="tabpanel">
              <div className="mobile-capture-panel">
                <div className="mobile-capture-header">
                  <WorkspaceUtilityIcon name="capture" className="mobile-capture-icon" />
                  <div>
                    <h2>{tMobile("captureTitle")}</h2>
                    <p>{tMobile("captureDescription")}</p>
                  </div>
                </div>
                {captureActions.length > 0 ? (
                  <div className="mobile-capture-actions">
                    {captureActions.map((action) => (
                      <a key={action.kind} href={action.href} className="mobile-capture-action">
                        <span>{action.label}</span>
                        <small>{action.description}</small>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="mobile-capture-empty">{tMobile("captureEmpty")}</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
