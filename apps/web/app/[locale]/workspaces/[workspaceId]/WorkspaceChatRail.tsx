"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChatInterface } from "./chat/ChatInterface";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

type ConversationSummary = {
  id: string;
  topic: string | null;
  agentKey: string;
  status: string;
  updatedAt: string;
  lastMessage: string | null;
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
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
}) {
  const pathname = usePathname() ?? "";
  const defaultCollapsed = useMemo(() => !isWorkspaceHome(pathname, workspaceId), [pathname, workspaceId]);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
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

  function toggleCollapsed() {
    setIsCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "open");
      } catch {
        // The visual toggle still works without persistent storage.
      }
      return next;
    });
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
        <ChatInterface
          workspaceId={workspaceId}
          conversations={conversations}
          activeSessionId={null}
          compact={true}
        />
      </div>
    </aside>
  );
}
