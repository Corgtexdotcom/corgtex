"use client";

import "../../../demo-tour-theme.css";

export function DemoBanner() {
  return (
    <div className="demo-tour-banner">
      <div>
        This demo is read-only. You can inspect the workspace freely, but modifications are disabled.
      </div>
      <button 
        className="demo-tour-restart-btn"
        onClick={() => window.dispatchEvent(new CustomEvent("corgtex:restart-tour"))}
      >
        Restart Tour
      </button>
    </div>
  );
}
