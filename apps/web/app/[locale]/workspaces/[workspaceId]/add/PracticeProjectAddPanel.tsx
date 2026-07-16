"use client";

import React, { type ComponentProps } from "react";
import { useFormStatus } from "react-dom";

type PracticeProjectAddPanelProps = {
  action: ComponentProps<"form">["action"];
  canManagePracticeProjects: boolean;
  returnTo: string;
  workspaceId: string;
};

export function PracticeProjectFields() {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <label>Code<input name="code" required /></label>
        <label>Project<input name="name" required /></label>
        <label>Client<input name="clientName" required /></label>
        <label>
          Status
          <select name="status" defaultValue="ACTIVE">
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On hold</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <label>PO value<input name="poValue" type="number" step="0.01" min="0" /></label>
        <label>Service budget<input name="serviceBudget" type="number" step="0.01" min="0" /></label>
        <label>Expense budget<input name="expenseBudget" type="number" step="0.01" min="0" /></label>
        <label>Used<input name="used" type="number" step="0.01" min="0" /></label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <label>Weekly burn<input name="weeklyBurn" type="number" step="0.01" min="0" /></label>
        <label>Target margin %<input name="targetMargin" type="number" step="0.1" min="0" max="100" /></label>
        <label>Current margin %<input name="currentMargin" type="number" step="0.1" min="0" max="100" /></label>
      </div>
    </>
  );
}

function PracticeProjectSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create project"}
    </button>
  );
}

export function PracticeProjectAddPanel({
  action,
  canManagePracticeProjects,
  returnTo,
  workspaceId,
}: PracticeProjectAddPanelProps) {
  if (!canManagePracticeProjects) {
    return (
      <div className="stack nr-form-section">
        <p className="form-message form-message-error" style={{ margin: 0 }}>
          Only workspace admins or finance stewards can add Practice Ledger projects.
        </p>
        <div className="actions-inline"><a className="link-button secondary" href={returnTo}>Cancel</a></div>
      </div>
    );
  }

  return (
    <form action={action} className="stack nr-form-section">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <PracticeProjectFields />
      <div className="actions-inline">
        <PracticeProjectSubmitButton />
        <a className="link-button secondary" href={returnTo}>Cancel</a>
      </div>
    </form>
  );
}
