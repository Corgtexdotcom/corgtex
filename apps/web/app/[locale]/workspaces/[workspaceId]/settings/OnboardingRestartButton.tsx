"use client";

export function OnboardingRestartButton() {
  return (
    <button
      type="button"
      className="button secondary small"
      onClick={() => window.dispatchEvent(new CustomEvent("corgtex:restart-self-serve-tour"))}
    >
      Restart walkthrough
    </button>
  );
}
