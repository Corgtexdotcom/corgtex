"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

const AI_SUMMARY_WORD_THRESHOLD = 120;

function markdownToProposalText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s>*+-]*\[[ xX]\]\s+/gm, "")
    .replace(/^[\s>*+-]*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~>#|{}[\]()]/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function proposalWordCount(title: string, bodyMd: string) {
  const text = markdownToProposalText(`${title}\n\n${bodyMd}`);
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function ProposalDraftFields({
  defaultTitle = "",
  defaultBodyMd = "",
  defaultPriority = 0,
}: {
  defaultTitle?: string;
  defaultBodyMd?: string;
  defaultPriority?: number;
}) {
  const t = useTranslations("proposals");
  const [title, setTitle] = useState(defaultTitle);
  const [bodyMd, setBodyMd] = useState(defaultBodyMd);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const showAiSummaryToggle = useMemo(
    () => proposalWordCount(title, bodyMd) > AI_SUMMARY_WORD_THRESHOLD,
    [title, bodyMd],
  );

  return (
    <>
      <label>
        {t("formTitle")}
        <input name="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      </label>
      <label>
        {t("formBody")}
        <MarkdownEditor
          name="bodyMd"
          value={bodyMd}
          onValueChange={setBodyMd}
          required
          placeholder={t("formBodyPlaceholder")}
        />
      </label>
      <label>
        {t("formPriority")}
        <input name="priority" type="number" min={0} defaultValue={defaultPriority} />
      </label>
      {showAiSummaryToggle && (
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "normal", cursor: "pointer" }}>
          <input type="hidden" name="includeAiSummaryRendered" value="1" />
          <input
            type="checkbox"
            name="includeAiSummary"
            checked={includeAiSummary}
            onChange={(event) => setIncludeAiSummary(event.target.checked)}
          />
          <span>{t("formIncludeAiSummary")}</span>
        </label>
      )}
    </>
  );
}
