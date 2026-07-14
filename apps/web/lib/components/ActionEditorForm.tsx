import type { ReactNode } from "react";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { WorkItemMemberSelect, type WorkItemMemberOption } from "@/lib/components/WorkItemMemberSelect";
import { WorkItemPrioritySelect } from "@/lib/components/WorkItemPrioritySelect";
import type { WorkItemPriorityLabels } from "@/lib/work-item-priority";

export type ActionEditorMemberOption = WorkItemMemberOption;

export type ActionEditorLabels = {
  title: string;
  notes: string;
  assignee: string;
  assigneeNone: string;
  submit: string;
  cancel: string;
  priorityLabel: string;
  priority: WorkItemPriorityLabels;
};

export function ActionEditorForm({
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
  action: (formData: FormData) => void | Promise<void>;
  workspaceId: string;
  actionId?: string;
  title?: string;
  bodyMd?: string | null;
  priority?: number | null;
  assigneeMemberId?: string | null;
  members: ActionEditorMemberOption[];
  labels: ActionEditorLabels;
  cancelHref?: string;
  children?: ReactNode;
}) {
  return (
    <form action={action} className="stack nr-form-section nr-action-editor-form">
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
        <button type="submit">{labels.submit}</button>
        {cancelHref && <a className="link-button secondary" href={cancelHref}>{labels.cancel}</a>}
      </div>
    </form>
  );
}
