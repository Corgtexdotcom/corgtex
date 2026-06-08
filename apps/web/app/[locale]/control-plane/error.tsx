"use client";

import { useEffect } from "react";
import { controlPlaneButtonClass } from "./_components/control-plane-ui";

export default function ControlPlaneError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Control plane route failed.", { digest: error.digest ?? null });
  }, [error]);

  return (
    <div className="space-y-5 pb-12">
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">
          Route error
        </span>
        <h1 className="mt-2 text-xl font-semibold text-white">Control plane data did not load</h1>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-amber-100/80">
          The page returned a clear failure instead of waiting silently. Retry the route, or use Refresh live data after the connector is healthy.
        </p>
        <button type="button" onClick={reset} className={`${controlPlaneButtonClass} mt-4`}>
          Retry
        </button>
      </div>
    </div>
  );
}
