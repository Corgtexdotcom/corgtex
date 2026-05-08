export type ControlPlaneLocale = "en" | "es";

export function normalizeControlPlaneLocale(locale: string | null | undefined): ControlPlaneLocale {
  return locale === "es" ? "es" : "en";
}

export function controlPlaneLocaleCookie(locale: ControlPlaneLocale) {
  return `NEXT_LOCALE=${locale}; path=/; max-age=31536000; SameSite=Lax`;
}

export function localizedControlPlanePath(pathname: string, locale: ControlPlaneLocale) {
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const pathnameWithoutLocale = normalizedPathname.replace(/^\/(?:en|es)(?=\/|$)/, "") || "/";

  const localePrefix = locale === "es" ? "/es" : "";

  return pathnameWithoutLocale === "/" ? localePrefix || "/" : `${localePrefix}${pathnameWithoutLocale}`;
}
