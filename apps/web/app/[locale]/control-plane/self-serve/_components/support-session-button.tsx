"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

type Props = {
  deploymentId?: string | null;
  workspaceId?: string | null;
  companyName: string;
};

export function SupportSessionButton({ deploymentId, workspaceId, companyName }: Props) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openSupportSession() {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch("/api/control-plane/self-serve/support-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId,
          workspaceId,
          reason: `Control-plane self-serve support inspection for ${companyName}.`,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Unable to open support session.");
      }
      const url = body?.supportSession?.url;
      if (typeof url !== "string" || !url) {
        throw new Error("Support session response did not include a URL.");
      }
      window.location.assign(url);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={!workspaceId || isPending}
        onClick={openSupportSession}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[10px] font-bold uppercase tracking-wide text-text transition-colors hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
        Support
      </button>
      {error && (
        <span className="max-w-[220px] text-right text-[9px] font-medium text-rose-400">
          {error}
        </span>
      )}
    </div>
  );
}
