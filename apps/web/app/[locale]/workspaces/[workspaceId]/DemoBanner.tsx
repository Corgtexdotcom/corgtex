"use client";

import "../../../demo-tour-theme.css";
import { useTranslations } from "next-intl";

export function DemoBanner() {
  const t = useTranslations("demo");

  return (
    <div className="demo-tour-banner">
      <div>
        {t("readOnlyBanner")}
      </div>
      <button 
        className="demo-tour-restart-btn"
        onClick={() => window.dispatchEvent(new CustomEvent("corgtex:restart-tour"))}
      >
        {t("restartTour")}
      </button>
    </div>
  );
}
