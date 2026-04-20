"use client";

export function CommandMenuButton() {
  return (
    <button 
      className="ws-nav-link ws-logout-btn" 
      style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      onClick={() => window.dispatchEvent(new CustomEvent('corgtex:open-command-palette'))}
    >
      <span>Command Menu</span>
      <span className="cmd-kbd" style={{ background: "var(--accent-soft)", opacity: 0.8 }}>⌘K</span>
    </button>
  );
}
