"use client";

import React, { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MultiSelectFilter, type MultiSelectFilterOption } from "@/lib/components/MultiSelectFilter";
import { FormMessage } from "@/lib/components/FormMessage";
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
  sending: string;
  sent: string;
  submitError: string;
  choosePeopleError: string;
  messageRequiredError: string;
  deadlineInvalidError: string;
  deadlineFutureError: string;
  reminderInvalidError: string;
  reminderFutureError: string;
  reminderBeforeDeadlineError: string;
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
  const router = useRouter();
  const memberPickerOptions = useMemo<MultiSelectFilterOption[]>(
    () => memberOptions.map((option) => ({ value: option.value, label: option.label })),
    [memberOptions],
  );
  const initialAudienceType = useMemo(
    () => resolveAudienceType(defaultAudienceType, memberOptions, circleOptions),
    [circleOptions, defaultAudienceType, memberOptions],
  );
  const [audienceType, setAudienceType] = useState<AdviceAudienceType>(initialAudienceType);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [messageMd, setMessageMd] = useState("");
  const [isPending, startTransition] = useTransition();
  const [formMessage, setFormMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
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

  const updateAudienceType = (nextAudienceType: AdviceAudienceType) => {
    setAudienceType(nextAudienceType);
    setFormMessage(null);
    if (nextAudienceType !== "MEMBERS") setSelectedMemberIds([]);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setFormMessage(null);

    if (audienceType === "MEMBERS" && selectedMemberIds.length === 0) {
      setFormMessage({ type: "error", text: labels.choosePeopleError });
      return;
    }

    if (messageMd.trim().length === 0) {
      setFormMessage({ type: "error", text: labels.messageRequiredError });
      return;
    }

    const deadline = readDateTimeField(form, "deadlineAt");
    if (deadline.error === "invalid") {
      setFormMessage({ type: "error", text: labels.deadlineInvalidError });
      return;
    }
    if (deadline.error === "future") {
      setFormMessage({ type: "error", text: labels.deadlineFutureError });
      return;
    }

    const reminder = readDateTimeField(form, "reminderAt");
    if (reminder.error === "invalid") {
      setFormMessage({ type: "error", text: labels.reminderInvalidError });
      return;
    }
    if (reminder.error === "future") {
      setFormMessage({ type: "error", text: labels.reminderFutureError });
      return;
    }
    if (deadline.date && reminder.date && reminder.date > deadline.date) {
      setFormMessage({ type: "error", text: labels.reminderBeforeDeadlineError });
      return;
    }

    const formData = new FormData(form);
    formData.set("audienceType", audienceType);
    formData.set("messageMd", messageMd);
    formData.delete("memberIds");
    formData.delete("targetCircleId");
    if (audienceType === "MEMBERS") {
      selectedMemberIds.forEach((memberId) => formData.append("memberIds", memberId));
    } else if (audienceType === "CIRCLE") {
      const targetCircleField = form.elements.namedItem("targetCircleId");
      formData.set("targetCircleId", targetCircleField instanceof HTMLSelectElement ? targetCircleField.value : "");
    }

    startTransition(async () => {
      try {
        await action(formData);
        setFormMessage({ type: "success", text: labels.sent });
        form.reset();
        setAudienceType(initialAudienceType);
        setSelectedMemberIds([]);
        setMessageMd("");
        setTimeout(() => {
          setFormMessage(null);
          router.refresh();
        }, 1500);
      } catch (error) {
        setFormMessage({ type: "error", text: getErrorMessage(error, labels.submitError) });
      }
    });
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="stack nr-form-section nr-advice-request-form" style={{ marginTop: 12 }}>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="audienceType" value={audienceType} />
      {formMessage && <FormMessage type={formMessage.type} message={formMessage.text} />}
      <fieldset className="nr-advice-audience-fieldset">
        <legend className="nr-item-meta">{labels.audience}</legend>
        <div className="nr-advice-audience-options">
          {audienceOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`nr-advice-audience-option ${audienceType === option.value ? "nr-advice-audience-option-active" : ""}`}
              disabled={option.disabled || isPending}
              aria-pressed={audienceType === option.value}
              onClick={() => updateAudienceType(option.value)}
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
            selectedValues={selectedMemberIds}
            onSelectionChange={setSelectedMemberIds}
          />
          <p className="nr-item-meta">{labels.membersAudienceNote}</p>
        </div>
      )}

      {audienceType === "CIRCLE" && (
        <label>
          {labels.circle}
          <select name="targetCircleId" defaultValue={circleValue} required disabled={isPending}>
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
        <MarkdownEditor name="messageMd" rows={4} required value={messageMd} onValueChange={setMessageMd} disabled={isPending} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <label>
          {labels.deadline}
          <input name="deadlineAt" type="datetime-local" disabled={isPending} />
        </label>
        <label>
          {labels.reminder}
          <input name="reminderAt" type="datetime-local" disabled={isPending} />
        </label>
      </div>
      <label>
        {labels.preferredChannel}
        <select name="preferredChannel" defaultValue="IN_APP" disabled={isPending}>
          <option value="IN_APP">{labels.channelInApp}</option>
          <option value="SLACK">{labels.channelSlack}</option>
          <option value="EMAIL">{labels.channelEmail}</option>
          <option value="COPY">{labels.channelCopy}</option>
        </select>
      </label>
      <button type="submit" disabled={isPending} className="secondary small" style={{ alignSelf: "flex-start" }}>
        {isPending ? labels.sending : labels.submit}
      </button>
    </form>
  );
}

function readDateTimeField(form: HTMLFormElement, name: string): { date: Date | null; error: "invalid" | "future" | null } {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement) || !field.value) return { date: null, error: null };
  if (!field.validity.valid) return { date: null, error: "invalid" };

  const date = new Date(field.value);
  if (Number.isNaN(date.getTime())) return { date: null, error: "invalid" };
  if (date.getTime() <= Date.now()) return { date, error: "future" };
  return { date, error: null };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
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
