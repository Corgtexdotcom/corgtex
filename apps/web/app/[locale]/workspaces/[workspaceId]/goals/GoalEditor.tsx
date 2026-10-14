"use client";

import React, { createContext, useContext, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemEditForm } from "@/lib/components/WorkItemEditForm";
import { editGoalFormAction } from "./actions";

type GoalEditorChoices = {
  goals: { id: string; title: string }[];
  circles: { id: string; name: string }[];
  members: { id: string; label: string }[];
};

const ChoicesContext = createContext<GoalEditorChoices | null>(null);

export function GoalEditorChoicesProvider({ choices, children }: { choices: GoalEditorChoices; children: ReactNode }) {
  return <ChoicesContext.Provider value={choices}>{children}</ChoicesContext.Provider>;
}

const CADENCES: { id: GoalCadence; label: string }[] = [
  { id: "TEN_YEAR", label: "10Y" },
  { id: "FIVE_YEAR", label: "5Y" },
  { id: "ANNUAL", label: "Annual" },
  { id: "QUARTERLY", label: "Quarterly" },
  { id: "MONTHLY", label: "Monthly" },
  { id: "WEEKLY", label: "Weekly" },
];
const LEVELS: GoalLevel[] = ["COMPANY", "CIRCLE", "PERSONAL"];

export function GoalEditor({ workspaceId, goal }: {
  workspaceId: string;
  goal: {
    id: string;
    version: number;
    title: string;
    descriptionMd: string | null;
    cadence: GoalCadence;
    level: GoalLevel;
    status: GoalStatus;
    startDate: string;
    targetDate: string;
    parentGoalId: string | null;
    circleId: string | null;
    ownerMemberId: string | null;
  };
}) {
  const t = useTranslations("goals");
  const tCommon = useTranslations("common");
  const choices = useContext(ChoicesContext);
  const [materialized, setMaterialized] = useState(false);
  if (!choices) throw new Error("GoalEditor requires shared page choices");

  // ActionMenu mounts this component only while open. Materialize on first Edit
  // expansion and retain the form when collapsed so unsaved fields survive.
  // Closing the menu unmounts it and resets fields/action state as before.
  return (
    <details onToggle={(event) => {
      if (event.currentTarget.open) setMaterialized(true);
    }}>
      <summary className="nr-hide-marker" style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: "0.88rem", fontWeight: 500 }}>
        {t("btnEdit")}
      </summary>
      {materialized && (
        <WorkItemEditForm
          action={editGoalFormAction}
          expectedVersion={goal.version}
          currentHref={`/workspaces/${workspaceId}/goals?goalId=${encodeURIComponent(goal.id)}`}
          submitLabel={goal.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save")}
          className="action-menu-form"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="goalId" value={goal.id} />
          <label>
            {t("formTitle")}
            <input name="title" defaultValue={goal.title} required />
          </label>
          <label>
            {t("formDescription")}
            <MarkdownEditor name="descriptionMd" defaultValue={goal.descriptionMd ?? ""} rows={4} />
          </label>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              {t("formCadence")}
              <select name="cadence" defaultValue={goal.cadence}>
                {CADENCES.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t("formLevel")}
              <select name="level" defaultValue={goal.level}>
                {LEVELS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              {t("formStartDate")}
              <input name="startDate" type="date" defaultValue={goal.startDate} />
            </label>
            <label style={{ flex: 1 }}>
              {t("formTargetDate")}
              <input name="targetDate" type="date" defaultValue={goal.targetDate} />
            </label>
          </div>
          <div className="actions-inline">
            <label style={{ flex: 1 }}>
              {t("formParentGoal")}
              <select name="parentGoalId" defaultValue={goal.parentGoalId ?? ""}>
                <option value="">{t("formNone")}</option>
                {choices.goals.filter((item) => item.id !== goal.id).map((item) => (
                  <option key={item.id} value={item.id}>{item.title}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t("formCircle")}
              <select name="circleId" defaultValue={goal.circleId ?? ""}>
                <option value="">{t("formNone")}</option>
                {choices.circles.map((circle) => (
                  <option key={circle.id} value={circle.id}>{circle.name}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t("formOwner")}
              <select name="ownerMemberId" defaultValue={goal.ownerMemberId ?? ""}>
                <option value="">{t("formNone")}</option>
                {choices.members.map((member) => (
                  <option key={member.id} value={member.id}>{member.label}</option>
                ))}
              </select>
            </label>
          </div>
        </WorkItemEditForm>
      )}
    </details>
  );
}
