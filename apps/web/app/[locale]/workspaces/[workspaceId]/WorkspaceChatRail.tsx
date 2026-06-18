"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChatInterface } from "./chat/ChatInterface";
import {
  OPEN_WORKSPACE_CHAT_EVENT,
  SET_WORKSPACE_CHAT_PAGE_CONTEXT_EVENT,
  type OpenWorkspaceChatEventDetail,
  type SetWorkspaceChatPageContextEventDetail,
  type WorkspaceChatPageContext,
} from "./chat/page-context";
import { AiWorkspaceLaunchPanel } from "./AiWorkspaceLaunchPanel";
import type { AiWorkspaceLaunchState } from "@/lib/ai-workspace-launch";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

type ConversationSummary = {
  id: string;
  topic: string | null;
  agentKey: string;
  status: string;
  updatedAt: string;
  lastMessage: string | null;
};

type CompanyQuestionSummary = {
  id: string;
  questionText: string;
  confidence: number | null;
  priority: number;
  relatedConversationId: string | null;
  createdAt: string;
};

const STORAGE_KEY = "corgtex.workspaceChatRail";

function isWorkspaceHome(pathname: string, workspaceId: string) {
  const marker = `/workspaces/${workspaceId}`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return false;
  const workspacePath = pathname.slice(markerIndex);
  return workspacePath === marker || workspacePath === `${marker}/`;
}

export function WorkspaceChatRail({
  workspaceId,
  conversations,
  companyQuestions,
  aiWorkspaceState,
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
  companyQuestions: CompanyQuestionSummary[];
  aiWorkspaceState: AiWorkspaceLaunchState;
}) {
  const pathname = usePathname() ?? "";
  const defaultCollapsed = useMemo(() => !isWorkspaceHome(pathname, workspaceId), [pathname, workspaceId]);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [pageContext, setPageContext] = useState<WorkspaceChatPageContext | null>(null);
  const [openSignal, setOpenSignal] = useState(0);
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "open") {
        setIsCollapsed(false);
        return;
      }
      if (stored === "collapsed") {
        setIsCollapsed(true);
        return;
      }
    } catch {
      // Keep the route-based default when storage is unavailable.
    }
    setIsCollapsed(defaultCollapsed);
  }, [defaultCollapsed]);

  useEffect(() => {
    const layout = railRef.current?.closest(".ws-layout");
    layout?.classList.toggle("ws-layout-chat-collapsed", isCollapsed);
    return () => {
      layout?.classList.remove("ws-layout-chat-collapsed");
    };
  }, [isCollapsed]);

  useEffect(() => {
    function handleOpenChat(event: Event) {
      const detail = (event as CustomEvent<OpenWorkspaceChatEventDetail>).detail;
      setPageContext(detail?.pageContext ?? null);
      setIsCollapsed(false);
      setOpenSignal((value) => value + 1);
      try {
        window.localStorage.setItem(STORAGE_KEY, "open");
      } catch {
        // The rail still opens without persistent storage.
      }
    }

    window.addEventListener(OPEN_WORKSPACE_CHAT_EVENT, handleOpenChat);
    return () => window.removeEventListener(OPEN_WORKSPACE_CHAT_EVENT, handleOpenChat);
  }, []);

  useEffect(() => {
    function handleSetPageContext(event: Event) {
      const detail = (event as CustomEvent<SetWorkspaceChatPageContextEventDetail>).detail;
      setPageContext(detail?.pageContext ?? null);
    }

    setPageContext(window.__corgtexWorkspaceChatPageContext ?? null);
    window.addEventListener(SET_WORKSPACE_CHAT_PAGE_CONTEXT_EVENT, handleSetPageContext);
    return () => window.removeEventListener(SET_WORKSPACE_CHAT_PAGE_CONTEXT_EVENT, handleSetPageContext);
  }, []);

  const pageContextRoute = pageContext?.route ?? "";
  useEffect(() => {
    if (!pageContextRoute) return;
    const contextPath = pageContextRoute.split("?")[0];
    if (contextPath && pathname !== contextPath) {
      setPageContext(null);
    }
  }, [pageContextRoute, pathname]);

  function toggleCollapsed() {
    const isOpening = isCollapsed;
    setIsCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "open");
      } catch {
        // The visual toggle still works without persistent storage.
      }
      return next;
    });
    if (isOpening && pageContext) {
      setOpenSignal((value) => value + 1);
    }
  }

  return (
    <aside ref={railRef} className={`ws-agent-sidebar ${isCollapsed ? "ws-agent-sidebar-collapsed" : ""}`}>
      <button
        type="button"
        className="ws-agent-toggle"
        aria-label={isCollapsed ? "Open AI rail" : "Collapse AI rail"}
        aria-expanded={!isCollapsed}
        onClick={toggleCollapsed}
      >
        <WorkspaceUtilityIcon name="ai" className="ws-agent-toggle-icon" />
        <span className="ws-agent-toggle-text">AI</span>
      </button>
      <div className="ws-agent-chat-shell" hidden={isCollapsed} aria-hidden={isCollapsed}>
        <AiWorkspaceLaunchPanel
          workspaceId={workspaceId}
          initialState={aiWorkspaceState}
          variant="rail"
        />
        <ChatInterface
          workspaceId={workspaceId}
          conversations={conversations}
          companyQuestions={companyQuestions}
          activeSessionId={null}
          compact={true}
          pageContext={pageContext}
          openSignal={openSignal}
        />
      </div>
    </aside>
  );
}
