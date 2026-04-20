"use client";

import { updateDealAction } from "../actions";

export function DealStageSelect({
  workspaceId,
  dealId,
  currentStage,
}: {
  workspaceId: string;
  dealId: string;
  currentStage: string;
}) {
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
        <option value="LEAD">Lead</option>
        <option value="QUALIFIED">Qualified</option>
        <option value="PROPOSAL">Proposal</option>
        <option value="NEGOTIATION">Negotiate</option>
        <option value="CLOSED_WON">Won</option>
        <option value="CLOSED_LOST">Lost</option>
      </select>
    </form>
  );
}
