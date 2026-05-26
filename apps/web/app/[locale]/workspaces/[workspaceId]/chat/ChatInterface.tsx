"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { marked } from "marked";
import { CLAUDE_CHAT_URL, CLAUDE_INSTALLER_PATH } from "@/lib/install-helpers";
import { formatConversationDate } from "./date-format";
import type { WorkspaceChatPageContext } from "./page-context";

type ConversationSummary = {
  id: string;
  topic: string | null;
  agentKey: string;
  status: string;
  updatedAt: string;
  lastMessage: string | null;
};

type Turn = {
  id: string;
  sequenceNumber: number;
  userMessage: string;
  assistantMessage: string;
  createdAt: string;
};

type McpConnectionsResponse = {
  claude?: {
    connected?: boolean;
    connectedAt?: string | null;
  };
};

function renderAssistantMarkdown(markdown: string) {
  const escaped = markdown
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return marked.parse(escaped) as string;
}

const MAX_MESSAGE_LENGTH = 100_000;
const WARNING_LENGTH = 80_000;
const CLAUDE_STATUS_POLL_INTERVAL_MS = 5_000;
const CLAUDE_STATUS_MAX_POLLS = 24;

function ClaudeConnectorFooter({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("chat");
  const [isConnected, setIsConnected] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let pollCount = 0;

    async function loadStatus() {
      pollCount += 1;
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
          cache: "no-store",
        });
        if (response.ok) {
          const data = await response.json() as McpConnectionsResponse;
          const connected = Boolean(data.claude?.connected);
          if (!cancelled) {
            setIsConnected(connected);
            setIsLoaded(true);
          }
          if (connected) return;
        } else if (!cancelled) {
          setIsConnected(false);
          setIsLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setIsConnected(false);
          setIsLoaded(true);
        }
      }

      if (!cancelled && pollCount < CLAUDE_STATUS_MAX_POLLS) {
        timeoutId = window.setTimeout(loadStatus, CLAUDE_STATUS_POLL_INTERVAL_MS);
      }
    }

    void loadStatus();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [workspaceId]);

  if (isConnected) {
    return (
      <div className="chat-claude-footer chat-claude-footer-connected">
        <span className="chat-claude-status-dot" aria-hidden="true" />
        <div className="chat-claude-footer-copy">
          <div className="chat-claude-footer-title">{t("claudeConnectedLabel")}</div>
        </div>
        <a className="chat-claude-footer-action" href={CLAUDE_CHAT_URL} target="_blank" rel="noreferrer">
          {t("btnOpenClaude")}
        </a>
      </div>
    );
  }

  return (
    <a
      href={CLAUDE_INSTALLER_PATH}
      target="_blank"
      rel="noreferrer"
      className="chat-claude-footer chat-claude-footer-link"
      aria-busy={!isLoaded}
    >
      <div className="chat-claude-footer-copy">
        <div className="chat-claude-footer-title">{t("connectClaudeLabel")}</div>
        <div className="chat-claude-footer-description">{t("connectClaudeDescription")}</div>
      </div>
    </a>
  );
}

export function ChatInterface({
  workspaceId,
  conversations: initialConversations,
  activeSessionId,
  compact = false,
  mobileMode = false,
  claudeFooterEnabled = true,
  pageContext = null,
  openSignal = 0,
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
  activeSessionId: string | null;
  compact?: boolean;
  mobileMode?: boolean;
  claudeFooterEnabled?: boolean;
  pageContext?: WorkspaceChatPageContext | null;
  openSignal?: number;
}) {
  const t = useTranslations("chat");
  const router = useRouter();
  const [conversations, setConversations] = useState(initialConversations);
  const [sessionId, setSessionId] = useState<string | null>(activeSessionId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [showNewChat, setShowNewChat] = useState(mobileMode);
  const [showMobileHistory, setShowMobileHistory] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [editTopicValue, setEditTopicValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [turns, scrollToBottom]);

  useEffect(() => {
    function handleEscapeKey(event: KeyboardEvent) {
      if (event.key === "Escape" && isFullScreen) {
        setIsFullScreen(false);
      }
    }

    document.addEventListener("keydown", handleEscapeKey);
    return () => document.removeEventListener("keydown", handleEscapeKey);
  }, [isFullScreen]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${id}`);
      if (!res.ok) throw new Error(t("errorFailedToLoad"));
      const data = await res.json();
      setTurns(data.conversation.turns);
      setSessionId(id);
      setError(null);
    } catch {
      setError(t("errorFailedToLoad"));
    }
  }, [t, workspaceId]);

  useEffect(() => {
    if (activeSessionId) {
      void loadConversation(activeSessionId);
    } else {
      setSessionId(null);
      setTurns([]);
    }
  }, [activeSessionId, loadConversation]);

  function openNewConversation() {
    setSessionId(null);
    setTurns([]);
    setError(null);
    setInput("");
    setEditingTopic(false);
    removeAttachment();
    setShowNewChat(true);
    if (!compact) {
      window.history.pushState({}, "", `/workspaces/${workspaceId}/chat`);
    }
    if (!mobileMode) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  useEffect(() => {
    if (!openSignal) return;
    setError(null);
    if (!sessionId && !showNewChat) {
      setShowNewChat(true);
    }
    window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [openSignal, sessionId, showNewChat]);

  function openConversation(id: string) {
    setShowNewChat(false);
    setShowMobileHistory(false);
    setEditingTopic(false);
    if (!compact) {
      window.history.pushState({}, "", `/workspaces/${workspaceId}/chat?session=${id}`);
    }
    void loadConversation(id);
  }

  async function handleRenameSave() {
    const trimmed = editTopicValue.trim();
    setEditingTopic(false);
    if (!trimmed || !sessionId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === sessionId ? { ...c, topic: trimmed } : c))
    );
    try {
      await fetch(`/api/workspaces/${workspaceId}/conversations/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed }),
      });
    } catch {
      // Rename is best-effort
    }
  }

  async function handleFileUpload(file: File) {
    setAttachedFile(file);
  }

  function removeAttachment() {
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function sendMessage() {
    if ((!input.trim() && !attachedFile) || loading) return;

    setLoading(true);
    setError(null);

    let userMessage = input.trim();

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      setError(`This message is too long (${userMessage.length.toLocaleString()} characters). Please use the + button to upload it as a file instead.`);
      setLoading(false);
      return;
    }

    if (attachedFile) {
      try {
        const formData = new FormData();
        formData.append("file", attachedFile);
        formData.append("title", attachedFile.name);
        formData.append("source", "chat-upload");
        if (userMessage) formData.append("message", userMessage);
        const uploadRes = await fetch(`/api/workspaces/${workspaceId}/chat/attachments`, {
          method: "POST",
          body: formData,
        });
        const uploadData = await uploadRes.json().catch(() => ({})) as {
          status?: string;
          message?: string;
          webUrl?: string | null;
        };
        if (!uploadRes.ok) {
          throw new Error(uploadData.message || t("errorFailedToSend"));
        }
        if (uploadData.status === "needs_clarification") {
          setError(uploadData.message || "Please add the missing meeting details and send again.");
          setLoading(false);
          inputRef.current?.focus();
          return;
        }
        const attachmentMessage = uploadData.webUrl
          ? `${uploadData.message}\n${uploadData.webUrl}`
          : uploadData.message;
        userMessage = [attachmentMessage, userMessage].filter(Boolean).join("\n\n");
        removeAttachment();
      } catch (err) {
        if (!userMessage) {
          setError(err instanceof Error ? err.message : t("errorFailedToSend"));
          setLoading(false);
          return;
        }
      }
    }

    let currentSessionId = sessionId;
    if (!currentSessionId) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentKey: "assistant" }),
        });
        if (!res.ok) throw new Error(t("errorFailedToCreate"));
        const data = await res.json();
        currentSessionId = data.session.id as string;
        const newSession: ConversationSummary = {
          id: currentSessionId,
          topic: null,
          agentKey: "assistant",
          status: "ACTIVE",
          updatedAt: new Date().toISOString(),
          lastMessage: null,
        };
        setConversations((prev) => [newSession, ...prev]);
        setSessionId(currentSessionId);
        setShowNewChat(false);
        if (!compact) {
          window.history.pushState({}, "", `/workspaces/${workspaceId}/chat?session=${currentSessionId}`);
        }
      } catch {
        setError(t("errorFailedToCreate"));
        return;
      }
    }

    setInput("");

    const optimisticTurn: Turn = {
      id: `pending-${Date.now()}`,
      sequenceNumber: turns.length + 1,
      userMessage,
      assistantMessage: "",
      createdAt: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, optimisticTurn]);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${currentSessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, pageContext }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || t("errorFailedToSend"));
      }
      if (!res.body) {
        throw new Error(t("errorStreamUnavailable"));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = "";
      let buffer = "";

      const updatePendingTurn = (nextMessage: string) => {
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === optimisticTurn.id
              ? { ...turn, assistantMessage: nextMessage }
              : turn
          )
        );
      };

      const consumeBuffer = () => {
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const payload = JSON.parse(line.slice(6)) as { text?: string; topic?: string };
              if (payload.topic) {
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === currentSessionId ? { ...c, topic: payload.topic! } : c
                  )
                );
              }
              if (payload.text) {
                assistantMessage += payload.text;
                updatePendingTurn(assistantMessage);
              }
            } catch {
              // Ignore malformed partial payloads and continue streaming.
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consumeBuffer();
      }

      buffer += decoder.decode();
      consumeBuffer();

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === currentSessionId
            ? {
                ...conversation,
                lastMessage: assistantMessage.slice(0, 100) || null,
                topic: conversation.topic || userMessage.slice(0, 60),
                updatedAt: new Date().toISOString(),
              }
            : conversation
        )
      );
      if (pageContext?.surface === "context-map") {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFailedToSend"));
      setTurns((prev) => prev.filter((turn) => turn.id !== optimisticTurn.id));
    } finally {
      setLoading(false);
      if (!mobileMode && !window.matchMedia("(pointer: coarse)").matches) {
        inputRef.current?.focus();
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !coarsePointer) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function renderConversationList() {
    return (
      <div className="chat-session-list">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => openConversation(conversation.id)}
            className={`chat-session-item ${conversation.id === sessionId ? "active" : ""}`}
          >
            <div className="chat-session-topic">{conversation.topic || t("newConversation")}</div>
            <div className="chat-session-meta">
              <div className="chat-session-preview">{conversation.lastMessage || t("emptyPreview")}</div>
              <div className="chat-session-time">
                {formatConversationDate(conversation.updatedAt)}
              </div>
            </div>
          </button>
        ))}
        {conversations.length === 0 && (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--muted)", fontSize: "0.85rem" }}>
            {t("noConversations")}
          </div>
        )}
      </div>
    );
  }

  const showClaudeConnectorFooter = compact && !isFullScreen && claudeFooterEnabled;

  return (
    <div className={`${isFullScreen ? "chat-fullscreen" : "chat-layout"} ${mobileMode ? "chat-mobile-mode" : ""}`}>
      {isFullScreen && (
        <div className="chat-header">
          <button
            onClick={() => setIsFullScreen(false)}
            className="nr-link"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "1rem",
              color: "var(--muted)",
            }}
            type="button"
          >
            {t("btnBack")}
          </button>
        </div>
      )}

      <div className="chat-body">
        {(!isFullScreen && (!compact || (!sessionId && !showNewChat && !mobileMode))) && (
          <div className="chat-sidebar" style={compact ? { width: "100%", borderRight: "none" } : undefined}>
            <div className="chat-sidebar-header">
              <h2>{t("conversationsTitle")}</h2>
              <button
                aria-label={t("newConversation")}
                className="chat-new-btn"
                type="button"
                onClick={openNewConversation}
              >
                {t("btnAttach")}
              </button>
            </div>
            {renderConversationList()}
          </div>
        )}

        {(!compact || sessionId || isFullScreen || showNewChat || mobileMode) && (
        <div className="chat-main" style={compact ? { width: "100%" } : undefined}>
          {!isFullScreen && (
            <div className="chat-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                {compact && !mobileMode && (
                  <button
                    onClick={() => { setSessionId(null); setShowNewChat(false); setEditingTopic(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: "0 4px" }}
                    title={t("titleBackToConversations")}
                    type="button"
                  >
                    {t("btnBackToConversations")}
                  </button>
                )}
                {mobileMode && (
                  <button
                    className="chat-mobile-history-btn"
                    type="button"
                    onClick={() => setShowMobileHistory(true)}
                  >
                    {t("btnHistory")}
                  </button>
                )}
                {editingTopic ? (
                  <input
                    type="text"
                    value={editTopicValue}
                    onChange={(e) => setEditTopicValue(e.target.value)}
                    onBlur={() => void handleRenameSave()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); void handleRenameSave(); }
                      if (e.key === "Escape") setEditingTopic(false);
                    }}
                    autoFocus
                    className="chat-rename-input"
                  />
                ) : (
                  <div
                    style={{ fontWeight: 600, fontSize: "0.95rem", cursor: sessionId ? "pointer" : "default" }}
                    title={sessionId ? t("titleClickToRename") : undefined}
                    onClick={() => {
                      if (!sessionId) return;
                      const currentTopic = conversations.find((c) => c.id === sessionId)?.topic || "";
                      setEditTopicValue(currentTopic);
                      setEditingTopic(true);
                    }}
                  >
                    {conversations.find((conversation) => conversation.id === sessionId)?.topic || t("newConversation")}
                  </div>
                )}
              </div>
              {mobileMode && (
                <button className="chat-new-btn" type="button" onClick={openNewConversation}>
                  {t("btnNew")}
                </button>
              )}
              <button
                className="chat-fullscreen-toggle"
                onClick={() => setIsFullScreen(true)}
                title={t("titleExpandChat")}
                type="button"
              >
                {t("btnExpandChat")}
              </button>
            </div>
          )}

          {mobileMode && showMobileHistory && (
            <div className="chat-mobile-history" role="dialog" aria-modal="true" aria-label={t("conversationsTitle")}>
              <div className="chat-mobile-history-header">
                <h2>{t("conversationsTitle")}</h2>
                <button type="button" className="chat-new-btn" onClick={openNewConversation}>
                  {t("btnNew")}
                </button>
                <button type="button" className="mobile-icon-button" onClick={() => setShowMobileHistory(false)}>
                  {t("btnClose")}
                </button>
              </div>
              {renderConversationList()}
            </div>
          )}

          <div className="chat-messages">
            {turns.length === 0 ? (
              <div className="chat-empty">
                <h2>{t("emptyStateTitle")}</h2>
                <div className="chat-empty-desc">
                  {t("emptyStateDesc")}
                </div>

                <div className="chat-starters">
                  {[
                    t("starter1"),
                    t("starter2"),
                    t("starter3"),
                  ].map((starter) => (
                    <button
                      key={starter}
                      onClick={() => {
                        setInput(starter);
                        inputRef.current?.focus();
                      }}
                      type="button"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="chat-turn">
                  <div className="chat-message user">
                    <div style={{ whiteSpace: "pre-wrap" }}>{turn.userMessage}</div>
                  </div>
                  {turn.assistantMessage ? (
                    <div className="chat-message assistant">
                      <div className="chat-message-author">{t("authorCorgtex")}</div>
                      <div
                        className="markdown-body"
                        dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(turn.assistantMessage) }}
                      />
                    </div>
                  ) : (
                    <div className="chat-message assistant">
                      <div className="chat-message-author">{t("authorCorgtex")}</div>
                      <div className="chat-typing">{t("thinking")}</div>
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {error && (
            <div className="form-message form-message-error" style={{ margin: "0 16px 8px" }}>
              {error}
            </div>
          )}

          {attachedFile && (
            <div className="chat-attachment-bar">
              <span className="chat-attachment-name">{attachedFile.name}</span>
              <button
                aria-label={t("titleRemoveAttachment")}
                onClick={removeAttachment}
                className="chat-attachment-remove"
                type="button"
              >
                {t("btnRemoveAttachment")}
              </button>
            </div>
          )}

          <div className="chat-input-bar">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt,.csv,.png,.jpg,.jpeg,.gif"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFileUpload(file);
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="chat-upload-btn"
              title={t("titleAttachFile")}
              type="button"
              disabled={loading}
            >
              {t("btnAttach")}
            </button>
            <div className="chat-input-field">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("placeholderTypeMessage")}
                rows={1}
                disabled={loading}
                className="chat-input"
                style={{ width: "100%" }}
              />
              {input.length > WARNING_LENGTH && (
                <div style={{ fontSize: "0.75rem", color: input.length > MAX_MESSAGE_LENGTH ? "var(--destructive)" : "var(--muted)", alignSelf: "flex-end", marginTop: "4px" }}>
                  {input.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}
                </div>
              )}
            </div>
            <button
              onClick={() => void sendMessage()}
              disabled={loading || (!input.trim() && !attachedFile)}
              className="chat-send-btn"
              type="button"
            >
              {t("btnSend")}
            </button>
          </div>
          </div>
        )}
      </div>
      {showClaudeConnectorFooter ? <ClaudeConnectorFooter workspaceId={workspaceId} /> : null}
    </div>
  );
}
