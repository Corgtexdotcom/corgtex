import type { Metadata } from "next";
import { absoluteSiteUrl, getSiteConfig } from "./site";
import { localizedPath, normalizeSiteLocale, pathAlternates, type SiteLocale } from "../i18n/routing";

type MetadataInput = {
  description: string;
  locale?: SiteLocale | string;
  path: string;
  title: string;
};

const keywords = [
  "Corgtex",
  "AI workforce management",
  "governed AI agents",
  "AI agent visibility",
  "AI governance platform",
  "AI cost tracking",
  "AI spend attribution",
  "organizational AI",
  "enterprise AI management",
  "AI workforce platform",
  "agentic AI governance",
  "AI agent oversight",
  "service as software",
  "AI briefings",
  "AI organizational intelligence",
];

export function buildMetadata({ title, description, locale, path }: MetadataInput): Metadata {
  const { siteUrl } = getSiteConfig();
  const siteLocale = normalizeSiteLocale(locale);
  const canonicalPath = localizedPath(path, siteLocale);
  const canonical = absoluteSiteUrl(canonicalPath);
  const imageUrl = absoluteSiteUrl(siteLocale === "es" ? "/es/opengraph-image" : "/opengraph-image");
  const resolvedTitle = title === "Corgtex" ? "Corgtex" : `${title} | Corgtex`;
  const alternates = pathAlternates(path);

  return {
    metadataBase: new URL(siteUrl),
    title: resolvedTitle,
    description,
    keywords,
    alternates: {
      canonical,
      languages: {
        en: absoluteSiteUrl(alternates.en),
        es: absoluteSiteUrl(alternates.es),
        "x-default": absoluteSiteUrl(alternates["x-default"]),
      },
    },
    openGraph: {
      type: "website",
      siteName: "Corgtex",
      title: resolvedTitle,
      description,
      url: canonical,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: siteLocale === "es"
            ? "Corgtex - Dirige tu fuerza laboral de IA como un equipo responsable"
            : "Corgtex - Run Your AI Workforce Like an Accountable Team",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: resolvedTitle,
      description,
      images: [imageUrl],
    },
  };
}
