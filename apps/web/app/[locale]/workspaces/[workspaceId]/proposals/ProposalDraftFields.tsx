"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import type { WorkItemPriorityLabels } from "@/lib/work-item-priority";

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
  defaultOwnerMemberId = "",
  members,
}: {
  defaultTitle?: string;
  defaultBodyMd?: string;
  defaultPriority?: number;
  defaultOwnerMemberId?: string | null;
  members: WorkItemMemberOption[];
}) {
  const t = useTranslations("proposals");
  const tWork = useTranslations("workItems");
  const [title, setTitle] = useState(defaultTitle);
  const [bodyMd, setBodyMd] = useState(defaultBodyMd);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const showAiSummaryToggle = useMemo(
    () => proposalWordCount(title, bodyMd) > AI_SUMMARY_WORD_THRESHOLD,
    [title, bodyMd],
  );
  const priorityLabels = {
    3: tWork("priorityUrgent"),
    2: tWork("priorityImportant"),
    1: tWork("priorityMedium"),
    0: tWork("priorityLow"),
  } satisfies WorkItemPriorityLabels;

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
      <WorkItemMemberSelect
        name="ownerMemberId"
        label={t("formOwner")}
        noneLabel={t("formOwnerNone")}
        members={members}
        defaultValue={defaultOwnerMemberId}
      />
      <WorkItemPrioritySelect label={t("formPriority")} labels={priorityLabels} defaultValue={defaultPriority} />
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
