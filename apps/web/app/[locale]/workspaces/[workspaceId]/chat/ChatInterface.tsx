"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { marked } from "marked";

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

function renderAssistantMarkdown(markdown: string) {
  const escaped = markdown
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return marked.parse(escaped) as string;
}

export function ChatInterface({
  workspaceId,
  conversations: initialConversations,
  activeSessionId,
  compact = false,
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
  activeSessionId: string | null;
  compact?: boolean;
}) {
  const t = useTranslations("chat");
  const [conversations, setConversations] = useState(initialConversations);
  const [sessionId, setSessionId] = useState<string | null>(activeSessionId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
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
  }, [workspaceId]);

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
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function openConversation(id: string) {
    setShowNewChat(false);
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
    if (!input.trim() || loading) return;

    let currentSessionId = sessionId;
    if (!currentSessionId) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentKey: "assistant" }),
        });
        if (!res.ok) throw new Error("Failed to create session");
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

    let userMessage = input.trim();

    if (attachedFile) {
      try {
        const formData = new FormData();
        formData.append("file", attachedFile);
        formData.append("title", attachedFile.name);
        formData.append("source", "chat-upload");
        const uploadRes = await fetch(`/api/workspaces/${workspaceId}/documents`, {
          method: "POST",
          body: formData,
        });
        if (uploadRes.ok) {
          userMessage = `[Attached file: ${attachedFile.name}]\n*(File uploaded and queued for Brain absorption)*\n\n${userMessage}`;
        }
      } catch {
        // Continue sending the message even if the attachment upload fails.
      }
      removeAttachment();
    }

    setInput("");
    setLoading(true);
    setError(null);

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
        body: JSON.stringify({ message: userMessage }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || t("errorFailedToSend"));
      }
      if (!res.body) {
        throw new Error("Response stream is unavailable.");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFailedToSend"));
      setTurns((prev) => prev.filter((turn) => turn.id !== optimisticTurn.id));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className={isFullScreen ? "chat-fullscreen" : "chat-layout"}>
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
            ← Back
          </button>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {(!isFullScreen && (!compact || (!sessionId && !showNewChat))) && (
          <div className="chat-sidebar" style={compact ? { width: "100%", borderRight: "none" } : undefined}>
            <div className="chat-sidebar-header">
              <h2>Conversations</h2>
              <button className="chat-new-btn" type="button" onClick={openNewConversation}>+</button>
            </div>
            <div className="chat-session-list">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => openConversation(conversation.id)}
                  className={`chat-session-item ${conversation.id === sessionId ? "active" : ""}`}
                >
                  <div className="chat-session-topic">{conversation.topic || "New Conversation"}</div>
                  <div className="chat-session-meta">
                    <div className="chat-session-preview">{conversation.lastMessage || "..."}</div>
                    <div className="chat-session-time">
                      {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(conversation.updatedAt))}
                    </div>
                  </div>
                </button>
              ))}
              {conversations.length === 0 && (
                <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--muted)", fontSize: "0.85rem" }}>
                  No conversations yet
                </div>
              )}
            </div>
          </div>
        )}

        {(!compact || sessionId || isFullScreen || showNewChat) && (
        <div className="chat-main" style={compact ? { width: "100%" } : undefined}>
          {!isFullScreen && (
            <div className="chat-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                {compact && (
                  <button
                    onClick={() => { setSessionId(null); setShowNewChat(false); setEditingTopic(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: "0 4px" }}
                    title="Back to conversations"
                  >
                    ←
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
                    title={sessionId ? "Click to rename" : undefined}
                    onClick={() => {
                      if (!sessionId) return;
                      const currentTopic = conversations.find((c) => c.id === sessionId)?.topic || "";
                      setEditTopicValue(currentTopic);
                      setEditingTopic(true);
                    }}
                  >
                    {conversations.find((conversation) => conversation.id === sessionId)?.topic || "New Conversation"}
                  </div>
                )}
              </div>
              <button
                className="chat-fullscreen-toggle"
                onClick={() => setIsFullScreen(true)}
                title="Expand chat"
                type="button"
              >
                ⛶
              </button>
            </div>
          )}

          <div className="chat-messages">
            {turns.length === 0 ? (
              <div className="chat-empty">
                <h2>Start a conversation</h2>
                <div className="chat-empty-desc">
                  Ask about your workspace, draft proposals, or explore knowledge.
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
                      <div className="chat-message-author">Corgtex</div>
                      <div
                        className="markdown-body"
                        dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(turn.assistantMessage) }}
                      />
                    </div>
                  ) : (
                    <div className="chat-message assistant">
                      <div className="chat-message-author">Corgtex</div>
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
              <button onClick={removeAttachment} className="chat-attachment-remove" type="button">✕</button>
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
              title="Attach a file"
              type="button"
              disabled={loading}
            >
              +
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("placeholderTypeMessage")}
              rows={1}
              disabled={loading}
              className="chat-input"
            />
            <button
              onClick={() => void sendMessage()}
              disabled={loading || !input.trim()}
              className="chat-send-btn"
              type="button"
            >
              Send
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
