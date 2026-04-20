import type { Metadata } from "next";
import { absoluteSiteUrl, getSiteConfig } from "./site";

type MetadataInput = {
  description: string;
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

export function buildMetadata({ title, description, path }: MetadataInput): Metadata {
  const { siteUrl } = getSiteConfig();
  const canonical = absoluteSiteUrl(path);
  const imageUrl = absoluteSiteUrl("/opengraph-image");
  const resolvedTitle = title === "Corgtex" ? "Corgtex" : `${title} | Corgtex`;

  return {
    metadataBase: new URL(siteUrl),
    title: resolvedTitle,
    description,
    keywords,
    alternates: {
      canonical,
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
          alt: "Corgtex — Run Your AI Workforce Like an Accountable Team",
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
