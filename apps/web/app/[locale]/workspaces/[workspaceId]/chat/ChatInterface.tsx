"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { marked } from "marked";
import { BrainAnswerExport } from "./BrainAnswerExport";
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

type ExportContext = { workspaceId: string; conversationId: string; turns: Turn[] };

type ChatRequest = {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

type ConversationCreation = { promise: Promise<string>; sessionId?: string; uncertain: boolean };

type ChatDraft = {
  questionId?: string | null;
  creation?: ConversationCreation;
  input: string; attachedFile: File | null; uploadedMessage?: string;
  uncertainSend?: {
    kind: "send" | "question"; token: object; reconciled: boolean;
    questionId?: string; questionPending?: boolean; questionsRevision?: number;
  };
};
type UploadResult = { status?: string; message?: string; webUrl?: string | null; error?: { code?: string; message?: string } };

const EMPTY_COMPANY_QUESTIONS: CompanyQuestionSummary[] = [];

const UNCERTAIN_CREATION = "A conversation may already have been created. Check your history before trying again; trying again may create another empty conversation.";
const UNCERTAIN_SEND = "Your previous send may already be saved. Review this conversation before restoring the draft; sending it again may create a duplicate.";
const UNCERTAIN_QUESTION = "Your answer may already be saved. Reload questions and review this conversation before restoring the draft.";

function knownApplicationRejection(status: number, body: unknown) {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  return [400, 401, 403, 404, 409, 413, 415, 422].includes(status)
    && error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string";
}

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
  historyLimited = false,
  companyQuestions: initialCompanyQuestions = EMPTY_COMPANY_QUESTIONS,
  activeSessionId,
  compact = false,
  mobileMode = false,
  pageContext = null,
  openSignal = 0,
}: {
  workspaceId: string;
  conversations: ConversationSummary[];
  historyLimited?: boolean;
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
  const [exportContext, setExportContext] = useState<ExportContext | null>(null);
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
  const requestRef = useRef<ChatRequest | null>(null);
  const draftsRef = useRef(new Map<string | null, ChatDraft>());
  const uploadsRef = useRef(new WeakMap<File, Promise<UploadResult>>());
  const questionWritesRef = useRef(new Set<string>());
  const questionSnapshotRef = useRef(initialCompanyQuestions);
  const questionRevisionRef = useRef(0);
  const questionRefreshRef = useRef<string | null>(null);
  const [questionRefreshTick, setQuestionRefreshTick] = useState(0);
  const [, updateDraftState] = useState(0);
  const draftSessionRef = useRef(activeSessionId);
  const draftRef = useRef<ChatDraft>({ input: "", attachedFile: null });
  const workspaceRef = useRef(workspaceId);
  const controlledSelectionRef = useRef<{ workspaceId: string; activeSessionId: string | null } | null>(null);

  const cancelRequest = useCallback(() => {
    const request = requestRef.current;
    requestRef.current = null;
    request?.controller.abort();
    void request?.reader?.cancel().catch(() => {});
  }, []);

  const beginRequest = useCallback(() => {
    cancelRequest();
    const request: ChatRequest = { controller: new AbortController(), reader: null };
    requestRef.current = request;
    return request;
  }, [cancelRequest]);

  const isCurrentRequest = useCallback((request: ChatRequest) =>
    requestRef.current === request && !request.controller.signal.aborted, []);

  function updateInput(value: string) {
    if (draftRef.current.uncertainSend || draftRef.current.creation?.uncertain) return;
    draftRef.current = { ...draftRef.current, input: value };
    draftsRef.current.set(draftSessionRef.current, draftRef.current);
    setInput(value);
  }

  function updateAttachment(file: File | null) {
    if (draftRef.current.uncertainSend || draftRef.current.creation?.uncertain) return;
    draftRef.current = { ...draftRef.current, attachedFile: file, uploadedMessage: undefined };
    draftsRef.current.set(draftSessionRef.current, draftRef.current);
    setAttachedFile(file);
  }

  const selectDraft = useCallback((id: string | null) => {
    draftSessionRef.current = id;
    let draft = draftsRef.current.get(id);
    const unassigned = draftsRef.current.get(null);
    if (id && unassigned?.creation?.sessionId === id && !draft?.input && !draft?.attachedFile && !draft?.uncertainSend) {
      draft = { ...unassigned, creation: undefined };
      draftsRef.current.delete(null);
    }
    draft ??= { input: "", attachedFile: null };
    const questionId = draft.questionId === undefined
      ? (id ? initialCompanyQuestions.find(question => question.relatedConversationId === id && !questionWritesRef.current.has(question.id))?.id : undefined)
      : draft.questionId;
    draft = { ...draft, questionId };
    draftsRef.current.set(id, draft);
    draftRef.current = draft;
    setActiveQuestionId(questionId ?? null);
    setInput(draft.uncertainSend ? "" : draft.input);
    setAttachedFile(draft.uncertainSend ? null : draft.attachedFile);
    if (fileInputRef.current) fileInputRef.current.value = "";
    updateDraftState(value => value + 1);
  }, [initialCompanyQuestions]);

  const acknowledgeDraftRead = useCallback((id: string) => {
    const draft = draftsRef.current.get(id);
    if (!draft?.uncertainSend) return undefined;
    if (draft.uncertainSend.kind === "question") return "question";
    const reconciled = { ...draft, uncertainSend: { ...draft.uncertainSend, reconciled: true } };
    draftsRef.current.set(id, reconciled);
    if (draftSessionRef.current === id) draftRef.current = reconciled;
    return "send";
  }, []);

  function restoreDraft() {
    if (!draftRef.current.uncertainSend?.reconciled) return;
    const questionId = draftRef.current.uncertainSend.questionId;
    let restoredQuestionId = draftRef.current.questionId;
    if (questionId) {
      const stillOffered = initialCompanyQuestions.some(question => question.id === questionId);
      if (stillOffered) questionWritesRef.current.delete(questionId);
      setCompanyQuestions(initialCompanyQuestions.filter(question => !questionWritesRef.current.has(question.id)));
      restoredQuestionId = stillOffered ? questionId : null;
    }
    const restored = { ...draftRef.current, questionId: restoredQuestionId, uncertainSend: undefined };
    draftsRef.current.set(draftSessionRef.current, restored);
    selectDraft(draftSessionRef.current);
    setError(null);
    setErrorAction(null);
  }

  function discardDraft() {
    const uncertain = draftRef.current.uncertainSend;
    if (uncertain?.kind === "question" && (uncertain.questionPending || !uncertain.reconciled)) return;
    const questionId = uncertain?.questionId;
    if (questionId) {
      if (initialCompanyQuestions.some(question => question.id === questionId)) questionWritesRef.current.delete(questionId);
      setCompanyQuestions(initialCompanyQuestions.filter(question => !questionWritesRef.current.has(question.id)));
      setActiveQuestionId(previous => previous === questionId ? null : previous);
      refreshQuestionsWhenIdle();
    }
    draftsRef.current.set(draftSessionRef.current, { input: "", attachedFile: null, questionId: null });
    selectDraft(draftSessionRef.current);
    setError(null);
    setErrorAction(null);
  }

  function retryConversationCreation() {
    if (!draftRef.current.creation?.uncertain) return;
    draftRef.current = { ...draftRef.current, creation: undefined };
    draftsRef.current.set(draftSessionRef.current, draftRef.current);
    selectDraft(draftSessionRef.current);
    setError(null);
    setErrorAction(null);
  }

  function refreshQuestionsWhenIdle() {
    if (workspaceRef.current !== workspaceId) return;
    questionRefreshRef.current = workspaceId;
    setQuestionRefreshTick(previous => previous + 1);
  }

  useEffect(() => {
    if (loading || requestRef.current || questionRefreshRef.current !== workspaceId) return;
    questionRefreshRef.current = null;
    router.refresh();
  }, [loading, questionRefreshTick, router, workspaceId]);

  useEffect(() => () => {
    controlledSelectionRef.current = null;
    cancelRequest();
  }, [workspaceId, cancelRequest]);

  useEffect(() => {
    if (workspaceRef.current === workspaceId) return;
    workspaceRef.current = workspaceId;
    draftsRef.current.clear();
    uploadsRef.current = new WeakMap();
    questionWritesRef.current = new Set();
    questionSnapshotRef.current = initialCompanyQuestions;
    questionRevisionRef.current = 0;
    questionRefreshRef.current = null;
    selectDraft(activeSessionId);
    setConversations(initialConversations);
    setCompanyQuestions(initialCompanyQuestions);
    setActiveQuestionId(null);
    setSessionId(activeSessionId);
    setTurns([]);
    setExportContext(null);
    setLoading(false);
    setError(null);
    setErrorAction(null);
    setEditingTopic(false);
    setShowNewChat(mobileMode);
    setShowMobileHistory(false);
  }, [workspaceId, activeSessionId, initialConversations, initialCompanyQuestions, mobileMode, selectDraft]);

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
    const request = beginRequest();
    selectDraft(id);
    setSessionId(id);
    setTurns([]);
    setExportContext(null);
    setLoading(true);
    setError(null);
    setErrorAction(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${id}`, { signal: request.controller.signal });
      if (!isCurrentRequest(request)) return;
      if (!res.ok) throw new Error(t("errorFailedToLoad"));
      const data = await res.json();
      if (!isCurrentRequest(request)) return;
      if (data.conversation?.id !== id || !Array.isArray(data.conversation.turns)) {
        throw new Error(t("errorFailedToLoad"));
      }
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
      setExportContext({ workspaceId, conversationId: id, turns: loadedTurns });
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
      const uncertain = acknowledgeDraftRead(id);
      setError(uncertain === "question" ? UNCERTAIN_QUESTION : uncertain ? UNCERTAIN_SEND : null);
    } catch {
      if (!isCurrentRequest(request)) return;
      setError(t("errorFailedToLoad"));
    } finally {
      if (isCurrentRequest(request)) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [t, workspaceId, beginRequest, isCurrentRequest, selectDraft, acknowledgeDraftRead]);

  useEffect(() => {
    const previous = controlledSelectionRef.current;
    if (previous?.workspaceId === workspaceId && previous.activeSessionId === activeSessionId) return;
    controlledSelectionRef.current = { workspaceId, activeSessionId };
    if (activeSessionId) {
      void loadConversation(activeSessionId);
    } else {
      cancelRequest();
      selectDraft(null);
      setSessionId(null);
      setTurns([]);
      setExportContext(null);
      setLoading(false);
    }
  }, [workspaceId, activeSessionId, loadConversation, cancelRequest, selectDraft]);

  useEffect(() => {
    if (questionSnapshotRef.current !== initialCompanyQuestions) {
      questionSnapshotRef.current = initialCompanyQuestions;
      questionRevisionRef.current++;
      for (const [id, draft] of draftsRef.current) {
        const uncertain = draft.uncertainSend;
        if (uncertain?.kind === "question" && !uncertain.questionPending
          && (uncertain.questionsRevision ?? 0) < questionRevisionRef.current) {
          const reconciled = { ...draft, uncertainSend: { ...uncertain, reconciled: true } };
          draftsRef.current.set(id, reconciled);
          if (draftSessionRef.current === id) draftRef.current = reconciled;
        }
      }
    }
    setCompanyQuestions(initialCompanyQuestions.filter(question => !questionWritesRef.current.has(question.id)));
    if (sessionId && draftSessionRef.current === sessionId && draftRef.current.questionId === undefined) {
      const related = initialCompanyQuestions.find(question => question.relatedConversationId === sessionId && !questionWritesRef.current.has(question.id));
      if (related) {
        draftRef.current = { ...draftRef.current, questionId: related.id };
        draftsRef.current.set(sessionId, draftRef.current);
        setActiveQuestionId(related.id);
      }
    }
    if (activeQuestionId && draftRef.current.questionId !== activeQuestionId && !questionWritesRef.current.has(activeQuestionId)
      && !initialCompanyQuestions.some(question => question.id === activeQuestionId)) setActiveQuestionId(null);
  }, [initialCompanyQuestions, activeQuestionId, sessionId]);

  function openNewConversation() {
    cancelRequest();
    selectDraft(null);
    setLoading(false);
    setSessionId(null);
    setActiveQuestionId(null);
    setTurns([]);
    setExportContext(null);
    setError(null);
    setErrorAction(null);
    setEditingTopic(false);
    setShowMobileHistory(false);
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
    const request = beginRequest();
    selectDraft(sessionId);
    setTurns(previous => previous.filter(turn => !turn.id.startsWith("pending-")));
    setLoading(true);
    setError(null);
    setErrorAction(null);
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
        signal: request.controller.signal,
      });
      if (!isCurrentRequest(request)) return;
      if (!response.ok) throw new Error(t("errorFailedToLoad"));
      const data = await response.json();
      if (!isCurrentRequest(request)) return;
      const conversation = data.conversation as ConversationSummary & { turns?: Turn[] };
      const loadedTurns = conversation.turns ?? [];
      selectDraft(conversation.id);
      setTurns(loadedTurns);
      setExportContext({ workspaceId, conversationId: conversation.id, turns: loadedTurns });
      setSessionId(conversation.id);
      const linkedQuestionId = (draftRef.current.input || draftRef.current.attachedFile) && draftRef.current.questionId
        ? draftRef.current.questionId : question.id;
      draftRef.current = { ...draftRef.current, questionId: linkedQuestionId };
      draftsRef.current.set(conversation.id, draftRef.current);
      setActiveQuestionId(linkedQuestionId);
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
      if (!isCurrentRequest(request)) return;
      setError(err instanceof Error ? err.message : t("errorFailedToLoad"));
    } finally {
      if (isCurrentRequest(request)) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  async function skipCompanyQuestion(questionId: string) {
    const generation = questionWritesRef.current;
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
      if (workspaceRef.current !== workspaceId || questionWritesRef.current !== generation) return;
      if (!response.ok) throw new Error(t("errorFailedToSend"));
      generation.add(questionId);
      for (const [id, draft] of draftsRef.current) {
        if (draft.questionId !== questionId) continue;
        const next = { ...draft, questionId: null };
        draftsRef.current.set(id, next);
        if (draftSessionRef.current === id) draftRef.current = next;
      }
      setCompanyQuestions((prev) => prev.filter((question) => question.id !== questionId));
      setActiveQuestionId(previous => previous === questionId ? null : previous);
      router.refresh();
    } catch (err) {
      if (workspaceRef.current !== workspaceId || questionWritesRef.current !== generation) return;
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
    updateAttachment(file);
  }

  function removeAttachment() {
    updateAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function sendMessage() {
    if ((!input.trim() && !attachedFile) || loading || requestRef.current || draftRef.current.uncertainSend || draftRef.current.creation?.uncertain
      || (activeQuestionId && questionWritesRef.current.has(activeQuestionId))) return;

    const request = beginRequest();
    setLoading(true);
    setError(null);
    setErrorAction(null);

    try {
      let userMessage = input.trim();

      if (userMessage.length > MAX_MESSAGE_LENGTH) {
        setError(`This message is too long (${userMessage.length.toLocaleString()} characters). Please use the + button to upload it as a file instead.`);
        setLoading(false);
        return;
      }

      if (attachedFile && draftRef.current.uploadedMessage === undefined) {
        try {
          const file = attachedFile;
          const uploads = uploadsRef.current;
          let upload = uploads.get(file);
          if (!upload) {
            // An upload can already be ingested when chat navigation occurs.
            // Keep its outcome independently of the cancelled chat request;
            // revisiting this File must await/reuse that same upload.
            upload = (async () => {
              const formData = new FormData();
              formData.append("file", file);
              formData.append("title", file.name);
              formData.append("source", "chat-upload");
              if (userMessage) formData.append("message", userMessage);
              const uncertain = () => new Error("The upload may already be saved. Check Brain before attaching the file again.");
              let response: Response;
              try {
                response = await fetch(`/api/workspaces/${workspaceId}/chat/attachments`, { method: "POST", body: formData });
              } catch {
                // Retain this rejected attempt rather than silently replaying a
                // write whose response was lost. Reattaching is explicit.
                throw uncertain();
              }
              const data = await response.json().catch(() => { throw uncertain(); }) as UploadResult;
              if (!response.ok) {
                if (knownApplicationRejection(response.status, data)) {
                  uploads.delete(file);
                  throw new Error(data.message || data.error?.message || t("errorFailedToSend"));
                }
                throw uncertain();
              }
              return data;
            })();
            uploads.set(file, upload);
          }
          const uploadData = await upload;
          if (!isCurrentRequest(request)) return;
          if (uploadData.status === "needs_clarification" || uploadData.status === "needs_meeting_details") {
            uploads.delete(file);
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
          // Retain the uploaded reference for retries without uploading again.
          draftRef.current = { ...draftRef.current, uploadedMessage: attachmentMessage ?? "" };
          draftsRef.current.set(draftSessionRef.current, draftRef.current);
        } catch (err) {
          if (!isCurrentRequest(request)) return;
          setError(err instanceof Error ? err.message : t("errorFailedToSend"));
          return;
        }
      }
      if (attachedFile) {
        userMessage = [draftRef.current.uploadedMessage, userMessage].filter(Boolean).join("\n\n");
      }

      let currentSessionId = sessionId;
      if (!currentSessionId) {
        let creation = draftRef.current.creation;
        if (!creation) {
          const generation = questionWritesRef.current;
          const attempt: ConversationCreation = { promise: Promise.resolve(""), uncertain: false };
          creation = attempt;
          draftRef.current = { ...draftRef.current, creation: attempt };
          draftsRef.current.set(null, draftRef.current);
          attempt.promise = (async () => {
            let rejected = false;
            try {
              // Creation is a write. View cancellation cannot undo it, so keep
              // its receipt attached to this draft independently of selection.
              const response = await fetch(`/api/workspaces/${workspaceId}/conversations`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agentKey: "assistant" }),
              });
              const data = await response.json().catch(() => null);
              if (!response.ok) {
                rejected = knownApplicationRejection(response.status, data);
                throw new Error(data?.error?.message || t("errorFailedToCreate"));
              }
              if (typeof data?.session?.id !== "string" || !data.session.id) throw new Error(UNCERTAIN_CREATION);
              attempt.sessionId = data.session.id;
              if (workspaceRef.current === workspaceId && questionWritesRef.current === generation) {
                const summary: ConversationSummary = { id: data.session.id, topic: null, agentKey: "assistant", status: "ACTIVE",
                  updatedAt: new Date().toISOString(), lastMessage: null };
                setConversations(previous => previous.some(item => item.id === summary.id) ? previous : [summary, ...previous]);
              }
              return data.session.id as string;
            } catch (error) {
              if (rejected) {
                for (const [id, draft] of draftsRef.current) {
                  if (draft.creation !== attempt) continue;
                  const next = { ...draft, creation: undefined };
                  draftsRef.current.set(id, next);
                  if (draftSessionRef.current === id) draftRef.current = next;
                }
              } else attempt.uncertain = true;
              if (workspaceRef.current === workspaceId && questionWritesRef.current === generation) updateDraftState(value => value + 1);
              throw new Error(rejected && error instanceof Error ? error.message : UNCERTAIN_CREATION);
            }
          })();
        }
        try {
          currentSessionId = await creation.promise;
          if (!isCurrentRequest(request)) return;
          draftsRef.current.set(currentSessionId, { ...draftRef.current, creation: undefined });
          draftsRef.current.delete(null);
          selectDraft(currentSessionId);
          setSessionId(currentSessionId);
          setShowNewChat(false);
          if (!compact) window.history.pushState({}, "", `/workspaces/${workspaceId}/chat?session=${currentSessionId}`);
        } catch (error) {
          if (!isCurrentRequest(request)) return;
          setError(error instanceof Error ? error.message : t("errorFailedToCreate"));
          return;
        }
      }

      const answeredQuestionId = activeQuestionId;
      if (answeredQuestionId) {
        const questionWrites = questionWritesRef.current;
        const questionToken = {};
        questionWrites.add(answeredQuestionId);
        setCompanyQuestions(previous => previous.filter(question => question.id !== answeredQuestionId));
        draftRef.current = { ...draftRef.current, uncertainSend: {
          kind: "question", token: questionToken, questionId: answeredQuestionId,
          questionPending: true, questionsRevision: questionRevisionRef.current, reconciled: false,
        } };
        draftsRef.current.set(currentSessionId, draftRef.current);
        const settleQuestionDraft = (outcome: "committed" | "rejected" | "unknown") => {
          const uncertain = outcome === "unknown";
          if (questionWritesRef.current !== questionWrites || workspaceRef.current !== workspaceId) return;
          const draft = draftsRef.current.get(currentSessionId);
          if (!draft || !draft.uncertainSend || draft.uncertainSend.token !== questionToken) return;
          const next = { ...draft, questionId: outcome === "committed" ? null : draft.questionId, uncertainSend: uncertain ? {
            ...draft.uncertainSend, questionPending: false,
            questionsRevision: questionRevisionRef.current, reconciled: false,
          } : undefined };
          draftsRef.current.set(currentSessionId, next);
          if (draftSessionRef.current === currentSessionId) {
            draftRef.current = next;
            setInput(uncertain ? "" : next.input);
            setAttachedFile(uncertain ? null : next.attachedFile);
            if (!uncertain) {
              setError(previous => previous === UNCERTAIN_QUESTION ? null : previous);
              setErrorAction(previous => previous?.message === UNCERTAIN_QUESTION ? null : previous);
            }
          }
        };
        let rejected = false;
        try {
          // The answer write cannot be rolled back by changing chats. Track its
          // receipt independently, while the canceled chain must stop before
          // starting a conversation send or touching a different workspace.
          const response = await fetch(`/api/workspaces/${workspaceId}/check-ins`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              checkInId: answeredQuestionId,
              responseMd: userMessage,
              relatedConversationId: currentSessionId,
            }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            rejected = knownApplicationRejection(response.status, data);
            if (rejected) questionWrites.delete(answeredQuestionId);
            throw new Error(data?.error?.message || t("errorFailedToSend"));
          }
          if (data?.checkIn?.id !== answeredQuestionId) throw new Error(t("errorFailedToSend"));
          settleQuestionDraft("committed");
          if (questionWritesRef.current === questionWrites && workspaceRef.current === workspaceId) {
            setActiveQuestionId(previous => previous === answeredQuestionId ? null : previous);
          }
          if (!isCurrentRequest(request)) {
            refreshQuestionsWhenIdle();
            return;
          }
        } catch (err) {
          settleQuestionDraft(rejected ? "rejected" : "unknown");
          refreshQuestionsWhenIdle();
          if (!isCurrentRequest(request)) return;
          if (rejected) setError(err instanceof Error ? err.message : t("errorFailedToSend"));
          else {
            setError(UNCERTAIN_QUESTION);
            setErrorAction(null);
          }
          setLoading(false);
          return;
        }
      }

      // Keep the submitted draft in memory until success, so navigating away or
      // a failed stream can restore it without carrying it into another chat.
      setInput("");
      const optimisticTurn: Turn = {
        id: `pending-${Date.now()}`,
        sequenceNumber: turns.length + 1,
        userMessage,
        assistantMessage: "",
        createdAt: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, optimisticTurn]);
      let displayedTurnId = optimisticTurn.id;
      let committedTurnId: string | null = null;
      let reconciliationStarted = false;
      let shouldRefreshCurrentRoute = false;
      let definitelyRejected = false;

      // A canceled POST can commit without delivering its receipt. Preserve the
      // draft but gate its recovery before issuing the write, not in stale UI
      // cleanup. A read can show current history; it cannot prove non-commit.
      draftRef.current = { ...draftRef.current, uncertainSend: { kind: "send", token: {}, reconciled: false } };
      draftsRef.current.set(currentSessionId, draftRef.current);

      const reconcileCommittedTurn = async () => {
        reconciliationStarted = true;
        const committedResponse = await fetch(`/api/workspaces/${workspaceId}/conversations/${currentSessionId}`, { signal: request.controller.signal });
        if (!isCurrentRequest(request)) return;
        if (!committedResponse.ok) throw new Error(t("errorFailedToLoad"));
        const committedData = await committedResponse.json();
        if (!isCurrentRequest(request)) return;
        const persistedTurns = committedData.conversation?.turns as Turn[] | undefined;
        const persistedTurn = Array.isArray(persistedTurns)
          ? persistedTurns.find(turn => turn.id === committedTurnId && turn.assistantMessage) : undefined;
        if (committedData.conversation?.id !== currentSessionId || !Array.isArray(persistedTurns)
          || (committedTurnId && !persistedTurn)) {
          throw new Error(t("errorFailedToLoad"));
        }
        setTurns(persistedTurns);
        setExportContext({ workspaceId, conversationId: currentSessionId, turns: persistedTurns });
        acknowledgeDraftRead(currentSessionId);
        const lastTurn = persistedTurn ?? persistedTurns.at(-1);
        setConversations(previous => previous.map(conversation => conversation.id === currentSessionId
          ? { ...conversation, lastMessage: lastTurn?.assistantMessage?.slice(0, 100) || lastTurn?.userMessage?.slice(0, 100) || null,
            topic: conversation.topic || userMessage.slice(0, 60), updatedAt: new Date().toISOString() }
          : conversation));
        if (shouldRefreshCurrentRoute || answeredQuestionId) {
          questionRefreshRef.current = null;
          router.refresh();
        }
      };

      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${currentSessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userMessage, pageContext }),
          signal: request.controller.signal,
        });

        if (!isCurrentRequest(request)) {
          void res.body?.cancel().catch(() => {});
          return;
        }
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (!isCurrentRequest(request)) return;
          definitelyRejected = knownApplicationRejection(res.status, errData);
          throw new Error(errData.error?.message || (typeof errData.error === "string" ? errData.error : t("errorFailedToSend")));
        }
        if (!res.body) {
          throw new Error(t("errorStreamUnavailable"));
        }

        const reader = res.body.getReader();
        request.reader = reader;
        const decoder = new TextDecoder();
        let assistantMessage = "";
        let buffer = "";

        const updatePendingTurn = (nextMessage: string) => {
          if (!isCurrentRequest(request)) return;
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === displayedTurnId
                ? { ...turn, assistantMessage: nextMessage }
                : turn
            )
          );
        };

        const consumeBuffer = () => {
          if (!isCurrentRequest(request)) return;
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const payload = JSON.parse(line.slice(6)) as { text?: string; topic?: string; refreshCurrentRoute?: boolean; committedTurn?: { id: string; sequenceNumber: number; createdAt: string } };
                const committed = payload.committedTurn;
                if (!committedTurnId && committed && typeof committed.id === "string" && committed.id && !committed.id.startsWith("pending-")
                  && Number.isInteger(committed.sequenceNumber) && committed.sequenceNumber > 0 && typeof committed.createdAt === "string") {
                  const pendingId = displayedTurnId;
                  displayedTurnId = committed.id;
                  committedTurnId = committed.id;
                  setTurns(previous => previous.map(turn => turn.id === pendingId ? { ...turn, ...committed } : turn));
                  // This prompt is now persisted, including its upload reference.
                  // It must not become a resendable draft after navigation or a
                  // later stream/read failure.
                  draftRef.current = { ...draftRef.current, uncertainSend: undefined };
                  updateInput("");
                  removeAttachment();
                }
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
          if (!isCurrentRequest(request)) return;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consumeBuffer();
        }

        buffer += decoder.decode();
        consumeBuffer();

        if (committedTurnId) {
          await reconcileCommittedTurn();
        } else {
          throw new Error(t("errorStreamUnavailable"));
        }

      } catch (err) {
        if (!isCurrentRequest(request)) return;
        if (committedTurnId) {
          if (!reconciliationStarted) {
            try {
              await reconcileCommittedTurn();
              return;
            } catch { /* Keep the committed row and reload without reposting. */ }
          }
          if (isCurrentRequest(request)) {
            setError(t("errorFailedToLoad"));
            setErrorAction({ message: t("errorFailedToLoad"),
              href: `/workspaces/${workspaceId}/chat?session=${encodeURIComponent(currentSessionId)}`,
              label: t("conversationsTitle") });
          }
          return;
        }
        setTurns((prev) => prev.filter((turn) => turn.id !== displayedTurnId));
        if (definitelyRejected) {
          draftRef.current = { ...draftRef.current, uncertainSend: undefined };
          draftsRef.current.set(currentSessionId, draftRef.current);
          selectDraft(currentSessionId);
          setError(err instanceof Error ? err.message : t("errorFailedToSend"));
        } else {
          selectDraft(currentSessionId);
          setError(UNCERTAIN_SEND);
          try {
            await reconcileCommittedTurn();
          } catch { /* Retain uncertainty; canonical reload remains explicit. */ }
        }
      }
    } finally {
      request.reader?.releaseLock();
      if (isCurrentRequest(request)) {
        requestRef.current = null;
        setLoading(false);
        if (!mobileMode && !window.matchMedia("(pointer: coarse)").matches) {
          inputRef.current?.focus();
        }
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
        {historyLimited && <p role="status" className="chat-session-preview">{t("historyLimited")}</p>}
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
            {t(historyLimited ? "historyWindowEmpty" : "noConversations")}
          </div>
        )}
      </div>
    );
  }

  const activeConversation = conversations.find((conversation) => conversation.id === sessionId) ?? null;
  const activeRoleOnboarding = activeConversation?.roleOnboarding ?? null;
  const uncertainDraft = workspaceRef.current === workspaceId && draftSessionRef.current === sessionId
    ? draftRef.current.uncertainSend : undefined;
  const uncertainCreation = workspaceRef.current === workspaceId && draftSessionRef.current === sessionId
    && draftRef.current.creation?.uncertain;
  const draftBlocked = Boolean(uncertainDraft || uncertainCreation);
  const questionWritePending = Boolean(activeQuestionId && questionWritesRef.current.has(activeQuestionId));

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
                    onClick={() => {
                      cancelRequest();
                      selectDraft(null);
                      setLoading(false);
                      setSessionId(null);
                      setTurns([]);
                      setExportContext(null);
                      setActiveQuestionId(null);
                      setError(null);
                      setShowNewChat(false);
                      setEditingTopic(false);
                    }}
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
                      disabled={loading || draftBlocked || questionWritePending}
                      onClick={() => {
                        updateInput(starter);
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
              turns.map((turn) => {
                const persistedOutput = exportContext?.workspaceId === workspaceId && exportContext.conversationId === sessionId
                  ? exportContext.turns.find(persisted => persisted.id === turn.id) : undefined;
                return <div key={`${workspaceId}/${sessionId}/${turn.id}`} className="chat-turn" data-turn-id={turn.id}>
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
                      {sessionId && !loading && exportContext && persistedOutput && <BrainAnswerExport workspaceId={workspaceId} conversationId={sessionId} output={persistedOutput} turns={exportContext.turns} />}
                    </div>
                  ) : (
                    <div className="chat-message assistant">
                      <div className="chat-message-author">{t("authorCorgtex")}</div>
                      <div className="chat-typing">{t("thinking")}</div>
                    </div>
                  )}
                </div>;
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {(error || (!loading && (uncertainDraft || uncertainCreation))) && (
            <div className="form-message form-message-error" style={{ margin: "0 16px 8px" }}>
              <span>{error ?? (uncertainCreation ? UNCERTAIN_CREATION : uncertainDraft?.kind === "question" ? UNCERTAIN_QUESTION : UNCERTAIN_SEND)}</span>
              {errorAction?.message === error ? (
                <>
                  {" "}
                  <a href={errorAction.href}>{errorAction.label}</a>
                </>
              ) : null}
              {uncertainDraft && error && error !== (uncertainDraft.kind === "question" ? UNCERTAIN_QUESTION : UNCERTAIN_SEND)
                && <p>{uncertainDraft.kind === "question" ? UNCERTAIN_QUESTION : UNCERTAIN_SEND}</p>}
              {uncertainCreation && <div className="actions-inline">
                {error && error !== UNCERTAIN_CREATION && <p>{UNCERTAIN_CREATION}</p>}
                <button type="button" className="secondary small" disabled={loading} onClick={retryConversationCreation}>Retry creating conversation</button>
              </div>}
              {uncertainDraft && <div className="actions-inline" style={{ flexWrap: "wrap" }}>
                <button type="button" className="secondary small" disabled={loading || Boolean(uncertainDraft.questionPending)} onClick={() => {
                  if (uncertainDraft.kind === "question") refreshQuestionsWhenIdle();
                  else if (sessionId) void loadConversation(sessionId);
                }}>{uncertainDraft.kind === "question" ? "Reload questions" : "Reload conversation"}</button>
                <button type="button" className="secondary small" disabled={loading || !uncertainDraft.reconciled
                  || exportContext?.workspaceId !== workspaceId || exportContext?.conversationId !== sessionId} onClick={restoreDraft}>Restore draft</button>
                <button type="button" className="secondary small" disabled={loading || (uncertainDraft.kind === "question"
                  && (Boolean(uncertainDraft.questionPending) || !uncertainDraft.reconciled))} onClick={discardDraft}>Discard draft</button>
              </div>}
            </div>
          )}

          {attachedFile && (
            <div className="chat-attachment-bar">
              <span className="chat-attachment-name">{attachedFile.name}</span>
              <button
                aria-label={t("titleRemoveAttachment")}
                disabled={loading || draftBlocked || questionWritePending}
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
              disabled={loading || draftBlocked || questionWritePending}
            >
              {t("btnAttach")}
            </button>
            <div className="chat-input-field">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("placeholderTypeMessage")}
                rows={1}
                disabled={loading || draftBlocked || questionWritePending}
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
              disabled={loading || draftBlocked || questionWritePending || (!input.trim() && !attachedFile)}
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
