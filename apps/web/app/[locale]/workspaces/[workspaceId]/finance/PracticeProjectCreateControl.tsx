"use client";

import { useActionState, useState } from "react";
import { createPracticeProjectAction } from "./actions";

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
};

function ProjectCreateFields() {
  return (
    <>
      <div style={formGridStyle}>
        <label>
          Code
          <input name="code" required />
        </label>
        <label>
          Project
          <input name="name" required />
        </label>
        <label>
          Client
          <input name="clientName" required />
        </label>
        <label>
          Status
          <select name="status" defaultValue="ACTIVE">
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On hold</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
      </div>

      <div style={formGridStyle}>
        <label>
          PO value
          <input name="poValue" type="number" step="0.01" min="0" />
        </label>
        <label>
          Service budget
          <input name="serviceBudget" type="number" step="0.01" min="0" />
        </label>
        <label>
          Expense budget
          <input name="expenseBudget" type="number" step="0.01" min="0" />
        </label>
        <label>
          Used
          <input name="used" type="number" step="0.01" min="0" />
        </label>
      </div>

      <div style={formGridStyle}>
        <label>
          Weekly burn
          <input name="weeklyBurn" type="number" step="0.01" min="0" />
        </label>
        <label>
          Target margin %
          <input name="targetMargin" type="number" step="0.1" min="0" max="100" />
        </label>
        <label>
          Current margin %
          <input name="currentMargin" type="number" step="0.1" min="0" max="100" />
        </label>
      </div>
    </>
  );
}

export function PracticeProjectCreateControl({ workspaceId }: { workspaceId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [_version, formAction, isPending] = useActionState(async (version: number, formData: FormData) => {
    await createPracticeProjectAction(formData);
    setIsOpen(false);
    return version + 1;
  }, 0);

  return (
    <div className="fin-inline-create" style={{ marginRight: 56, position: "relative" }}>
      <button
        type="button"
        className="fin-action-btn"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        style={{ fontSize: "0.9rem", padding: "8px 12px" }}
      >
        New project
      </button>
      {isOpen ? (
        <div className="fin-dropdown" style={{ right: 0, marginTop: 8, maxWidth: "calc(100vw - 48px)", padding: 16, width: 620 }}>
          <form action={formAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <ProjectCreateFields />
            <button type="submit" disabled={isPending} style={{ width: "fit-content" }}>
              {isPending ? "Creating..." : "Create project"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
