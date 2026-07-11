"use client";

import { usePathname, useRouter } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

export function LanguageSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLocale = e.target.value as "en" | "es";
    router.replace(pathname, { locale: newLocale });
  };

  const t = useTranslations("common");
  const isMobile = variant === "mobile";

  return (
    <div className={isMobile ? "language-switcher language-switcher-mobile" : "language-switcher"}>
      {isMobile && <WorkspaceUtilityIcon name="language" className="mobile-more-icon" />}
      <label htmlFor={isMobile ? "mobile-language-switcher" : "language-switcher"} className="muted">
        {t("language")}
      </label>
      <select 
        id={isMobile ? "mobile-language-switcher" : "language-switcher"}
        value={locale} 
        onChange={handleLanguageChange}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </div>
  );
}
