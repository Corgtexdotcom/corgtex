"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";

export function MarkdownEditor({
  name,
  defaultValue,
  placeholder,
  required,
}: {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [preview, setPreview] = useState(false);
  const t = useTranslations("shared.markdownEditor");

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  return (
    <div className="md-editor">
      <div className="md-editor-tabs">
        <button
          type="button"
          className={`md-editor-tab ${!preview ? "md-editor-tab-active" : ""}`}
          onClick={() => setPreview(false)}
        >
          {t("write")}
        </button>
        <button
          type="button"
          className={`md-editor-tab ${preview ? "md-editor-tab-active" : ""}`}
          onClick={() => setPreview(true)}
        >
          {t("preview")}
        </button>
      </div>
      <div className="md-editor-preview" style={{ display: preview ? "block" : "none" }}>
        {value || <span className="muted">{t("emptyPreview")}</span>}
      </div>
      <textarea
        name={name}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        required={required}
        className="md-editor-textarea"
        style={{ display: preview ? "none" : "block" }}
      />
    </div>
  );
}
