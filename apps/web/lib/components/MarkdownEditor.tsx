"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { htmlToMarkdown } from "@/lib/markdown-paste";
import { MarkdownRenderer } from "./MarkdownRenderer";

export function MarkdownEditor({
  name,
  defaultValue,
  value,
  onValueChange,
  placeholder,
  required,
  rows = 6,
  disabled,
  textareaRef,
  onSelect,
  onClick,
  onKeyDown,
  ariaAutocomplete,
  ariaControls,
  ariaActivedescendant,
}: {
  name: string;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string, event?: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  disabled?: boolean;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onSelect?: React.ReactEventHandler<HTMLTextAreaElement>;
  onClick?: React.MouseEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  ariaAutocomplete?: React.AriaAttributes["aria-autocomplete"];
  ariaControls?: string;
  ariaActivedescendant?: string;
}) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const [preview, setPreview] = useState(false);
  const t = useTranslations("shared.markdownEditor");
  const editorValue = value ?? internalValue;

  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    internalRef.current = node;
    if (typeof textareaRef === "function") {
      textareaRef(node);
    } else if (textareaRef && "current" in textareaRef) {
      (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    }
  }, [textareaRef]);

  const updateValue = useCallback((nextValue: string, event?: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue, event);
  }, [onValueChange, value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateValue(e.target.value, e);
  }, [updateValue]);

  const replaceSelection = useCallback((replacement: string, selectStartOffset = replacement.length, selectEndOffset = replacement.length) => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd } = textarea;
    const nextValue = `${editorValue.slice(0, selectionStart)}${replacement}${editorValue.slice(selectionEnd)}`;
    updateValue(nextValue);

    window.requestAnimationFrame(() => {
      textarea.focus();
      const nextStart = selectionStart + selectStartOffset;
      const nextEnd = selectionStart + selectEndOffset;
      textarea.setSelectionRange(nextStart, nextEnd);
    });
  }, [editorValue, updateValue]);

  const wrapSelection = useCallback((prefix: string, suffix = prefix, fallback = t("placeholderText")) => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const selected = editorValue.slice(textarea.selectionStart, textarea.selectionEnd) || fallback;
    const replacement = `${prefix}${selected}${suffix}`;
    replaceSelection(replacement, prefix.length, prefix.length + selected.length);
  }, [editorValue, replaceSelection, t]);

  const prefixLines = useCallback((prefix: string, fallback = t("listItem")) => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const selected = editorValue.slice(textarea.selectionStart, textarea.selectionEnd) || fallback;
    const replacement = selected
      .split("\n")
      .map((line) => `${prefix}${line || fallback}`)
      .join("\n");
    replaceSelection(replacement);
  }, [editorValue, replaceSelection, t]);

  const insertHeading = useCallback((level: 1 | 2) => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const selected = editorValue.slice(textarea.selectionStart, textarea.selectionEnd) || t("heading");
    const marker = `${"#".repeat(level)} `;
    replaceSelection(`${marker}${selected}`, marker.length, marker.length + selected.length);
  }, [editorValue, replaceSelection, t]);

  const insertLink = useCallback(() => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const selected = editorValue.slice(textarea.selectionStart, textarea.selectionEnd) || t("linkText");
    const replacement = `[${selected}](https://)`;
    replaceSelection(replacement, selected.length + 3, selected.length + 11);
  }, [editorValue, replaceSelection, t]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const html = event.clipboardData.getData("text/html");
    const markdown = htmlToMarkdown(html);
    if (!markdown) return;

    event.preventDefault();
    replaceSelection(markdown);
  }, [replaceSelection]);

  return (
    <div className="md-editor">
      <div className="md-editor-tabs">
        <button
          type="button"
          className={`md-editor-tab ${!preview ? "md-editor-tab-active" : ""}`}
          data-active={!preview}
          onClick={() => setPreview(false)}
        >
          {t("write")}
        </button>
        <button
          type="button"
          className={`md-editor-tab ${preview ? "md-editor-tab-active" : ""}`}
          data-active={preview}
          onClick={() => setPreview(true)}
        >
          {t("preview")}
        </button>
      </div>
      {!preview && (
        <div className="md-editor-toolbar" aria-label={t("toolbar")}>
          <button type="button" title={t("bold")} aria-label={t("bold")} onClick={() => wrapSelection("**")}>B</button>
          <button type="button" title={t("italic")} aria-label={t("italic")} onClick={() => wrapSelection("_")}>I</button>
          <button type="button" title={t("headingOne")} aria-label={t("headingOne")} onClick={() => insertHeading(1)}>H1</button>
          <button type="button" title={t("headingTwo")} aria-label={t("headingTwo")} onClick={() => insertHeading(2)}>H2</button>
          <button type="button" title={t("bulletedList")} aria-label={t("bulletedList")} onClick={() => prefixLines("- ")}>•</button>
          <button type="button" title={t("numberedList")} aria-label={t("numberedList")} onClick={() => prefixLines("1. ")}>1.</button>
          <button type="button" title={t("quote")} aria-label={t("quote")} onClick={() => prefixLines("> ")}>&gt;</button>
          <button type="button" title={t("link")} aria-label={t("link")} onClick={insertLink}>[]</button>
          <button type="button" title={t("code")} aria-label={t("code")} onClick={() => wrapSelection("`")}>{"{}"}</button>
        </div>
      )}
      <div className="md-editor-preview" style={{ display: preview ? "block" : "none" }}>
        {editorValue ? (
          <MarkdownRenderer markdown={editorValue} variant="document" />
        ) : (
          <span className="muted">{t("emptyPreview")}</span>
        )}
      </div>
      <textarea
        ref={setTextareaRef}
        name={name}
        value={editorValue}
        onChange={handleChange}
        onPaste={handlePaste}
        onSelect={onSelect}
        onClick={onClick}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        required={required}
        rows={rows}
        disabled={disabled}
        className="md-editor-textarea"
        aria-autocomplete={ariaAutocomplete}
        aria-controls={ariaControls}
        aria-activedescendant={ariaActivedescendant}
        style={{ display: preview ? "none" : "block" }}
      />
    </div>
  );
}
