"use client";

import { useActionState } from "react";
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
  priorityLabel: string;
  priority: WorkItemPriorityLabels;
};

export function DuplicateGuardActionEditorForm({
  action,
  workspaceId,
  actionId,
  title,
  bodyMd,
  priority,
  assigneeMemberId,
  members,
  labels,
  cancelHref,
  children,
}: {
  action: DuplicateGuardFormAction;
  workspaceId: string;
  actionId?: string;
  title?: string;
  bodyMd?: string | null;
  priority?: number | null;
  assigneeMemberId?: string | null;
  members: WorkItemMemberOption[];
  labels: DuplicateGuardActionEditorLabels;
  cancelHref?: string;
  children?: ReactNode;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="stack nr-form-section nr-action-editor-form">
      <input type="hidden" name="duplicateGuardEnabled" value="true" />
      <DuplicateGuardConfirmationPanel state={state} isPending={isPending} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
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
      {children}
      <div className="actions-inline">
        <button type="submit" disabled={isPending}>{labels.submit}</button>
        {cancelHref && <a className="link-button secondary" href={cancelHref}>{labels.cancel}</a>}
      </div>
    </form>
  );
}
