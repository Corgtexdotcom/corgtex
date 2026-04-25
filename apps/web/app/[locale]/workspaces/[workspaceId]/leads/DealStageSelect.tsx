"use client";

import { updateDealAction } from "../actions";
import { useTranslations } from "next-intl";

export function DealStageSelect({
  workspaceId,
  dealId,
  currentStage,
}: {
  workspaceId: string;
  dealId: string;
  currentStage: string;
}) {
  const t = useTranslations("leads");
  return (
    <form action={updateDealAction} style={{ flex: 1 }}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="dealId" value={dealId} />
      <select
        name="stage"
        defaultValue={currentStage}
        onChange={(e) => e.target.form?.requestSubmit()}
        style={{ padding: "4px", fontSize: "0.75rem" }}
      >
        <option value="LEAD">{t("stageLead")}</option>
        <option value="QUALIFIED">{t("stageQualified")}</option>
        <option value="PROPOSAL">{t("stageProposal")}</option>
        <option value="NEGOTIATION">{t("stageNegotiate")}</option>
        <option value="CLOSED_WON">{t("stageWon")}</option>
        <option value="CLOSED_LOST">{t("stageLost")}</option>
      </select>
    </form>
  );
}
