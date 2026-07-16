"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  applyMentionSelection,
  filterMentionTargets,
  getActiveMentionRange,
  type ActiveMentionRange,
  type DeliberationMentionTarget,
} from "@/lib/deliberation-mentions";
import { FormMessage } from "./FormMessage";
import { MarkdownEditor } from "./MarkdownEditor";

function isSameMentionRange(a: ActiveMentionRange | null, b: ActiveMentionRange | null) {
  return a?.start === b?.start && a?.end === b?.end && a?.query === b?.query;
}

type DeliberationComposerProps = {
  postAction?: (formData: FormData) => Promise<void>;
  apiEndpoint?: string;
  hiddenFields: Record<string, string>;
  entryTypes: Array<{ value: string; label: string; variant: string }>;
  targetOptions?: DeliberationMentionTarget[];
  title?: string;
};

function formDataJson(formData: FormData) {
  const payload: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && value.length > 0) {
      payload[key] = value;
    }
  }
  return payload;
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

function unknownErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function DeliberationComposer({ postAction, apiEndpoint, hiddenFields, entryTypes, targetOptions = [], title }: DeliberationComposerProps) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const [selectedType, setSelectedType] = useState(entryTypes[0]?.value || "REACTION");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [activeMention, setActiveMention] = useState<ActiveMentionRange | null>(null);
  const [activeTargetIndex, setActiveTargetIndex] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const t = useTranslations("deliberation");
  const filteredTargets = useMemo(() => (
    activeMention ? filterMentionTargets(targetOptions, activeMention.query) : []
  ), [activeMention, targetOptions]);
  const isMentionOpen = !!activeMention && targetOptions.length > 0;
  const activeOptionIndex = filteredTargets.length > 0
    ? Math.min(activeTargetIndex, filteredTargets.length - 1)
    : -1;
  const submitDisabled = isPending || (Boolean(apiEndpoint) && !isHydrated);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const syncMentionForCursor = (value: string, cursorIndex: number) => {
    const nextMention = getActiveMentionRange(value, cursorIndex);
    setActiveTargetIndex((currentIndex) => (
      isSameMentionRange(activeMention, nextMention) ? currentIndex : 0
    ));
    setActiveMention(nextMention);
  };

  const selectMentionTarget = (target: DeliberationMentionTarget) => {
    if (!activeMention) return;

    const next = applyMentionSelection(bodyMd, activeMention, target);
    setBodyMd(next.value);
    setSelectedTarget(target.value);
    setActiveMention(null);
    setActiveTargetIndex(0);

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursorIndex, next.cursorIndex);
    });
  };

  const handleBodyChange = (nextValue: string, event?: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBodyMd(nextValue);
    syncMentionForCursor(nextValue, event?.currentTarget.selectionStart ?? textareaRef.current?.selectionStart ?? nextValue.length);
  };

  const handleTextareaSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    syncMentionForCursor(bodyMd, event.currentTarget.selectionStart);
  };

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isMentionOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setActiveMention(null);
      setActiveTargetIndex(0);
      return;
    }

    if (filteredTargets.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveTargetIndex((current) => (current + 1) % filteredTargets.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveTargetIndex((current) => (current - 1 + filteredTargets.length) % filteredTargets.length);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMentionTarget(filteredTargets[activeOptionIndex]);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.set("bodyMd", bodyMd);
    formData.set("entryType", selectedType);
    formData.delete("targetCircleId");
    formData.delete("targetMemberId");
    if (selectedTarget.startsWith("circle:")) {
      formData.set("targetCircleId", selectedTarget.slice("circle:".length));
    } else if (selectedTarget.startsWith("member:")) {
      formData.set("targetMemberId", selectedTarget.slice("member:".length));
    }

    startTransition(async () => {
      try {
        if (apiEndpoint) {
          const response = await fetch(apiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formDataJson(formData)),
          });
          if (!response.ok) {
            throw new Error(await responseErrorMessage(response, t("entryPostFailed")));
          }
          router.refresh();
        } else if (postAction) {
          await postAction(formData);
        } else {
          throw new Error(t("entryPostFailed"));
        }
        setMessage({ type: "success", text: t("entryPosted") });
        const form = e.target as HTMLFormElement;
        form.reset();
        setBodyMd("");
        setSelectedTarget("");
        setActiveMention(null);
        setActiveTargetIndex(0);
        setTimeout(() => setMessage(null), 3000);
      } catch (err: unknown) {
        setMessage({ type: "error", text: unknownErrorMessage(err, t("entryPostFailed")) });
      }
    });
  };

  return (
    <div className="delib-composer">
      {title && <h3 className="delib-composer-title">{title}</h3>}
      
      {message && (
        <div className="mb-4">
          <FormMessage type={message.type} message={message.text} />
        </div>
      )}

      <form onSubmit={handleSubmit} className="delib-composer-form" data-api-ready={apiEndpoint ? String(isHydrated) : undefined}>
        {Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

        <div className="delib-mention-field">
          <MarkdownEditor
            textareaRef={textareaRef}
            name="bodyMd"
            required
            value={bodyMd}
            onValueChange={handleBodyChange}
            placeholder={t("entryPlaceholder")}
            rows={4}
            disabled={submitDisabled}
            ariaAutocomplete={targetOptions.length > 0 ? "list" : undefined}
            ariaControls={isMentionOpen ? listboxId : undefined}
            ariaActivedescendant={activeOptionIndex >= 0 ? `${listboxId}-${activeOptionIndex}` : undefined}
            onSelect={handleTextareaSelect}
            onClick={handleTextareaSelect}
            onKeyDown={handleTextareaKeyDown}
          />
          {isMentionOpen && (
            <div id={listboxId} role="listbox" aria-label={t("mentionAriaLabel")} className="delib-mention-listbox">
              {filteredTargets.length > 0 ? (
                filteredTargets.map((target, index) => (
                  <button
                    key={target.value}
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeOptionIndex}
                    className={`delib-mention-option ${index === activeOptionIndex ? "delib-mention-option-active" : ""}`}
                    onMouseEnter={() => setActiveTargetIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectMentionTarget(target);
                    }}
                  >
                    <span className="delib-mention-option-name">{target.name}</span>
                    <span className="delib-mention-option-kind">{target.kind === "circle" ? t("targetKindCircle") : t("targetKindPerson")}</span>
                  </button>
                ))
              ) : (
                <div className="delib-mention-empty">{t("noMatchingTargets")}</div>
              )}
            </div>
          )}
        </div>

        <div className="delib-composer-toolbar">
          <div className="delib-inline-tags">
            {entryTypes.map((type) => (
              <button
                key={type.value}
                type="button"
                className={`delib-inline-tag ${selectedType === type.value ? "delib-inline-tag-active" : ""}`}
                onClick={() => setSelectedType(type.value)}
              >
                {type.label}
              </button>
            ))}
          </div>
          <button type="submit" disabled={submitDisabled} className="small">
            {isPending ? t("posting") : t("postEntry")}
          </button>
        </div>
      </form>
    </div>
  );
}
