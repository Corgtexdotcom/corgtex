"use client";

import React, { useMemo, useState } from "react";
import { MultiSelectFilter, type MultiSelectFilterOption } from "@/lib/components/MultiSelectFilter";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

type AdviceAudienceType = "MEMBERS" | "CIRCLE" | "WORKSPACE";

export type AdviceRequestFormOption = {
  value: string;
  label: string;
};

export type AdviceRequestFormLabels = {
  audience: string;
  audienceMembers: string;
  audienceCircle: string;
  audienceWorkspace: string;
  people: string;
  choosePeople: string;
  circle: string;
  membersAudienceNote: string;
  circleAudienceNote: string;
  workspaceAudienceNote: string;
  message: string;
  deadline: string;
  reminder: string;
  preferredChannel: string;
  channelInApp: string;
  channelSlack: string;
  channelEmail: string;
  channelCopy: string;
  selectAll: string;
  unselectAll: string;
  selectedCount: string;
  submit: string;
};

export function AdviceRequestForm({
  action,
  hiddenFields,
  memberOptions,
  circleOptions,
  defaultAudienceType,
  defaultCircleId,
  labels,
}: {
  action: (formData: FormData) => void | Promise<void>;
  hiddenFields: Record<string, string>;
  memberOptions: AdviceRequestFormOption[];
  circleOptions: AdviceRequestFormOption[];
  defaultAudienceType: AdviceAudienceType;
  defaultCircleId?: string;
  labels: AdviceRequestFormLabels;
}) {
  const memberPickerOptions = useMemo<MultiSelectFilterOption[]>(
    () => memberOptions.map((option) => ({ value: option.value, label: option.label })),
    [memberOptions],
  );
  const initialAudienceType = useMemo(
    () => resolveAudienceType(defaultAudienceType, memberOptions, circleOptions),
    [circleOptions, defaultAudienceType, memberOptions],
  );
  const [audienceType, setAudienceType] = useState<AdviceAudienceType>(initialAudienceType);
  const circleValue = defaultCircleId && circleOptions.some((option) => option.value === defaultCircleId)
    ? defaultCircleId
    : circleOptions[0]?.value ?? "";
  const audienceOptions = [
    {
      value: "MEMBERS" as const,
      label: labels.audienceMembers,
      disabled: memberOptions.length === 0,
    },
    {
      value: "CIRCLE" as const,
      label: labels.audienceCircle,
      disabled: circleOptions.length === 0,
    },
    {
      value: "WORKSPACE" as const,
      label: labels.audienceWorkspace,
      disabled: false,
    },
  ];

  return (
    <form action={action} className="stack nr-form-section nr-advice-request-form" style={{ marginTop: 12 }}>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="audienceType" value={audienceType} />
      <fieldset className="nr-advice-audience-fieldset">
        <legend className="nr-item-meta">{labels.audience}</legend>
        <div className="nr-advice-audience-options">
          {audienceOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`nr-advice-audience-option ${audienceType === option.value ? "nr-advice-audience-option-active" : ""}`}
              disabled={option.disabled}
              aria-pressed={audienceType === option.value}
              onClick={() => setAudienceType(option.value)}
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {audienceType === "MEMBERS" && (
        <div className="nr-advice-recipient-panel">
          <MultiSelectFilter
            name="memberIds"
            label={labels.people}
            options={memberPickerOptions}
            allLabel={labels.choosePeople}
            selectAllLabel={labels.selectAll}
            unselectAllLabel={labels.unselectAll}
            selectedCountLabel={labels.selectedCount}
            collapseAllToEmpty={false}
            className="nr-advice-recipient-picker"
          />
          <p className="nr-item-meta">{labels.membersAudienceNote}</p>
        </div>
      )}

      {audienceType === "CIRCLE" && (
        <label>
          {labels.circle}
          <select name="targetCircleId" defaultValue={circleValue} required>
            {circleOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="nr-item-meta">{labels.circleAudienceNote}</span>
        </label>
      )}

      {audienceType === "WORKSPACE" && (
        <p className="nr-item-meta nr-advice-recipient-note">{labels.workspaceAudienceNote}</p>
      )}

      <label>
        {labels.message}
        <MarkdownEditor name="messageMd" rows={4} required />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <label>
          {labels.deadline}
          <input name="deadlineAt" type="datetime-local" />
        </label>
        <label>
          {labels.reminder}
          <input name="reminderAt" type="datetime-local" />
        </label>
      </div>
      <label>
        {labels.preferredChannel}
        <select name="preferredChannel" defaultValue="IN_APP">
          <option value="IN_APP">{labels.channelInApp}</option>
          <option value="SLACK">{labels.channelSlack}</option>
          <option value="EMAIL">{labels.channelEmail}</option>
          <option value="COPY">{labels.channelCopy}</option>
        </select>
      </label>
      <button type="submit" className="secondary small" style={{ alignSelf: "flex-start" }}>{labels.submit}</button>
    </form>
  );
}

function resolveAudienceType(
  requestedAudienceType: AdviceAudienceType,
  memberOptions: AdviceRequestFormOption[],
  circleOptions: AdviceRequestFormOption[],
): AdviceAudienceType {
  if (requestedAudienceType === "MEMBERS" && memberOptions.length > 0) return "MEMBERS";
  if (requestedAudienceType === "CIRCLE" && circleOptions.length > 0) return "CIRCLE";
  return "WORKSPACE";
}
