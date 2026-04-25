"use client";

import { useTranslations } from "next-intl";

export function CommandMenuButton() {
  const t = useTranslations("common");
  return (
    <button 
      className="ws-nav-link ws-logout-btn" 
      style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      onClick={() => window.dispatchEvent(new CustomEvent('corgtex:open-command-palette'))}
    >
      <span>{t("commandMenu")}</span>
      <span className="cmd-kbd" style={{ background: "var(--accent-soft)", opacity: 0.8 }}>⌘K</span>
    </button>
  );
}
