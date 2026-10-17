"use client";

import { useActionState } from "react";
import { markAllNotificationsReadAction } from "../settings/actions";

type Batch = Awaited<ReturnType<typeof markAllNotificationsReadAction>>;
type State = { batch: Batch | null; error: boolean };
export function MarkAllNotificationsReadButton({ workspaceId, canStart, labels }: {
  workspaceId: string;
  canStart: boolean;
  labels: { start: string; continue: string; pending: string; partial: string; complete: string; error: string };
}) {
  const [state, action, pending] = useActionState<State, FormData>(async (previous, formData) => {
    try { return { batch: await markAllNotificationsReadAction(formData), error: false }; }
    catch { return { ...previous, error: true }; }
  }, { batch: null, error: false });
  const continuation = state.batch && !state.batch.complete ? state.batch.nextCursor : null;
  if (!canStart && !state.batch && !state.error) return null;
  return (
    <div>
      {state.batch && <p role="status" className="muted">{state.batch.complete ? labels.complete : labels.partial}</p>}
      {state.error && <p role="alert">{labels.error}</p>}
      {(canStart || continuation || state.error) && (
        <form action={action}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="cursor" value={continuation ?? ""} />
          <button type="submit" className="secondary" disabled={pending}>
            {pending ? labels.pending : continuation ? labels.continue : labels.start}
          </button>
        </form>
      )}
    </div>
  );
}
