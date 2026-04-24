"use client";

import { usePathname, useRouter } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";

export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLocale = e.target.value as "en" | "es";
    router.replace(pathname, { locale: newLocale });
  };

  const t = useTranslations("common");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--line)" }}>
      <label htmlFor="language-switcher" className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
        {t("language")}
      </label>
      <select 
        value={locale} 
        onChange={handleLanguageChange}
        style={{ 
          width: "100%", 
          padding: "4px 8px", 
          fontSize: "0.85rem", 
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)"
        }}
      >
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </div>
  );
}
