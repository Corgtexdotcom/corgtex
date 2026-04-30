import { createNavigation } from "next-intl/navigation";
import { defineRouting } from "next-intl/routing";

export const locales = ["en", "es"] as const;
export type SiteLocale = (typeof locales)[number];

export const defaultLocale: SiteLocale = "en";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
});

export function normalizeSiteLocale(locale?: string | null): SiteLocale {
  return locale === "es" ? "es" : "en";
}

export function localizedPath(path: string, locale?: string | null) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizeSiteLocale(locale) === "es" ? `/es${normalizedPath}` : normalizedPath;
}

export function pathAlternates(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return {
    en: normalizedPath,
    es: `/es${normalizedPath}`,
    "x-default": normalizedPath,
  };
}

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
