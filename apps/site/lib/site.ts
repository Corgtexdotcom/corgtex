import { normalizeSiteLocale, type SiteLocale } from "../i18n/routing";

export type SiteConfig = {
  appUrl: string;
  bookDemoUrl: string;
  demoUrl: string;
  siteUrl: string;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getSiteConfig(): SiteConfig {
  const siteUrl = trimTrailingSlash(
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
      (process.env.NODE_ENV === "production" ? "https://corgtex.com" : "http://localhost:3008"),
  );
  const appUrl = trimTrailingSlash(
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
      (process.env.NODE_ENV === "production" ? "https://app.corgtex.com" : "http://localhost:3000"),
  );
  const demoUrl = trimTrailingSlash(process.env.NEXT_PUBLIC_DEMO_URL?.trim() || `${appUrl}/demo`);
  const bookDemoUrl = process.env.NEXT_PUBLIC_BOOK_DEMO_URL?.trim() || "https://calendar.app.google/jJd5yeSuDStVZm896";

  return {
    siteUrl,
    appUrl,
    demoUrl,
    bookDemoUrl,
  };
}

export function absoluteSiteUrl(path = "/") {
  const { siteUrl } = getSiteConfig();
  return new URL(path, `${siteUrl}/`).toString();
}

export function demoUrlForLocale(locale?: SiteLocale | string | null) {
  const { demoUrl } = getSiteConfig();
  if (normalizeSiteLocale(locale) !== "es") return demoUrl;

  if (demoUrl.endsWith("/es/demo")) return demoUrl;
  if (demoUrl.endsWith("/demo")) return `${demoUrl.slice(0, -"/demo".length)}/es/demo`;

  return `${demoUrl}/es/demo`;
}

export function signupUrlForLocale(locale?: SiteLocale | string | null) {
  const { appUrl } = getSiteConfig();
  return `${appUrl}${normalizeSiteLocale(locale) === "es" ? "/es/signup" : "/signup"}`;
}

export function demoGatePathForLocale(locale?: SiteLocale | string | null) {
  return normalizeSiteLocale(locale) === "es" ? "/es/demo" : "/demo";
}
