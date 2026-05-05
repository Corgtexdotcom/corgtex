"use client";

import { usePathname } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";
import { controlPlaneLocaleCookie, localizedControlPlanePath, type ControlPlaneLocale } from "./locale-path";

export function ControlPlaneLanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("common");

  return (
    <label className="muted" style={{ display: "grid", gap: 6, fontSize: "0.85rem", margin: "8px 0 0" }}>
      {t("language")}
      <select
        value={locale}
        onChange={(event) => {
          const nextLocale = event.target.value as ControlPlaneLocale;

          if (nextLocale === locale) {
            return;
          }

          document.cookie = controlPlaneLocaleCookie(nextLocale);
          window.location.assign(localizedControlPlanePath(pathname, nextLocale));
        }}
        style={{
          width: "100%",
          padding: "6px 8px",
          fontSize: "0.85rem",
          borderRadius: 6,
          border: "1px solid var(--border-color)",
          background: "var(--bg-panel)",
          color: "var(--text)",
        }}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </label>
  );
}
