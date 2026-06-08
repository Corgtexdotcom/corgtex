"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";

type Action = "approve" | "reject";

type Props = {
  trialId: string;
  companyName: string;
};

export function TrialReviewButtons({ trialId, companyName }: Props) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: Action) {
    const defaultReason = action === "approve"
      ? `Approved self-serve trial request for ${companyName}.`
      : `Rejected self-serve trial request for ${companyName}.`;
    const reason = window.prompt(
      action === "approve" ? "Approval reason" : "Rejection reason",
      defaultReason,
    )?.trim();
    if (!reason) return;

    setPendingAction(action);
    setError(null);
    try {
      const response = await fetch(`/api/control-plane/self-serve/trials/${trialId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `Unable to ${action} request.`);
      }
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      setPendingAction(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => submit("approve")}
          disabled={pendingAction !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pendingAction === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve
        </button>
        <button
          type="button"
          onClick={() => submit("reject")}
          disabled={pendingAction !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 text-[10px] font-bold uppercase tracking-wide text-rose-300 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pendingAction === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Reject
        </button>
      </div>
      {error && (
        <span className="max-w-[260px] text-right text-[9px] font-medium text-rose-400">
          {error}
        </span>
      )}
    </div>
  );
}
