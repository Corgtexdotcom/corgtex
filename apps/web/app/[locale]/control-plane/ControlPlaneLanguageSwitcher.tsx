"use client";

import { usePathname } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";
import { controlPlaneLocaleCookie, localizedControlPlanePath, type ControlPlaneLocale } from "./locale-path";

export function ControlPlaneLanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("common");

  return (
    <label className="flex items-center gap-2 text-xs text-text">
      <span className="sr-only">{t("language")}</span>
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
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs font-semibold text-text outline-none"
        aria-label={t("language")}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </label>
  );
}
