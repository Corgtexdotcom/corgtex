import { localizedPath, normalizeSiteLocale, type SiteLocale } from "../i18n/routing";

export type LocaleParams = {
  params: Promise<{ locale: string }>;
};

export async function localeFromParams(params: Promise<{ locale: string }>): Promise<SiteLocale> {
  const { locale } = await params;
  return normalizeSiteLocale(locale);
}

export function hrefFor(locale: SiteLocale, path: string) {
  return localizedPath(path, locale);
}
