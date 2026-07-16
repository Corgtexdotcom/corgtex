"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { marked } from "marked";
import { formatConversationDate } from "./date-format";
import type { WorkspaceChatPageContext } from "./page-context";

type ConversationSummary = {
  id: string;
  topic: string | null;
  agentKey: string;
  status: string;
  updatedAt: string;
  lastMessage: string | null;
  roleOnboarding?: {
    id: string;
    status: string;
    roleName: string;
  } | null;
};

type CompanyQuestionSummary = {
  id: string;
  questionText: string;
  confidence: number | null;
  priority: number;
  relatedConversationId: string | null;
  createdAt: string;
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

const MAX_MESSAGE_LENGTH = 100_000;
const WARNING_LENGTH = 80_000;

export function ChatInterface({
  workspaceId,
  conversations: initialConversations,
  companyQuestions: initialCompanyQuestions = [],
  activeSessionId,
  compact = false,
  mobileMode = false,
  pageContext = null,
  openSignal = 0,
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
  companyQuestions?: CompanyQuestionSummary[];
  activeSessionId: string | null;
  compact?: boolean;
  mobileMode?: boolean;
  pageContext?: WorkspaceChatPageContext | null;
  openSignal?: number;
}) {
  const t = useTranslations("chat");
  const router = useRouter();
  const [conversations, setConversations] = useState(initialConversations);
  const [companyQuestions, setCompanyQuestions] = useState(initialCompanyQuestions);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(activeSessionId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<{ message: string; href: string; label: string } | null>(null);
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
      const loadedTurns = data.conversation.turns as Turn[];
      const lastTurn = loadedTurns.at(-1);
      const loadedConversation: ConversationSummary = {
        id: data.conversation.id,
        topic: data.conversation.topic,
        agentKey: data.conversation.agentKey,
        status: data.conversation.status,
        updatedAt: data.conversation.updatedAt,
        lastMessage: lastTurn?.assistantMessage || lastTurn?.userMessage || null,
        roleOnboarding: data.conversation.roleOnboarding
          ? {
            id: data.conversation.roleOnboarding.id,
            status: data.conversation.roleOnboarding.status,
            roleName: data.conversation.roleOnboarding.role.name,
          }
          : null,
      };
      setTurns(loadedTurns);
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.id === id);
        if (!existing) return [loadedConversation, ...prev];
        return prev.map((conversation) =>
          conversation.id === id
            ? { ...conversation, ...loadedConversation }
            : conversation
        );
      });
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

  useEffect(() => {
    setCompanyQuestions(initialCompanyQuestions);
  }, [initialCompanyQuestions]);

  function openNewConversation() {
    setSessionId(null);
    setActiveQuestionId(null);
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
    setActiveQuestionId(null);
    if (!compact) {
      window.history.pushState({}, "", `/workspaces/${workspaceId}/chat?session=${id}`);
    }
    void loadConversation(id);
  }

  async function openCompanyQuestion(question: CompanyQuestionSummary) {
    setLoading(true);
    setError(null);
    setShowMobileHistory(false);
    setEditingTopic(false);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/check-ins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start_company_understanding_conversation",
          checkInId: question.id,
        }),
      });
      if (!response.ok) throw new Error(t("errorFailedToLoad"));
      const data = await response.json();
      const conversation = data.conversation as ConversationSummary & { turns?: Turn[] };
      const loadedTurns = conversation.turns ?? [];
      setTurns(loadedTurns);
      setSessionId(conversation.id);
      setActiveQuestionId(question.id);
      setShowNewChat(false);
      setConversations((prev) => {
        const summary = {
          id: conversation.id,
          topic: conversation.topic ?? question.questionText.slice(0, 64),
          agentKey: conversation.agentKey ?? "company-understanding",
          status: conversation.status ?? "ACTIVE",
          updatedAt: conversation.updatedAt ?? new Date().toISOString(),
          lastMessage: loadedTurns.at(-1)?.assistantMessage?.slice(0, 100) ?? question.questionText.slice(0, 100),
        };
        const existing = prev.find((item) => item.id === summary.id);
        return existing ? prev.map((item) => (item.id === summary.id ? { ...item, ...summary } : item)) : [summary, ...prev];
      });
      setCompanyQuestions((prev) =>
        prev.map((item) => item.id === question.id ? { ...item, relatedConversationId: conversation.id } : item)
      );
      if (!compact) {
        window.history.pushState({}, "", `/workspaces/${workspaceId}/chat?session=${conversation.id}`);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFailedToLoad"));
    } finally {
      setLoading(false);
    }
  }

  async function skipCompanyQuestion(questionId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/check-ins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "skip_company_understanding",
          checkInId: questionId,
        }),
      });
      if (!response.ok) throw new Error(t("errorFailedToSend"));
      setCompanyQuestions((prev) => prev.filter((question) => question.id !== questionId));
      if (activeQuestionId === questionId) setActiveQuestionId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorFailedToSend"));
    }
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

  async function completeRoleOnboarding() {
    if (!sessionId) return;
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === sessionId && conversation.roleOnboarding
          ? {
            ...conversation,
            roleOnboarding: {
              ...conversation.roleOnboarding,
              status: "COMPLETED",
            },
          }
          : conversation
      )
    );

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/conversations/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleOnboardingStatus: "COMPLETED" }),
      });
      if (!response.ok) throw new Error(t("errorFailedToSend"));
      router.refresh();
    } catch {
      setError(t("errorFailedToSend"));
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
        if (uploadData.status === "needs_clarification" || uploadData.status === "needs_meeting_details") {
          const uploadMessage = uploadData.message || "Please add the missing meeting details and send again.";
          setError(uploadMessage);
          setErrorAction(uploadData.webUrl
            ? { message: uploadMessage, href: uploadData.webUrl, label: "Open meeting upload" }
            : null);
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

    const answeredQuestionId = activeQuestionId;
    if (answeredQuestionId) {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/check-ins`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkInId: answeredQuestionId,
            responseMd: userMessage,
            relatedConversationId: currentSessionId,
          }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || t("errorFailedToSend"));
        }
        setCompanyQuestions((prev) => prev.filter((question) => question.id !== answeredQuestionId));
        setActiveQuestionId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("errorFailedToSend"));
        setLoading(false);
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
      let shouldRefreshCurrentRoute = false;

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
              const payload = JSON.parse(line.slice(6)) as { text?: string; topic?: string; refreshCurrentRoute?: boolean };
              if (payload.topic) {
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === currentSessionId ? { ...c, topic: payload.topic! } : c
                  )
                );
              }
              if (payload.refreshCurrentRoute) {
                shouldRefreshCurrentRoute = true;
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
      if (shouldRefreshCurrentRoute) {
        router.refresh();
      } else if (answeredQuestionId) {
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
        {companyQuestions.length > 0 && (
          <div className="chat-unread-questions" aria-label={t("companyQuestionsTitle")}>
            <div className="chat-unread-header">
              <span>{t("companyQuestionsTitle")}</span>
              <span className="chat-unread-count">{companyQuestions.length}</span>
            </div>
            {companyQuestions.map((question) => (
              <div key={question.id} className={`chat-unread-question ${activeQuestionId === question.id ? "active" : ""}`}>
                <button
                  type="button"
                  className="chat-unread-question-open"
                  onClick={() => void openCompanyQuestion(question)}
                >
                  <span className="chat-unread-label">{t("companyQuestionUnread")}</span>
                  <span className="chat-unread-question-text">{question.questionText}</span>
                  {question.confidence !== null && (
                    <span className="chat-unread-meta">
                      {t("companyQuestionConfidence", { confidence: Math.round(question.confidence * 100) })}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="chat-unread-skip"
                  onClick={() => void skipCompanyQuestion(question.id)}
                >
                  {t("companyQuestionSkip")}
                </button>
              </div>
            ))}
          </div>
        )}
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => openConversation(conversation.id)}
            className={`chat-session-item ${conversation.id === sessionId ? "active" : ""}`}
          >
            <div className="chat-session-topic">{conversation.topic || t("newConversation")}</div>
            {conversation.roleOnboarding && (
              <div className="chat-session-preview">
                Role onboarding - {conversation.roleOnboarding.status.toLowerCase()}
              </div>
            )}
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

  const activeConversation = conversations.find((conversation) => conversation.id === sessionId) ?? null;
  const activeRoleOnboarding = activeConversation?.roleOnboarding ?? null;

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
                    style={{
                      fontWeight: 600,
                      fontSize: "0.95rem",
                      lineHeight: 1.25,
                      cursor: sessionId ? "pointer" : "default",
                      overflowWrap: "anywhere",
                    }}
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
              {activeRoleOnboarding && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <span className="tag info" style={{ fontSize: "0.72rem", padding: "3px 7px" }}>
                    {activeRoleOnboarding.roleName} - {activeRoleOnboarding.status.toLowerCase()}
                  </span>
                  {["PENDING", "ACTIVE"].includes(activeRoleOnboarding.status) && (
                    <button
                      className="secondary small"
                      type="button"
                      onClick={() => void completeRoleOnboarding()}
                    >
                      Complete onboarding
                    </button>
                  )}
                </div>
              )}
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

          {activeQuestionId && (
            <div className="chat-question-policy">
              {t("companyQuestionPolicy")}
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
              <span>{error}</span>
              {errorAction?.message === error ? (
                <>
                  {" "}
                  <a href={errorAction.href}>{errorAction.label}</a>
                </>
              ) : null}
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
    </div>
  );
}
