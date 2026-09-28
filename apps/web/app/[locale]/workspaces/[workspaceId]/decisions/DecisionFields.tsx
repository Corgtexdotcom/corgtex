import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { getTranslations } from "next-intl/server";

type Option = { id: string; title: string };

export async function DecisionFields({
  workspaceId,
  proposals,
  tensions,
  decision,
}: {
  workspaceId: string;
  proposals: Option[];
  tensions: Option[];
  decision?: {
    id: string;
    version: number;
    title: string;
    bodyMd: string;
    tags: string[];
    decidedAt: Date;
    proposalId: string | null;
    tensionId: string | null;
  };
}) {
  const t = await getTranslations("decisions");
  return (
    <>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {decision && <>
        <input type="hidden" name="decisionId" value={decision.id} />
        <input type="hidden" name="expectedVersion" value={decision.version} />
      </>}
      <label>
        {t("decisionTitle")}
        <input name="title" defaultValue={decision?.title} maxLength={200} required />
      </label>
      <label>
        {t("details")}
        <MarkdownEditor name="bodyMd" rows={8} defaultValue={decision?.bodyMd} required />
      </label>
      <div className="actions-inline">
        <label style={{ flex: 1 }}>
          {t("date")}
          <input type="date" name="decidedAt" defaultValue={(decision?.decidedAt ?? new Date()).toISOString().slice(0, 10)} required />
        </label>
        <label style={{ flex: 2 }}>
          {t("tags")}
          <input name="tags" defaultValue={decision?.tags.join(", ")} placeholder={t("tagsHint")} />
        </label>
      </div>
      <div className="actions-inline">
        <label style={{ flex: 1 }}>
          {t("proposal")}
          <select name="proposalId" defaultValue={proposals.some((option) => option.id === decision?.proposalId) ? decision?.proposalId ?? "" : ""}>
            <option value="">{t("noLink")}</option>
            {proposals.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t("tension")}
          <select name="tensionId" defaultValue={tensions.some((option) => option.id === decision?.tensionId) ? decision?.tensionId ?? "" : ""}>
            <option value="">{t("noLink")}</option>
            {tensions.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        </label>
      </div>
    </>
  );
}
