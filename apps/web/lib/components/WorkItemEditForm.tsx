"use client";

import React, { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";

export type WorkItemEditActionState = {
  status: "idle" | "success" | "conflict" | "error";
  version?: number;
};

export type WorkItemEditAction = (
  state: WorkItemEditActionState,
  formData: FormData,
) => Promise<WorkItemEditActionState>;

const initialState: WorkItemEditActionState = { status: "idle" };

export async function runWorkItemEditAction(
  action: WorkItemEditAction,
  state: WorkItemEditActionState,
  formData: FormData,
): Promise<WorkItemEditActionState> {
  try {
    const next = await action(state, formData);
    return { ...next, version: next.version ?? state.version };
  } catch {
    // A failed action request must leave the browser's unsaved fields mounted.
    return { status: "error", version: state.version };
  }
}

export function WorkItemEditFormView({
  state,
  action,
  expectedVersion,
  currentHref,
  submitLabel,
  pendingLabel,
  className,
  children,
  pending = false,
  onSubmit,
}: {
  state: WorkItemEditActionState;
  action?: string | ((formData: FormData) => void);
  expectedVersion: number;
  currentHref: string;
  submitLabel: string;
  pendingLabel: string;
  className?: string;
  children?: ReactNode;
  pending?: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useTranslations("workItems");

  return (
    <form
      action={action}
      className={className}
      aria-busy={pending}
      onSubmit={onSubmit ?? ((event) => event.stopPropagation())}
    >
      <input type="hidden" name="expectedVersion" value={state.version ?? expectedVersion} />
      {children}
      {state.status === "conflict" && (
        <div className="form-message form-message-error" role="alert">
          <strong>{t("editConflictTitle")}</strong>
          <p>{t("editConflictMessage")}</p>
          <div className="actions-inline">
            <a
              href={currentHref}
              target="_blank"
              rel="noopener noreferrer"
              className="secondary small"
              onClick={(event) => event.stopPropagation()}
            >
              {t("editConflictOpenCurrent")}
            </a>
          </div>
        </div>
      )}
      {state.status === "success" && (
        <div className="form-message form-message-success" role="status" aria-live="polite">
          {t("editSaved")} <a href={currentHref}>{t("editViewSaved")}</a>
        </div>
      )}
      {state.status === "error" && (
        <p className="form-message form-message-error" role="alert">{t("editSaveFailed")}</p>
      )}
      <button type="submit" className="secondary small" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}

export function WorkItemEditForm({
  action,
  expectedVersion,
  currentHref,
  submitLabel,
  className,
  children,
}: {
  action: WorkItemEditAction;
  expectedVersion: number;
  currentHref: string;
  submitLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations("workItems");
  const [state, formAction, pending] = useActionState(
    (previous: WorkItemEditActionState, formData: FormData) => runWorkItemEditAction(action, previous, formData),
    initialState,
  );
  const submitPreservingDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  };

  return (
    <WorkItemEditFormView
      state={state}
      action={formAction}
      expectedVersion={expectedVersion}
      currentHref={currentHref}
      submitLabel={submitLabel}
      pendingLabel={t("editSaving")}
      className={className}
      pending={pending}
      onSubmit={submitPreservingDraft}
    >
      {children}
    </WorkItemEditFormView>
  );
}
