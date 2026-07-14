import type { ReactNode } from "react";
import { ActionPrioritySelect, type ActionPriorityLabels } from "@/lib/components/ActionPrioritySelect";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

export type ActionEditorMemberOption = {
  id: string;
  label: string;
};

export type ActionEditorLabels = {
  title: string;
  notes: string;
  assignee: string;
  assigneeNone: string;
  submit: string;
  cancel: string;
  priority: ActionPriorityLabels;
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
      <label>
        {labels.assignee}
        <select name="assigneeMemberId" defaultValue={assigneeMemberId ?? ""}>
          <option value="">{labels.assigneeNone}</option>
          {members.map((member) => (
            <option value={member.id} key={member.id}>{member.label}</option>
          ))}
        </select>
      </label>
      <ActionPrioritySelect defaultValue={priority ?? 2} labels={labels.priority} />
      {children}
      <div className="actions-inline">
        <button type="submit">{labels.submit}</button>
        {cancelHref && <a className="link-button secondary" href={cancelHref}>{labels.cancel}</a>}
      </div>
    </form>
  );
}
