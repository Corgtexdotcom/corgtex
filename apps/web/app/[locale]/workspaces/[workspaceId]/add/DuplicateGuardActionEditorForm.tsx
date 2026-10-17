"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import type { WorkItemPriorityLabels } from "@/lib/work-item-priority";
import {
  DuplicateGuardConfirmationPanel,
  type DuplicateGuardFormAction,
} from "./DuplicateGuardForm";

type DuplicateGuardActionEditorLabels = {
  title: string;
  notes: string;
  assignee: string;
  assigneeNone: string;
  submit: string;
  cancel: string;
  dueDate: string;
  priorityLabel: string;
  priority: WorkItemPriorityLabels;
};

function dateInputValue(value?: Date | string | null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

export function DuplicateGuardActionEditorForm({
  action,
  workspaceId,
  actionId,
  idempotencyKey,
  title,
  bodyMd,
  priority,
  dueAt,
  assigneeMemberId,
  members,
  labels,
  cancelHref,
  footer,
  children,
}: {
  action: DuplicateGuardFormAction;
  workspaceId: string;
  actionId?: string;
  idempotencyKey: string;
  title?: string;
  bodyMd?: string | null;
  priority?: number | null;
  dueAt?: Date | string | null;
  assigneeMemberId?: string | null;
  members: WorkItemMemberOption[];
  labels: DuplicateGuardActionEditorLabels;
  cancelHref?: string;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(action, null);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const preserveDraft = (event: Event) => {
      // React resets during commit, before effects and with synthetic events disabled.
      // The DOM already reflects the response, so read its confirmation marker here.
      if (form.dataset.duplicateConfirmation !== "true") return;
      event.preventDefault();
      // MarkdownEditor also listens for resets on this form.
      event.stopImmediatePropagation();
    };
    form.addEventListener("reset", preserveDraft, true);
    return () => form.removeEventListener("reset", preserveDraft, true);
  }, []);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="stack nr-form-section nr-action-editor-form"
      data-duplicate-confirmation={state?.status === "duplicate_confirmation_required" ? "true" : undefined}
    >
      <input type="hidden" name="duplicateGuardEnabled" value="true" />
      <DuplicateGuardConfirmationPanel state={state} isPending={isPending} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {actionId && <input type="hidden" name="actionId" value={actionId} />}
      <label>
        {labels.title}
        <input name="title" defaultValue={title ?? ""} required />
      </label>
      <label>
        {labels.notes}
        <MarkdownEditor name="bodyMd" defaultValue={bodyMd ?? ""} rows={6} />
      </label>
      <WorkItemMemberSelect
        name="assigneeMemberId"
        label={labels.assignee}
        noneLabel={labels.assigneeNone}
        members={members}
        defaultValue={assigneeMemberId}
      />
      <WorkItemPrioritySelect label={labels.priorityLabel} defaultValue={priority ?? 1} labels={labels.priority} />
      <label>
        {labels.dueDate}
        <input name="dueAt" type="date" defaultValue={dateInputValue(dueAt)} />
      </label>
      {children}
      {footer ?? (
        <div className="actions-inline">
          <button type="submit" disabled={isPending}>{labels.submit}</button>
          {cancelHref && <a className="link-button secondary" href={cancelHref}>{labels.cancel}</a>}
        </div>
      )}
    </form>
  );
}
