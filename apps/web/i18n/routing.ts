import {defineRouting} from 'next-intl/routing';
import {createNavigation} from 'next-intl/navigation';

const locales = ['en', 'es'] as const;
const configuredDefaultLocale = process.env.NEXT_PUBLIC_DEFAULT_LOCALE;
const defaultLocale = locales.includes(configuredDefaultLocale as (typeof locales)[number])
  ? configuredDefaultLocale as (typeof locales)[number]
  : 'en';

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'always'
});

export const {Link, usePathname, useRouter} =
  createNavigation(routing);
