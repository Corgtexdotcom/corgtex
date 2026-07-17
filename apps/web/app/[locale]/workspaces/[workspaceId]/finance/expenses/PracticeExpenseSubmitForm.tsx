"use client";

import { useMemo, useState } from "react";
import { formGridStyle } from "../components";

type ExpenseProjectOption = {
  id: string;
  code: string;
  currency: string;
  name: string;
};

export function PracticeExpenseSubmitForm({
  action,
  idempotencyKey,
  projects,
  selectedProjectId,
  workspaceId,
}: {
  action: (formData: FormData) => void | Promise<void>;
  idempotencyKey: string;
  projects: ExpenseProjectOption[];
  selectedProjectId: string;
  workspaceId: string;
}) {
  const [projectId, setProjectId] = useState(selectedProjectId);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? projects[0] ?? null,
    [projectId, projects],
  );
  const currency = selectedProject?.currency ?? "USD";

  return (
    <form action={action} className="stack nr-form-section" style={{ marginTop: 0 }}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <strong>Submit expense</strong>
      <label>
        Project
        <select
          name="projectId"
          required
          value={selectedProject?.id ?? ""}
          disabled={projects.length === 0}
          onChange={(event) => setProjectId(event.currentTarget.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.code} - {project.name}</option>
          ))}
        </select>
      </label>
      <div style={formGridStyle}>
        <label>Date<input name="spentOn" type="date" required /></label>
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Currency<input name="currency" value={currency} readOnly required /></label>
      </div>
      <div style={formGridStyle}>
        <label>Vendor<input name="vendor" /></label>
        <label>Category<input name="category" defaultValue="Client expense" required /></label>
      </div>
      <div style={formGridStyle}>
        <label>Consultant<input name="consultantName" /></label>
        <label>Email<input name="consultantEmail" type="email" /></label>
      </div>
      <label>Business purpose<input name="businessPurpose" required /></label>
      <label style={{ alignItems: "center", display: "flex", flexDirection: "row", gap: 8 }}>
        <input name="billable" type="checkbox" defaultChecked />
        Billable to client
      </label>
      <button type="submit" className="fin-action-btn" disabled={projects.length === 0}>Submit expense</button>
      {projects.length === 0 && <p className="nr-item-meta" style={{ margin: 0 }}>Create a project before submitting expenses.</p>}
    </form>
  );
}
