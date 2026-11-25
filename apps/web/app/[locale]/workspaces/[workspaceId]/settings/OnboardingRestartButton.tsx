"use client";

import { requestTourRestart, tourRestartButtonId } from "../onboarding-tour-restart";

export function OnboardingRestartButton({ workspaceId }: { workspaceId: string }) {
  return (
    <button
      id={tourRestartButtonId(workspaceId)}
      type="button"
      className="button secondary small"
      onClick={(event) => requestTourRestart(event.currentTarget, workspaceId)}
    >
      Restart walkthrough
    </button>
  );
}
