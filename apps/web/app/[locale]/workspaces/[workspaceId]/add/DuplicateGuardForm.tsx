"use client";

import React, { useActionState } from "react";
import type { ReactNode } from "react";

type DuplicateGuardCandidate = {
  entityType: string;
  entityId: string;
  title: string | null;
  excerpt: string | null;
  score: number;
  matchKind: "exact" | "likely";
  reasons: string[];
  status?: string | null;
  archivedAt?: string | null;
};

export type DuplicateGuardFormState = {
  status: "duplicate_confirmation_required";
  candidate: DuplicateGuardCandidate;
  recommendedResolution: "use_existing" | "update_existing" | "create_new";
  allowedResolutions: Array<"use_existing" | "update_existing" | "create_new">;
  submitIntent?: string | null;
} | null;

export type DuplicateGuardFormAction = (
  state: DuplicateGuardFormState,
  formData: FormData,
) => Promise<DuplicateGuardFormState>;

type DuplicateGuardFormProps = {
  action: DuplicateGuardFormAction;
  className?: string;
  encType?: string;
  children: ReactNode;
};

const RESOLUTION_LABELS = {
  use_existing: "Use existing",
  update_existing: "Update existing",
  create_new: "Create new",
};

export function DuplicateGuardConfirmationPanel({
  state,
  isPending,
}: {
  state: DuplicateGuardFormState;
  isPending: boolean;
}) {
  const confirmation = state?.status === "duplicate_confirmation_required" ? state : null;
  if (!confirmation) return null;
  const { candidate } = confirmation;

  return (
    <section className="panel stack" style={{ borderColor: "var(--color-warning-border, #d97706)" }}>
      <div>
        <strong>Possible duplicate</strong>
        <p style={{ margin: "6px 0 0", color: "var(--muted)" }}>
          {candidate.title || candidate.entityType} matches an active {candidate.entityType} with score {Math.round(candidate.score * 100)}%.
        </p>
      </div>
      {candidate.excerpt && <p style={{ margin: 0 }}>{candidate.excerpt}</p>}
      {candidate.reasons.length > 0 && (
        <p style={{ margin: 0, color: "var(--muted)" }}>{candidate.reasons.join(", ")}</p>
      )}
      {confirmation.submitIntent && <input type="hidden" name="submitIntent" value={confirmation.submitIntent} />}
      <input type="hidden" name="duplicateTargetEntityId" value={candidate.entityId} />
      <div className="actions-inline">
        {confirmation.allowedResolutions.map((resolution) => (
          <button key={resolution} type="submit" name="duplicateResolution" value={resolution} disabled={isPending}>
            {RESOLUTION_LABELS[resolution]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function DuplicateGuardForm({ action, className, encType, children }: DuplicateGuardFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className={className} encType={encType}>
      <input type="hidden" name="duplicateGuardEnabled" value="true" />
      <DuplicateGuardConfirmationPanel state={state} isPending={isPending} />
      {children}
    </form>
  );
}
