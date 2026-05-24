"use client";

import { usePathname } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";
import { Globe2 } from "lucide-react";
import { controlPlaneLocaleCookie, localizedControlPlanePath, type ControlPlaneLocale } from "./locale-path";

export function ControlPlaneLanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations("common");

  return (
    <label className="flex items-center gap-2 rounded-lg border border-[#202738] bg-[#141822] px-2 py-1.5 text-xs text-slate-300">
      <Globe2 className="h-4 w-4 text-slate-500" />
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
        className="bg-transparent text-xs font-semibold text-slate-200 outline-none"
        aria-label={t("language")}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </label>
  );
}
