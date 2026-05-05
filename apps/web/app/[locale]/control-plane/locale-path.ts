export type ControlPlaneLocale = "en" | "es";

export function localizedControlPlanePath(pathname: string, locale: ControlPlaneLocale) {
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const pathnameWithoutLocale = normalizedPathname.replace(/^\/(?:en|es)(?=\/|$)/, "") || "/";

  const localePrefix = locale === "en" ? "/en" : "/es";

  return pathnameWithoutLocale === "/" ? localePrefix : `${localePrefix}${pathnameWithoutLocale}`;
}
